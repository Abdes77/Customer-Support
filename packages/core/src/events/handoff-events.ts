import { z } from "zod";

import { AgencyId, BusinessId, ConversationId, TraceId } from "../ids";

/**
 * Handoff events (owner: C13). Ids only, at-least-once delivery, consumers are idempotent:
 * every job reads the row it names and acts on its stored state.
 */

/**
 * An emergency escalation was recorded (an `escalate_emergency` action or a `lead.emergency`
 * event). Starts `handoff-emergency-chain` for the escalation; the event id is derived from
 * the escalation, so starting it twice runs one chain (the sweeper's resume adds a suffix).
 */
export const EscalationStartedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  escalationId: z.uuid(),
});
export type EscalationStartedEvent = z.infer<typeof EscalationStartedEvent>;

/**
 * A follow-up was planned for a conversation (a nudge after the bot's reply, or a check-in the
 * bot scheduled). `handoff-follow-up` sleeps until it is due and checks again that it is still
 * wanted; a newer plan, a reply, an opt-out or a booking cancels it.
 */
export const FollowUpPlannedEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  conversationId: ConversationId,
  followUpId: z.uuid(),
});
export type FollowUpPlannedEvent = z.infer<typeof FollowUpPlannedEvent>;

/**
 * Why a conversation needs a person although nobody handed it over: an opted-out customer
 * wrote (C13), or a rate limit or spend cap stopped the bot (C17).
 */
export const ATTENTION_REASONS = ["opted_out_customer_wrote", "limit_reached"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * A conversation needs a person's attention: a customer who opted out of automated messages
 * wrote again and the bot, by the business's settings, did not answer. `handoff-alert-attention`
 * alerts the recipients of "handoff" alerts. The event id is per conversation and day, so a
 * customer who writes ten times alerts once a day.
 */
export const AttentionNeededEvent = z.object({
  traceId: TraceId,
  agencyId: AgencyId,
  businessId: BusinessId,
  conversationId: ConversationId,
  reason: z.enum(ATTENTION_REASONS),
  /** The day (UTC, YYYY-MM-DD) the alert counts for; part of the alerts' dedupe key. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type AttentionNeededEvent = z.infer<typeof AttentionNeededEvent>;

export const HANDOFF_EVENTS = {
  "handoff.escalation_started": EscalationStartedEvent,
  "handoff.follow_up_planned": FollowUpPlannedEvent,
  "handoff.attention_needed": AttentionNeededEvent,
} as const;
