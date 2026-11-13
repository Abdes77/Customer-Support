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
  CONVERSATION_LIMITS,
  exceededLimit,
  type LimitKey,
  measureUsage,
} from "./usage";

/**
 * Rate limits and model-spend caps (C17), on top of what already slows a flood down: the
 * debounce (several quick messages, one turn), the turn lease (one turn at a time per
 * conversation), the email limits per thread, contact and inbox (C11), the website chat's
 * limits per address, session and business (C8) and the per-inbox send throttle.
 *
 * The guard runs last, after every other guard, inside the turn's claim transaction and
 * before the engine is called, so a stopped turn costs no model call. When a limit is
 * reached (the `limits.*` settings, and the longest conversation,
 * `conversation.max_bot_replies`):
 *
 * - A follow-up or check-in the bot would start itself is skipped silently.
 * - A turn for what the customer wrote is still allowed when the pending messages may
 *   describe an emergency (`mayDescribeEmergency`: a danger word, a phrase, name or key of an
 *   emergency class, or two telling words of one of its phrases), or the conversation's
 *   emergency is running or started in the last six hours: life-safety instructions never
 *   wait on a cap. At most `EMERGENCY_TURNS_PAST_LIMIT` such turns per conversation and day,
 *   and `EMERGENCY_TURNS_PAST_LIMIT_PER_BUSINESS` per business and day, so the word "gas"
 *   reopens neither one customer's flood nor, written in many new conversations, a business's
 *   cap. Their model calls never count against a cap when the turn escalated
 *   (`measureUsage` leaves out traces that escalated).
 * - Otherwise the turn is skipped (the messages stay unread in the inbox). The customer gets
 *   the notice (`limitNoticeText`: `limits.notice_message`, always with the sentence about
 *   calling 911) at most once per conversation and hour, written by code; the agency gets an
 *   in-app alert (once per limit, scope and day; a business-wide or agency-wide cap is also
 *   logged as an error, which reaches Sentry). With `limits.on_limit` = "handoff", and always
 *   for the longest conversation (its setting promises it), the conversation is also taken
 *   over (source `rule`) and the alert recipients are told it needs a person
 *   (`handoff.attention_needed`).
 */

/** The guard's name: the claim leaves the longest conversation to it when it is registered. */
export const LIMITS_GUARD_NAME = "limits";

export const EMERGENCY_TURNS_PAST_LIMIT = 3;
/**
 * Turns past a limit for messages that may describe an emergency, per business and day,
 * all conversations together. Without it the per-conversation allowance is no bound at all:
 * a flood that opens a new conversation for every message and writes "fire" in each would get
 * three model turns per conversation past every cap. A code constant, not a setting: it
 * protects the agency's budget from one business's flood, and the business cannot raise it.
 */
export const EMERGENCY_TURNS_PAST_LIMIT_PER_BUSINESS = 100;
const EMERGENCY_RECENT_MS = 6 * 3600 * 1000;

/** The one sentence every notice carries, whatever the business wrote (or left empty). */
export const LIFE_SAFETY_SENTENCE = "If anyone is in danger right now, call 911.";

/**
 * What a customer past a limit is told: the business's `limits.notice_message`, and always
 * the instruction to call 911. A turn the guard stops may be an emergency no rule of code
 * recognized, so that sentence is not the business's to remove: a notice without "911" gets
 * it appended, and an empty notice is that sentence alone.
 */
export function limitNoticeText(configured: string): string {
  const text = configured.trim();
  if (/(^|\D)911(\D|$)/.test(text)) return text;
  return text.length === 0 ? LIFE_SAFETY_SENTENCE : `${text} ${LIFE_SAFETY_SENTENCE}`;
}

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

/**
 * Words that say people or a home may be in danger, whatever the business's own phrase
 * lists hold. Deliberately generous: a false match costs one of a few allowed model turns,
 * a miss leaves a customer in an emergency with a notice instead of an answer.
 */
const DANGER_WORDS: ReadonlySet<string> = new Set([
  "911",
  "emergency",
  "emergencies",
  "urgent",
  "urgently",
  "danger",
  "dangerous",
  "unsafe",
  "fire",
  "flame",
  "flames",
  "smoke",
  "smoking",
  "smoky",
  "smoldering",
  "burning",
  "gas",
  "monoxide",
  "explosion",
  "exploded",
  "exploding",
  "spark",
  "sparks",
  "sparking",
  "sparked",
  "shock",
  "shocked",
  "electrocuted",
  "electrocution",
  "flood",
  "flooding",
  "flooded",
  "sewage",
  "collapse",
  "collapsed",
  "collapsing",
  "hurt",
  "injured",
  "injury",
  "bleeding",
  "unconscious",
  "fainted",
  "dizzy",
  "trapped",
  "breathe",
  "breathing",
  "ambulance",
]);

/** Words of a phrase that say nothing by themselves ("water coming through the ceiling"). */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "are",
  "was",
  "has",
  "have",
  "that",
  "this",
  "with",
  "from",
  "near",
  "over",
  "out",
  "off",
  "not",
  "won",
  "got",
  "its",
  "our",
  "for",
  "going",
  "coming",
  "through",
  "right",
  "now",
  "very",
  "there",
  "something",
  "everyone",
  "everywhere",
  "feels",
  "stopped",
  "turn",
]);

/**
 * Whether customer text may describe an emergency: a danger word; a phrase, name or key of
 * one of the business's emergency classes; or two telling words of one of those phrases in
 * any order ("I think I smell something like gas", "a tree came down on our house"). The
 * engine recognizes emergencies by meaning; this is the rule of code that decides whether a
 * message past a limit still reaches the engine, so it errs on the side of "maybe".
 */
export function mayDescribeEmergency(
  texts: readonly string[],
  classes: AppSettings["emergency.classes"],
): boolean {
  const normalized = normalize(texts.join(" "));
  if (normalized.length === 0) return false;
  const words = new Set(normalized.split(" "));
  for (const word of words) {
    if (DANGER_WORDS.has(word)) return true;
  }
  const haystack = ` ${normalized} `;
  for (const item of classes) {
    const needles = [...item.phrases, item.label, item.key.replace(/[_-]+/g, " ")]
      .map(normalize)
      .filter((needle) => needle.length >= 3);
    for (const needle of needles) {
      if (haystack.includes(` ${needle} `)) return true;
      const telling = needle
        .split(" ")
        .filter((word) => word.length >= 3 && !FILLER_WORDS.has(word));
      if (telling.length >= 2 && telling.filter((word) => words.has(word)).length >= 2) return true;
    }
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

/** Adds one to a day's counter (UTC day of the turn's clock) and returns its new value. */
async function countToday(
  ctx: BusinessContext,
  facts: TurnFacts,
  metric: string,
  subject: string,
  windowSeconds = 86_400,
): Promise<number> {
  const start = new Date(
    Math.floor(facts.now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );
  const [row] = await ctx.tx
    .insert(usageCounters)
    .values({ ...ctx.tenant, metric, subject, windowStart: start, windowSeconds, value: 1 })
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
  return row?.value ?? 1;
}

/**
 * Counts one emergency turn past a limit, for the conversation and for the business:
 * "granted" while both of the day's allowances last.
 */
async function takeEmergencyAllowance(
  ctx: BusinessContext,
  facts: TurnFacts,
): Promise<"granted" | "conversation_exhausted" | "business_exhausted"> {
  const own = await countToday(
    ctx,
    facts,
    "limit_emergency_turns",
    `conversation:${facts.conversationId}`,
  );
  if (own > EMERGENCY_TURNS_PAST_LIMIT) return "conversation_exhausted";
  const all = await countToday(ctx, facts, "limit_emergency_turns", "business");
  return all > EMERGENCY_TURNS_PAST_LIMIT_PER_BUSINESS ? "business_exhausted" : "granted";
}

/** Writes the in-app alert once per limit, scope and day; true when it is new. */
async function raiseLimitAlert(
  ctx: BusinessContext,
  facts: TurnFacts,
  limit: LimitKey,
  day: string,
): Promise<boolean> {
  const conversationLimit = CONVERSATION_LIMITS.has(limit);
  const contactLimit = CONTACT_LIMITS.has(limit);
  const scope = conversationLimit
    ? `conversation:${facts.conversationId}`
    : contactLimit
      ? `contact:${facts.contactId}`
      : limit.startsWith("agency")
        ? "agency"
        : "business";
  const rows = await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: conversationLimit || contactLimit ? facts.conversationId : null,
      kind: "limit_reached",
      severity: conversationLimit || contactLimit ? "warning" : "critical",
      channel: "in_app",
      recipient: "agency",
      subject: conversationLimit
        ? "A conversation reached its longest length; the bot stopped and handed it to the team."
        : contactLimit
          ? "A customer reached a rate limit or spend cap; the bot stopped answering them for today."
          : "The business reached a rate limit or spend cap; the bot stopped answering until the limit resets.",
      payload: { limit, scope, day, conversationId: facts.conversationId },
      dedupeKey: `limit_reached:${limit}:${scope}:${day}`,
    })
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  return rows.length > 0;
}

/**
 * The day's allowance of emergency turns past a limit is used up for the whole business:
 * from here on a message that may describe an emergency gets the notice, not the bot. One
 * critical alert a day; true when it is new.
 */
async function raiseAllowanceAlert(
  ctx: BusinessContext,
  facts: TurnFacts,
  day: string,
): Promise<boolean> {
  const rows = await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: facts.conversationId,
      kind: "limit_emergency_allowance",
      severity: "critical",
      channel: "in_app",
      recipient: "agency",
      subject:
        "A limit is stopping the bot and today's allowance for possible emergencies is used up: customers who may be describing an emergency now get only the notice to call 911. Read the inbox.",
      payload: { day, conversationId: facts.conversationId },
      dedupeKey: `limit_emergency_allowance:${day}`,
    })
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  return rows.length > 0;
}

/**
 * The notice to the customer, at most once per conversation and hour of the turn's clock.
 * Before the audit of C17 it was once a day, so a customer who wrote again later that day,
 * perhaps about something worse, got no answer at all.
 */
async function queueNotice(
  ctx: BusinessContext,
  facts: TurnFacts,
  configured: string,
): Promise<{ readonly sequence: number | null; readonly events: readonly AnyJobEvent[] }> {
  const sent = await countToday(
    ctx,
    facts,
    "limit_notice",
    `conversation:${facts.conversationId}`,
    3600,
  );
  if (sent > 1) return { sequence: null, events: [] };
  const queued = await enqueueBotMessage(ctx, {
    conversationId: facts.conversationId,
    text: limitNoticeText(configured),
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
    name: LIMITS_GUARD_NAME,
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

      const day = facts.now.toISOString().slice(0, 10);
      const emergency =
        mayDescribeEmergency(
          await pendingTexts(ctx, facts.conversationId),
          values["emergency.classes"],
        ) || (await emergencyRunning(ctx, facts));
      if (emergency) {
        const allowance = await takeEmergencyAllowance(ctx, facts);
        if (allowance === "granted") {
          log.warn("limits.emergency_exempt", fields);
          return null;
        }
        if (allowance === "business_exhausted" && (await raiseAllowanceAlert(ctx, facts, day))) {
          // Possible emergencies now get the notice only: loud, once a day.
          log.error("limits.emergency_allowance_exhausted", fields);
        }
      }

      const fresh = await raiseLimitAlert(ctx, facts, limit, day);
      if (fresh && !CONTACT_LIMITS.has(limit) && !CONVERSATION_LIMITS.has(limit)) {
        // A whole business (or agency) has stopped: loud, once a day (Sentry gets errors).
        log.error("limits.cap_reached", fields);
      } else {
        log.warn("limits.reached", fields);
      }
      const notice = await queueNotice(ctx, facts, values["limits.notice_message"]);
      const events: AnyJobEvent[] = [...notice.events];
      // The longest conversation "hands it to a person" (its setting says so), whatever
      // `limits.on_limit` is.
      if (values["limits.on_limit"] === "handoff" || CONVERSATION_LIMITS.has(limit)) {
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
