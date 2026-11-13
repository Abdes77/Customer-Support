import type { ConversationId, Logger, MessageId, TraceId } from "@repo/core";
import {
  alerts,
  and,
  type BusinessContext,
  conversations,
  type Database,
  eq,
  escalations,
  gt,
  messages,
  or,
  sql,
  usageCounters,
} from "@repo/db";
import { startTakeover } from "@repo/handoff";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";

import type { TurnFacts, TurnGuard } from "../deps";
import { enqueueBotMessage } from "../outbound";
import {
  businessTimeZone,
  CONTACT_LIMITS,
  exceededLimit,
  type LimitKey,
  measureUsage,
  startOfDay,
} from "./usage";

/**
 * Rate limits and model-spend caps (C17), on top of what already slows a flood down: the
 * debounce (several quick messages, one turn), the turn lease (one turn at a time per
 * conversation), the email limits per thread, contact and inbox (C11), the website chat's
 * limits per address, session and business (C8) and the per-inbox send throttle.
 *
 * The guard runs last, after every other guard, inside the turn's claim transaction and
 * before the engine is called, so a stopped turn costs no model call. When a limit is
 * reached:
 *
 * - A follow-up or check-in the bot would start itself is skipped silently.
 * - A turn for what the customer wrote is still allowed when the pending messages may
 *   describe an emergency (a phrase, name or key of an emergency class, active or not), or
 *   the conversation's emergency is running or started in the last six hours: life-safety
 *   instructions never wait on a cap. At most `EMERGENCY_TURNS_PAST_LIMIT` such turns per
 *   conversation and day, so the word "gas" cannot reopen a flood. Their model calls never
 *   count against a cap (`measureUsage` leaves out traces that escalated).
 * - Otherwise the turn is skipped (the messages stay unread in the inbox). The customer gets
 *   `limits.notice_message` once per conversation and business day, written by code; the
 *   agency gets an in-app alert (once per limit, scope and day; a business-wide or agency-wide
 *   cap is also logged as an error, which reaches Sentry). With `limits.on_limit` = "handoff"
 *   the conversation is also taken over (source `rule`) and the alert recipients are told it
 *   needs a person (`handoff.attention_needed`).
 */

export const EMERGENCY_TURNS_PAST_LIMIT = 3;
const EMERGENCY_RECENT_MS = 6 * 3600 * 1000;

export interface LimitsGuardOptions {
  readonly db: Database;
  readonly logger: Logger;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whether customer text may describe one of the business's emergency classes. */
export function mayDescribeEmergency(
  texts: readonly string[],
  classes: AppSettings["emergency.classes"],
): boolean {
  const haystack = ` ${normalize(texts.join(" "))} `;
  if (haystack.trim().length === 0) return false;
  for (const item of classes) {
    const needles = [...item.phrases, item.label, item.key.replace(/[_-]+/g, " ")]
      .map(normalize)
      .filter((needle) => needle.length >= 3);
    if (needles.some((needle) => haystack.includes(` ${needle} `))) return true;
  }
  return false;
}

async function pendingTexts(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<string[]> {
  const rows = await ctx.tx
    .select({ text: messages.text })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
        gt(messages.sequence, conversations.handledThroughSeq),
      ),
    );
  return rows.map((row) => row.text ?? "").filter((text) => text.length > 0);
}

async function emergencyRunning(ctx: BusinessContext, facts: TurnFacts): Promise<boolean> {
  const since = new Date(facts.now.getTime() - EMERGENCY_RECENT_MS);
  const [row] = await ctx.tx
    .select({ id: escalations.id })
    .from(escalations)
    .where(
      and(
        eq(escalations.conversationId, facts.conversationId),
        or(eq(escalations.status, "active"), gt(escalations.startedAt, since)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Counts one emergency turn past a limit; true while the day's allowance lasts. */
async function takeEmergencyAllowance(ctx: BusinessContext, facts: TurnFacts): Promise<boolean> {
  const day = 86_400;
  const start = new Date(Math.floor(facts.now.getTime() / (day * 1000)) * day * 1000);
  const [row] = await ctx.tx
    .insert(usageCounters)
    .values({
      ...ctx.tenant,
      metric: "limit_emergency_turns",
      subject: `conversation:${facts.conversationId}`,
      windowStart: start,
      windowSeconds: day,
      value: 1,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.businessId,
        usageCounters.metric,
        usageCounters.subject,
        usageCounters.windowStart,
        usageCounters.windowSeconds,
      ],
      set: { value: sql`${usageCounters.value} + 1`, updatedAt: facts.now },
    })
    .returning({ value: usageCounters.value });
  return (row?.value ?? 1) <= EMERGENCY_TURNS_PAST_LIMIT;
}

/** Writes the in-app alert once per limit, scope and day; true when it is new. */
async function raiseLimitAlert(
  ctx: BusinessContext,
  facts: TurnFacts,
  limit: LimitKey,
  day: string,
): Promise<boolean> {
  const contactLimit = CONTACT_LIMITS.has(limit);
  const scope = contactLimit
    ? `contact:${facts.contactId}`
    : limit.startsWith("agency")
      ? "agency"
      : "business";
  const rows = await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: contactLimit ? facts.conversationId : null,
      kind: "limit_reached",
      severity: contactLimit ? "warning" : "critical",
      channel: "in_app",
      recipient: "agency",
      subject: contactLimit
        ? "A customer reached a rate limit or spend cap; the bot stopped answering them for today."
        : "The business reached a rate limit or spend cap; the bot stopped answering until the limit resets.",
      payload: { limit, scope, day, conversationId: facts.conversationId },
      dedupeKey: `limit_reached:${limit}:${scope}:${day}`,
    })
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  return rows.length > 0;
}

/** The notice to the customer, once per conversation and business day. */
async function queueNotice(
  ctx: BusinessContext,
  facts: TurnFacts,
  text: string,
  dayStart: Date,
): Promise<{ readonly sequence: number | null; readonly events: readonly AnyJobEvent[] }> {
  if (text.trim().length === 0) return { sequence: null, events: [] };
  const [earlier] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, facts.conversationId),
        eq(messages.direction, "outbound"),
        sql`${messages.payload} ->> 'purpose' = 'limit_notice'`,
        sql`${messages.createdAt} >= ${dayStart.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  if (earlier !== undefined) return { sequence: null, events: [] };
  const queued = await enqueueBotMessage(ctx, {
    conversationId: facts.conversationId,
    text,
    traceId: facts.traceId ?? crypto.randomUUID(),
    purpose: "limit_notice",
  });
  if (queued === null) return { sequence: null, events: [] };
  const [row] = await ctx.tx
    .select({ sequence: messages.sequence })
    .from(messages)
    .where(eq(messages.id, queued.messageId as MessageId))
    .limit(1);
  return { sequence: row?.sequence ?? null, events: queued.events };
}

export function createLimitsGuard(options: LimitsGuardOptions): TurnGuard {
  const log = options.logger.child({ component: "limits" });
  return {
    name: "limits",
    async check(ctx, facts) {
      const values = facts.settings.values;
      const timeZone = await businessTimeZone(ctx);
      const usage = await measureUsage(ctx, {
        contactId: facts.contactId,
        conversationId: facts.conversationId,
        now: facts.now,
        timeZone,
        agencySpend:
          values["limits.agency_daily_spend_usd"] === null
            ? null
            : (since) => options.db.directory.agencyModelSpendSince(ctx.tenant.agencyId, since),
      });
      const limit = exceededLimit(usage, values, facts.trigger);
      if (limit === null) return null;

      const fields = {
        traceId: facts.traceId,
        businessId: ctx.tenant.businessId,
        conversationId: facts.conversationId,
        limit,
        trigger: facts.trigger,
      };
      // Nothing the bot would start itself goes out past a limit.
      if (facts.trigger !== "inbound_message") return limit;

      const emergency =
        mayDescribeEmergency(
          await pendingTexts(ctx, facts.conversationId),
          values["emergency.classes"],
        ) || (await emergencyRunning(ctx, facts));
      if (emergency && (await takeEmergencyAllowance(ctx, facts))) {
        log.warn("limits.emergency_exempt", fields);
        return null;
      }

      const dayStart = startOfDay(facts.now, timeZone);
      const day = facts.now.toISOString().slice(0, 10);
      const fresh = await raiseLimitAlert(ctx, facts, limit, day);
      if (fresh && !CONTACT_LIMITS.has(limit)) {
        // A whole business (or agency) has stopped: loud, once a day (Sentry gets errors).
        log.error("limits.cap_reached", fields);
      } else {
        log.warn("limits.reached", fields);
      }
      const notice = await queueNotice(ctx, facts, values["limits.notice_message"], dayStart);
      const events: AnyJobEvent[] = [...notice.events];
      if (values["limits.on_limit"] === "handoff") {
        const takeover = await startTakeover(ctx, {
          conversationId: facts.conversationId,
          source: "rule",
          userId: null,
          reason: `limit:${limit}`,
          traceId: facts.traceId ?? crypto.randomUUID(),
          now: facts.now,
          exemptThroughSeq: notice.sequence,
        });
        if (takeover !== null) events.push(takeover.event);
        events.push(
          jobEvent("handoff.attention_needed", `attention-limit-${facts.conversationId}-${day}`, {
            traceId: (facts.traceId ?? crypto.randomUUID()) as TraceId,
            agencyId: ctx.tenant.agencyId,
            businessId: ctx.tenant.businessId,
            conversationId: facts.conversationId,
            reason: "limit_reached",
            day,
          }),
        );
      }
      facts.emit?.(events);
      return limit;
    },
  };
}
