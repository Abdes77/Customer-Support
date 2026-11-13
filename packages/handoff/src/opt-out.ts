import type {
  ChannelId,
  ContactId,
  ConversationId,
  TraceId,
  TurnRestriction,
  UserId,
} from "@repo/core";
import {
  alerts,
  and,
  type BusinessContext,
  contacts,
  conversations,
  eq,
  escalations,
  gt,
  inArray,
  messages,
  ne,
  or,
  recordSystemAudit,
  scheduledJobs,
  sql,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";

import type { OutboundMessages } from "./deps";

/*
 * Opt-out (a compliance matter): a message that consists of an opt-out word opts the contact
 * out on every channel of the business. It is recorded with its time and source on the contact
 * and in the audit log; follow-ups already planned are cancelled, and anything the bot starts
 * itself (nudges, reminders, check-ins) is withheld from then on. The customer gets one
 * confirmation. An opt-in word lifts it again.
 *
 * What the customer writes after opting out (`follow_up.opt_out_scope`):
 * - "all_automated" (default): the bot answers only an emergency; anything else gets no answer,
 *   and the team is alerted that the customer wrote (`surfaceOptedOutMessage`);
 * - "proactive_only": the bot answers as usual.
 * An emergency is never silenced: its safety instructions go out and the escalation runs as for
 * any customer, and the conversation stays answered while that emergency is recent.
 */

/** An emergency this recent in the conversation lifts the opt-out's silence for replies. */
export const RECENT_EMERGENCY_MS = 6 * 3_600_000;

/** Longest message that can still "consist of" a keyword (settings cap words at 40). */
const MAX_KEYWORD_MESSAGE = 60;

export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Courtesy words around a keyword that do not change what the message asks. */
const LEADING_FILLER = /^(?:please|pls|plz|ok|okay)[\s,]+/;
const COURTESY_TAIL = /(?:[\s,]+(?:please|pls|plz|now|thanks|thank you|thx|asap))+$/;
const TRAILING_FILLER =
  /(?:[\s,]+(?:please|pls|plz|now|thanks|thank you|thx|asap|me|(?:(?:texting|messaging|contacting|emailing|calling|bothering|sending)(?: me)?(?: (?:messages|texts|emails))?)))+$/;

/**
 * The keyword a message consists of, or null. "STOP", "Stop.", " stop! " all match "stop", and
 * so do the short requests around it that mean the same ("Please stop", "STOP texting me",
 * "unsubscribe me please"). A keyword inside any other sentence ("can you stop by
 * tomorrow?", "stop the leak") is not an opt-out: the bot answers it, and the person reading
 * the conversation can still opt the customer out.
 */
export function matchKeyword(text: string | null, keywords: readonly string[]): string | null {
  if (text === null || text.length === 0 || text.length > MAX_KEYWORD_MESSAGE) return null;
  const message = normalizeKeyword(text);
  if (message.length === 0) return null;
  const words = keywords.map((keyword) => [keyword, normalizeKeyword(keyword)] as const);
  const exact = words.find(([, word]) => word === message);
  if (exact !== undefined) return exact[0];
  const lead = message.replace(LEADING_FILLER, "");
  const cores = [lead.replace(COURTESY_TAIL, ""), lead.replace(TRAILING_FILLER, "")]
    .map(normalizeKeyword)
    .filter((core) => core.length > 0 && core !== message);
  for (const core of cores) {
    const found = words.find(([, word]) => word === core);
    if (found !== undefined) return found[0];
  }
  return null;
}

export interface OptOutRecord {
  readonly at: string;
  readonly source: "keyword" | "admin_panel";
  readonly channel: ChannelId | null;
  readonly conversationId: ConversationId | null;
  readonly messageId: string | null;
  readonly keyword: string | null;
  readonly userId: UserId | null;
}

/** Cancels the follow-ups planned for a contact's conversations (`scheduled_jobs` rows). */
export async function cancelFollowUpsOfContact(
  ctx: BusinessContext,
  contactId: ContactId,
  reason: string,
  now: Date,
): Promise<number> {
  const rows = await ctx.tx
    .update(scheduledJobs)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: reason })
    .where(
      and(
        eq(scheduledJobs.kind, "follow_up"),
        inArray(scheduledJobs.status, ["scheduled", "running"]),
        inArray(
          scheduledJobs.conversationId,
          ctx.tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.contactId, contactId)),
        ),
      ),
    )
    .returning({ id: scheduledJobs.id });
  return rows.length;
}

/**
 * Records an opt-out once: a contact already opted out keeps its first record. Returns true
 * when this call opted the contact out.
 */
export async function recordOptOut(
  ctx: BusinessContext,
  contactId: ContactId,
  record: OptOutRecord,
  now: Date,
): Promise<boolean> {
  const metadata = JSON.stringify({ optOut: record });
  const [row] = await ctx.tx
    .update(contacts)
    .set({
      optedOutAt: now,
      metadata: sql`${contacts.metadata} || ${metadata}::jsonb`,
    })
    .where(and(eq(contacts.id, contactId), sql`${contacts.optedOutAt} is null`))
    .returning({ id: contacts.id });
  if (row === undefined) return false;
  await cancelFollowUpsOfContact(ctx, contactId, "opted_out", now);
  await recordSystemAudit(
    ctx,
    record.userId === null
      ? { type: "system", label: "handoff:opt_out" }
      : { type: "user", userId: record.userId },
    {
      action: "contact.opt_out",
      targetType: "contact",
      targetId: contactId,
      summary:
        record.source === "keyword"
          ? `The customer opted out by keyword on ${record.channel ?? "a channel"}.`
          : "Opted out in the admin panel.",
      after: record,
    },
  );
  return true;
}

/** Lifts an opt-out. Returns true when the contact had opted out. */
export async function liftOptOut(
  ctx: BusinessContext,
  contactId: ContactId,
  record: Omit<OptOutRecord, "keyword"> & { readonly keyword: string | null },
  now: Date,
): Promise<boolean> {
  const metadata = JSON.stringify({ optIn: { ...record, at: now.toISOString() } });
  const [row] = await ctx.tx
    .update(contacts)
    .set({
      optedOutAt: null,
      metadata: sql`${contacts.metadata} || ${metadata}::jsonb`,
    })
    .where(and(eq(contacts.id, contactId), sql`${contacts.optedOutAt} is not null`))
    .returning({ id: contacts.id });
  if (row === undefined) return false;
  await recordSystemAudit(
    ctx,
    record.userId === null
      ? { type: "system", label: "handoff:opt_in" }
      : { type: "user", userId: record.userId },
    {
      action: "contact.opt_in",
      targetType: "contact",
      targetId: contactId,
      summary:
        record.source === "keyword"
          ? `The customer opted back in by keyword on ${record.channel ?? "a channel"}.`
          : "Opt-out lifted in the admin panel.",
      after: { ...record, at: now.toISOString() },
    },
  );
  return true;
}

/**
 * What a customer message means for opt-out: an opt-out word records the opt-out and queues
 * the one confirmation; an opt-in word from an opted-out contact lifts it. Returns the events
 * to emit (the confirmation's send).
 */
export async function applyKeywords(
  ctx: BusinessContext,
  input: {
    readonly contactId: ContactId;
    readonly conversationId: ConversationId;
    readonly channel: ChannelId;
    readonly messageId: string;
    readonly text: string | null;
    readonly traceId: string;
    readonly values: AppSettings;
    readonly now: Date;
    readonly outbound: OutboundMessages | null;
  },
): Promise<{ readonly change: "opted_out" | "opted_in" | null; readonly events: AnyJobEvent[] }> {
  const { values, now } = input;
  const optOut = matchKeyword(input.text, values["follow_up.opt_out_keywords"]);
  if (optOut !== null) {
    const recorded = await recordOptOut(
      ctx,
      input.contactId,
      {
        at: now.toISOString(),
        source: "keyword",
        channel: input.channel,
        conversationId: input.conversationId,
        messageId: input.messageId,
        keyword: optOut,
        userId: null,
      },
      now,
    );
    if (!recorded || input.outbound === null)
      return { change: recorded ? "opted_out" : null, events: [] };
    const queued = await input.outbound.enqueueBot(ctx, {
      conversationId: input.conversationId,
      text: values["follow_up.opt_out_confirmation"],
      traceId: input.traceId,
      purpose: "opt_out_confirmation",
    });
    return { change: "opted_out", events: queued === null ? [] : [...queued.events] };
  }
  const optIn = matchKeyword(input.text, values["follow_up.opt_in_keywords"]);
  if (optIn !== null) {
    const lifted = await liftOptOut(
      ctx,
      input.contactId,
      {
        at: now.toISOString(),
        source: "keyword",
        channel: input.channel,
        conversationId: input.conversationId,
        messageId: input.messageId,
        keyword: optIn,
        userId: null,
      },
      now,
    );
    return { change: lifted ? "opted_in" : null, events: [] };
  }
  return { change: null, events: [] };
}

/** Whether the conversation has an emergency running, or one that started recently. */
export async function hasRecentEmergency(
  ctx: BusinessContext,
  conversationId: ConversationId,
  now: Date,
): Promise<boolean> {
  const [recent] = await ctx.tx
    .select({ id: escalations.id })
    .from(escalations)
    .where(
      and(
        eq(escalations.conversationId, conversationId),
        or(
          eq(escalations.status, "active"),
          gt(escalations.startedAt, new Date(now.getTime() - RECENT_EMERGENCY_MS)),
        ),
      ),
    )
    .limit(1);
  return recent !== undefined;
}

/** The customer messages a turn has not dealt with yet (text and kind), oldest first. */
export async function pendingCustomerMessages(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<{ readonly id: string; readonly text: string | null; readonly kind: string }[]> {
  const [conversation] = await ctx.tx
    .select({ handled: conversations.handledThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return ctx.tx
    .select({ id: messages.id, text: messages.text, kind: messages.kind })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
        ne(messages.kind, "reaction"),
        gt(messages.sequence, conversation?.handled ?? 0),
      ),
    )
    .orderBy(messages.sequence)
    .limit(50);
}

/**
 * What a turn for the customer's own messages may send when the customer opted out:
 * "emergency_only" when `follow_up.opt_out_scope` is "all_automated", or when the messages
 * themselves contain the opt-out word (they just said stop); nothing limits it while an
 * emergency in the conversation is running or recent, nor for a customer who did not opt out.
 */
export async function optOutRestriction(
  ctx: BusinessContext,
  input: {
    readonly contactId: ContactId;
    readonly conversationId: ConversationId;
    readonly values: AppSettings;
    readonly now: Date;
  },
): Promise<TurnRestriction | null> {
  const [contact] = await ctx.tx
    .select({ optedOutAt: contacts.optedOutAt })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (contact?.optedOutAt == null) return null;
  if (await hasRecentEmergency(ctx, input.conversationId, input.now)) return null;
  const restricted: TurnRestriction = { kind: "emergency_only", reason: "opted_out" };
  if (input.values["follow_up.opt_out_scope"] === "all_automated") return restricted;
  const keywords = input.values["follow_up.opt_out_keywords"];
  const pending = await pendingCustomerMessages(ctx, input.conversationId);
  return pending.some((row) => matchKeyword(row.text, keywords) !== null) ? restricted : null;
}

/** The text the in-app alert and the recipients' alerts put first. */
export const OPTED_OUT_NOTICE =
  "The customer opted out of automated messages and wrote again; the bot did not answer.";

/** The in-app and alert notice when a rate limit or spend cap stopped the bot (C17). */
export const LIMIT_REACHED_NOTICE =
  "A rate limit or spend cap stopped the bot in this conversation. Please answer the customer yourself.";

/**
 * A customer who opted out wrote and the bot stayed silent: the business must still see it.
 * The message is unread in the inbox (ingest counts it); this adds a warning in the admin
 * panel and asks `handoff-alert-attention` to alert the recipients of "handoff" alerts. Both
 * are once per conversation and day (UTC), however often the customer writes.
 */
export async function surfaceOptedOutMessage(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly traceId: string;
    readonly now: Date;
  },
): Promise<AnyJobEvent[]> {
  const day = input.now.toISOString().slice(0, 10);
  await ctx.tx
    .insert(alerts)
    .values({
      ...ctx.tenant,
      conversationId: input.conversationId,
      kind: "opted_out_customer_wrote",
      severity: "warning",
      channel: "in_app",
      recipient: "agency",
      subject: OPTED_OUT_NOTICE,
      payload: { conversationId: input.conversationId, day },
      dedupeKey: `opted_out_customer_wrote:${input.conversationId}:${day}`,
    })
    .onConflictDoNothing();
  return [
    jobEvent("handoff.attention_needed", `attention-opted-out-${input.conversationId}-${day}`, {
      traceId: input.traceId as TraceId,
      agencyId: ctx.tenant.agencyId,
      businessId: ctx.tenant.businessId,
      conversationId: input.conversationId,
      reason: "opted_out_customer_wrote",
      day,
    }),
  ];
}
