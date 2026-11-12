import {
  CHANNEL_CAPABILITIES,
  type ChannelId,
  type ConversationId,
  type LeadId,
  type TraceId,
} from "@repo/core";
import {
  and,
  bookings,
  type BusinessContext,
  conversations,
  conversationTurns,
  desc,
  eq,
  gt,
  inArray,
  max,
  messages,
  ne,
  scheduledJobs,
  sql,
  takeoverLocks,
  isNull,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import { type AppSettings, channelSetting } from "@repo/settings";
import { z } from "zod";

import type { ConversationFacts } from "../facts";
import { customerTimeZone, followUpsNeedBusinessHours, nextAllowedMoment } from "../time";

/*
 * Follow-ups: nudges to a customer who went quiet (cadence and maximum per channel from
 * `follow_up.*`), and check-ins the bot scheduled (`schedule_follow_up`). One plan is active
 * per conversation at a time: a `scheduled_jobs` row of kind "follow_up". A newer plan, a
 * reply, an opt-out, a takeover or a booking cancels what was planned; the job that wakes
 * for a plan checks its row and every rule again before it asks the pipeline for a turn.
 */

export const FollowUpPayload = z
  .object({
    /** "cadence": a nudge; "requested": a check-in the bot scheduled. */
    reason: z.enum(["cadence", "requested"]),
    /** Which nudge this is (1 for the first); null for a requested check-in. */
    nudge: z.number().int().min(1).nullable(),
    /** The customer's newest message when planned: a newer one means they replied. */
    inboundSeq: z.number().int().min(0),
    traceId: z.string(),
    /** When the turn was asked for (the service's clock), once it was. */
    requestedAt: z.string().optional(),
    /** Why the bot scheduled it (requested check-ins), as the model wrote it. Staff-facing. */
    note: z.string().optional(),
  })
  .loose();
export type FollowUpPayload = z.infer<typeof FollowUpPayload>;

/** The wait before nudge `n` (1-based): the cadence's n-th number, the last one repeating. */
export function nudgeDelayMinutes(delays: readonly number[], nudge: number): number {
  const index = Math.min(Math.max(nudge, 1), delays.length) - 1;
  return delays[index] ?? delays.at(-1) ?? 1440;
}

export function followUpPlannedEvent(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly followUpId: string;
    readonly traceId: string;
  },
  suffix = "",
): AnyJobEvent {
  return jobEvent("handoff.follow_up_planned", `follow-up-${input.followUpId}${suffix}`, {
    traceId: input.traceId as TraceId,
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.tenant.businessId,
    conversationId: input.conversationId,
    followUpId: input.followUpId,
  });
}

/** The customer's newest message's sequence in the conversation (0 when none). */
export async function lastInboundSeq(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<number> {
  const [row] = await ctx.tx
    .select({ seq: max(messages.sequence) })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "inbound"),
        ne(messages.kind, "reaction"),
      ),
    );
  return row?.seq ?? 0;
}

/** Cancels the conversation's planned follow-ups (all, or only the cadence's nudges). */
export async function cancelFollowUps(
  ctx: BusinessContext,
  conversationId: ConversationId,
  reason: string,
  now: Date,
  only?: "cadence",
): Promise<number> {
  const rows = await ctx.tx
    .update(scheduledJobs)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: reason })
    .where(
      and(
        eq(scheduledJobs.conversationId, conversationId),
        eq(scheduledJobs.kind, "follow_up"),
        inArray(scheduledJobs.status, ["scheduled", "running"]),
        only === undefined ? undefined : sql`${scheduledJobs.payload} ->> 'reason' = ${only}`,
      ),
    )
    .returning({ id: scheduledJobs.id });
  return rows.length;
}

/** Writes a plan (cancelling the conversation's earlier ones) and returns its event. */
export async function planFollowUp(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly leadId: LeadId | null;
    readonly runAt: Date;
    readonly payload: FollowUpPayload;
    readonly now: Date;
  },
): Promise<{ readonly followUpId: string; readonly event: AnyJobEvent }> {
  // Serialise plans of one conversation on its row.
  await ctx.tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  await cancelFollowUps(ctx, input.conversationId, "replaced", input.now);
  const id = crypto.randomUUID();
  await ctx.tx.insert(scheduledJobs).values({
    id,
    ...ctx.tenant,
    conversationId: input.conversationId,
    leadId: input.leadId,
    kind: "follow_up",
    status: "scheduled",
    runAt: input.runAt,
    payload: input.payload,
    dedupeKey: `follow_up:${id}`,
    externalJobId: `follow-up-${id}`,
  });
  return {
    followUpId: id,
    event: followUpPlannedEvent(ctx, {
      conversationId: input.conversationId,
      followUpId: id,
      traceId: input.payload.traceId,
    }),
  };
}

/** True when the channel lets a free-form bot message out at `at` (or a template replaces it). */
export function windowAllows(
  channel: ChannelId,
  lastInboundAt: Date | null,
  at: Date,
  values: AppSettings,
): boolean {
  const policy = CHANNEL_CAPABILITIES[channel].messagingWindow;
  if (policy.type === "none") return true;
  const open =
    lastInboundAt !== null && at.getTime() < lastInboundAt.getTime() + policy.hours * 3_600_000;
  if (open) return true;
  // WhatsApp sends nudges outside 24 hours as the approved follow-up template, if one is set.
  return channel === "whatsapp" && values["channels.whatsapp.follow_up_template"] !== null;
}

/**
 * Why a follow-up must not be sent (now or at all), or null. Checked when it is planned and
 * again when it wakes. `nudge` is null for a check-in the bot scheduled: the cadence's rules
 * (the maximum, an outcome already given) do not apply to it.
 */
export async function followUpBlocker(
  ctx: BusinessContext,
  input: {
    readonly facts: ConversationFacts;
    readonly values: AppSettings;
    readonly nudge: number | null;
    readonly inboundSeq: number | null;
  },
): Promise<string | null> {
  const { facts, values } = input;
  if (!values["follow_up.enabled"]) return "disabled";
  if (facts.status !== "open") return "conversation_closed";
  if (facts.metadata["ended"] !== undefined && facts.metadata["ended"] !== null) {
    return "conversation_ended";
  }
  if (facts.contact.optedOutAt !== null) return "opted_out";
  if (facts.contact.isBlocked) return "blocked";
  const [lock] = await ctx.tx
    .select({ id: takeoverLocks.id })
    .from(takeoverLocks)
    .where(
      and(eq(takeoverLocks.conversationId, facts.conversationId), isNull(takeoverLocks.releasedAt)),
    )
    .limit(1);
  if (lock !== undefined) return "takeover";
  if (input.inboundSeq !== null) {
    const [newer] = await ctx.tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, facts.conversationId),
          eq(messages.direction, "inbound"),
          ne(messages.kind, "reaction"),
          gt(messages.sequence, input.inboundSeq),
        ),
      )
      .limit(1);
    if (newer !== undefined) return "customer_replied";
  }
  const [booking] = await ctx.tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.conversationId, facts.conversationId),
        inArray(bookings.status, ["pending", "confirmed"]),
      ),
    )
    .limit(1);
  if (booking !== undefined || facts.lead?.status === "meeting_booked") return "booked";
  if (facts.lead?.status === "disqualified") return "disqualified";
  if (facts.lead?.status === "handed_off") return "handed_off";
  if (input.nudge !== null) {
    if (input.nudge > channelSetting(values, "follow_up.max_nudges", facts.channel)) {
      return "max_nudges";
    }
    if (facts.lead?.routingOutcome === "contact_later" && !values["follow_up.after_outcome"]) {
      return "outcome_given";
    }
  }
  return null;
}

/** When a follow-up due at `due` may go out, or null when it never can (closed window). */
export function followUpSendTime(input: {
  readonly due: Date;
  readonly facts: ConversationFacts;
  readonly values: AppSettings;
}): Date | null {
  const { facts, values } = input;
  const at = nextAllowedMoment({
    from: input.due,
    values,
    customerTimeZone: customerTimeZone({
      contactTimeZone: facts.contact.timeZone,
      phone: facts.contact.phone,
      businessTimeZone: facts.business.timeZone,
      mode: values["hours.customer_time_zone"],
    }),
    businessTimeZone: facts.business.timeZone,
    businessHoursOnly: followUpsNeedBusinessHours(values),
  });
  if (at === null) return null;
  return windowAllows(facts.channel, facts.lastInboundAt, at, values) ? at : null;
}

/**
 * How many times the bot has answered since the customer last wrote: the reply to their
 * message, then each nudge. The next nudge's number is this count.
 */
export async function botRoundsSinceCustomer(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<number> {
  const turns = await ctx.tx
    .select({ status: conversationTurns.status, pending: conversationTurns.pendingCount })
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversationId))
    .orderBy(desc(conversationTurns.ordinal))
    .limit(50);
  let rounds = 0;
  for (const turn of turns) {
    if (turn.status === "replied") rounds += 1;
    if (turn.pending > 0 && turn.status !== "superseded" && turn.status !== "failed") break;
  }
  return rounds;
}
