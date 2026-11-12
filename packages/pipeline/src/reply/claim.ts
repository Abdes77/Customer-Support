import { randomUUID } from "node:crypto";

import type {
  ChannelConnectionId,
  ChannelId,
  ContactId,
  ConversationId,
  EventPayload,
  TurnTrigger,
} from "@repo/core";
import {
  and,
  attachments,
  type BusinessContext,
  businesses,
  channelConnections,
  contacts,
  conversations,
  conversationTurns,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  max,
  messages,
  min,
  ne,
  notInArray,
  sql,
  takeoverLocks,
} from "@repo/db";
import { type AppResolvedSettings, channelSetting } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import type { PipelineContext, TurnFacts } from "../deps";

type ReceivedData = EventPayload<"message.received">;
type RequestedData = EventPayload<"conversation.turn_requested">;

/** Inbound messages that ask for an answer (reactions do not). */
export const replyableInbound = and(
  eq(messages.direction, "inbound"),
  ne(messages.kind, "reaction"),
);

export type PlanResult =
  | { readonly kind: "done"; readonly reason: string }
  | {
      readonly kind: "wait";
      /** The id the turn will have if it claims the lease. Fixed here so retries reuse it. */
      readonly turnId: string;
      /** Sleep until then before claiming. */
      readonly waitUntil: string;
      /** After this, a newer message no longer postpones the answer. */
      readonly deadline: string;
    };

export type ClaimResult =
  | { readonly kind: "done"; readonly reason: string }
  | { readonly kind: "busy" }
  | { readonly kind: "skipped"; readonly turnId: string; readonly reason: string }
  | ClaimedTurn;

export interface ClaimedTurn {
  readonly kind: "claimed";
  readonly turnId: string;
  readonly traceId: string;
  /** What started the turn: a customer message, or a requested follow-up or check-in (C13). */
  readonly trigger: TurnTrigger;
  readonly throughSeq: number;
  readonly channel: ChannelId;
  readonly connectionId: ChannelConnectionId;
  readonly contactExternalId: string | null;
  /** Attachments of the pending messages that still have to be downloaded. */
  readonly attachmentIds: readonly string[];
  /** The newest pending message at the provider, for the read receipt. */
  readonly latestExternalMessageId: string | null;
}

/**
 * Step "plan" of a reply turn (ARCHITECTURE §2, step 8): how long to wait before answering.
 * The wait is the per-channel reply wait after this message, capped by the longest wait
 * counted from the first unanswered message.
 */
export async function planTurn(
  ctx: BusinessContext,
  p: PipelineContext,
  data: ReceivedData,
): Promise<PlanResult> {
  const [conversation] = await ctx.tx
    .select({ handled: conversations.handledThroughSeq, channel: conversations.channel })
    .from(conversations)
    .where(eq(conversations.id, data.conversationId))
    .limit(1);
  const [message] = await ctx.tx
    .select({ sequence: messages.sequence, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.id, data.messageId), eq(messages.conversationId, data.conversationId)))
    .limit(1);
  if (conversation === undefined || message === undefined) {
    return { kind: "done", reason: "not_found" };
  }
  if (message.sequence <= conversation.handled) return { kind: "done", reason: "already_handled" };

  const [first] = await ctx.tx
    .select({ at: min(messages.createdAt) })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, data.conversationId),
        replyableInbound,
        gt(messages.sequence, conversation.handled),
      ),
    );
  const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
  const waitMs =
    channelSetting(settings.values, "conversation.reply_wait_seconds", conversation.channel) * 1000;
  const maxWaitMs = settings.values["conversation.max_wait_seconds"] * 1000;
  const firstAt = (first?.at ?? message.createdAt).getTime();
  const deadline = firstAt + maxWaitMs;
  const waitUntil = Math.min(message.createdAt.getTime() + waitMs, deadline);
  return {
    kind: "wait",
    turnId: randomUUID(),
    waitUntil: new Date(waitUntil).toISOString(),
    deadline: new Date(deadline).toISOString(),
  };
}

interface ConversationState {
  readonly id: ConversationId;
  readonly status: "open" | "closed";
  readonly handled: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly contactId: ContactId;
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelId;
}

async function lockConversation(
  ctx: BusinessContext,
  conversationId: ConversationId,
): Promise<ConversationState | undefined> {
  const [row] = await ctx.tx
    .select({
      id: conversations.id,
      status: conversations.status,
      handled: conversations.handledThroughSeq,
      leaseOwner: conversations.turnLeaseOwner,
      leaseExpiresAt: conversations.turnLeaseExpiresAt,
      contactId: conversations.contactId,
      connectionId: conversations.channelConnectionId,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update")
    .limit(1);
  return row;
}

/**
 * Step "claim" of a reply turn (steps 8 to 10): give way to a newer message, take the turn
 * lease, create the turn row and run the guards, all in one transaction with the
 * conversation row locked. Safe to repeat: a retry of a claim that committed finds its own
 * lease and returns the same turn.
 */
export async function claimTurn(
  ctx: BusinessContext,
  p: PipelineContext,
  data: ReceivedData,
  plan: Extract<PlanResult, { kind: "wait" }>,
  runId: string,
): Promise<ClaimResult> {
  const now = p.clock();
  const conversation = await lockConversation(ctx, data.conversationId);
  if (conversation === undefined) return { kind: "done", reason: "not_found" };

  if (conversation.leaseOwner === plan.turnId) {
    const [turn] = await ctx.tx
      .select({ status: conversationTurns.status })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, plan.turnId))
      .limit(1);
    if (turn?.status !== "running") return { kind: "done", reason: "already_finished" };
    return claimedTurn(ctx, conversation, plan.turnId, data.traceId);
  }
  // A retried claim whose turn was created earlier but has lost the lease since (it expired
  // and the turn was closed): the turn is over, and its id cannot be used again.
  const [earlier] = await ctx.tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(eq(conversationTurns.id, plan.turnId))
    .limit(1);
  if (earlier !== undefined) return { kind: "done", reason: "already_finished" };

  const [message] = await ctx.tx
    .select({ sequence: messages.sequence })
    .from(messages)
    .where(eq(messages.id, data.messageId))
    .limit(1);
  if (message === undefined || message.sequence <= conversation.handled) {
    return { kind: "done", reason: "already_handled" };
  }
  const [latest] = await ctx.tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), replyableInbound));
  if ((latest?.sequence ?? 0) > message.sequence && now < new Date(plan.deadline)) {
    // The run for the newer message answers this one too.
    return { kind: "done", reason: "newer_message" };
  }

  if (conversation.leaseOwner !== null) {
    if (conversation.leaseExpiresAt !== null && conversation.leaseExpiresAt > now) {
      return { kind: "busy" };
    }
    // The previous turn crashed and its lease ran out: close its row and take over.
    await ctx.tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: "lease_expired",
        errorMessage: "The turn lease expired before the turn finished.",
        completedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, conversation.leaseOwner),
          eq(conversationTurns.status, "running"),
        ),
      );
    p.logger.warn("turn.lease_expired", {
      businessId: ctx.tenant.businessId,
      conversationId: conversation.id,
      turnId: conversation.leaseOwner,
    });
  }

  const [through] = await ctx.tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, "inbound")));
  const throughSeq = through?.sequence ?? 0;
  const [pending] = await ctx.tx
    .select({ total: count() })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        replyableInbound,
        gt(messages.sequence, conversation.handled),
        lte(messages.sequence, throughSeq),
      ),
    );
  const [last] = await ctx.tx
    .select({ ordinal: max(conversationTurns.ordinal) })
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversation.id));

  await ctx.tx.insert(conversationTurns).values({
    id: plan.turnId,
    ...ctx.tenant,
    conversationId: conversation.id,
    ordinal: (last?.ordinal ?? 0) + 1,
    trigger: "inbound_message",
    status: "running",
    runId,
    traceId: data.traceId,
    throughSeq,
    pendingCount: pending?.total ?? 0,
    startedAt: now,
  });
  await ctx.tx
    .update(conversations)
    .set({
      turnLeaseOwner: plan.turnId,
      turnLeaseExpiresAt: new Date(now.getTime() + p.options.leaseSeconds * 1000),
    })
    .where(eq(conversations.id, conversation.id));

  const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
  const reason = await guardReason(ctx, p, conversation, settings, now, "inbound_message");
  if (reason !== null) {
    await finishSkipped(ctx, plan.turnId, conversation.id, throughSeq, reason, now);
    p.logger.info("turn.skipped", {
      traceId: data.traceId,
      businessId: ctx.tenant.businessId,
      conversationId: conversation.id,
      reason,
    });
    return { kind: "skipped", turnId: plan.turnId, reason };
  }
  return claimedTurn(ctx, { ...conversation }, plan.turnId, data.traceId, throughSeq);
}

async function claimedTurn(
  ctx: BusinessContext,
  conversation: ConversationState,
  turnId: string,
  traceId: string,
  knownThroughSeq?: number,
): Promise<ClaimedTurn> {
  const [turn] = await ctx.tx
    .select({ throughSeq: conversationTurns.throughSeq, trigger: conversationTurns.trigger })
    .from(conversationTurns)
    .where(eq(conversationTurns.id, turnId))
    .limit(1);
  const throughSeq = knownThroughSeq ?? turn?.throughSeq ?? 0;
  const trigger: TurnTrigger = turn?.trigger ?? "inbound_message";
  const pendingRows = await ctx.tx
    .select({ id: messages.id, externalMessageId: messages.externalMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        replyableInbound,
        gt(messages.sequence, conversation.handled),
        lte(messages.sequence, throughSeq),
      ),
    )
    .orderBy(messages.sequence);
  const pendingIds = pendingRows.map((row) => row.id);
  const attachmentRows =
    pendingIds.length === 0
      ? []
      : await ctx.tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(and(inArray(attachments.messageId, pendingIds), eq(attachments.status, "pending")))
          .orderBy(attachments.createdAt, attachments.id);
  const [identity] = await ctx.tx.execute(
    sql`select external_id from contact_identities
         where contact_id = ${conversation.contactId}::uuid and channel = ${conversation.channel}
         order by last_seen_at desc nulls last limit 1`,
  );
  return {
    kind: "claimed",
    turnId,
    traceId,
    trigger,
    throughSeq,
    channel: conversation.channel,
    connectionId: conversation.connectionId,
    contactExternalId: (identity?.["external_id"] as string | undefined) ?? null,
    attachmentIds: attachmentRows.map((row) => row.id),
    latestExternalMessageId: pendingRows.at(-1)?.externalMessageId ?? null,
  };
}

/**
 * The built-in guards (step 10), then the ones registered by other chunks. Returns the first
 * reason to stay silent, or null.
 */
async function guardReason(
  ctx: BusinessContext,
  p: PipelineContext,
  conversation: ConversationState,
  settings: AppResolvedSettings,
  now: Date,
  trigger: TurnTrigger,
): Promise<string | null> {
  if (conversation.status !== "open") return "conversation_closed";

  const [lock] = await ctx.tx
    .select({ id: takeoverLocks.id })
    .from(takeoverLocks)
    .where(and(eq(takeoverLocks.conversationId, conversation.id), isNull(takeoverLocks.releasedAt)))
    .limit(1);
  if (lock !== undefined) return "takeover";

  const [contact] = await ctx.tx
    .select({ optedOutAt: contacts.optedOutAt, isBlocked: contacts.isBlocked })
    .from(contacts)
    .where(eq(contacts.id, conversation.contactId))
    .limit(1);
  // A turn the bot starts itself (a follow-up, a check-in) never reaches a customer who opted
  // out. A turn for what the customer wrote runs: the registered opt-out rules (C13) decide
  // what it may send (an emergency is always answered), and the send step checks again.
  if (contact?.optedOutAt != null && trigger !== "inbound_message") return "opted_out";
  if (contact?.isBlocked === true) return "blocked";

  const [business] = await ctx.tx
    .select({ status: businesses.status, segmentId: businesses.segmentId })
    .from(businesses)
    .where(eq(businesses.id, ctx.tenant.businessId))
    .limit(1);
  if (business === undefined) return "business_missing";
  if (business.status === "archived" || business.status === "paused") return "business_inactive";
  // During onboarding only the test chat answers (C15's wizard).
  if (business.status === "onboarding" && conversation.channel !== "test") {
    return "business_onboarding";
  }
  if (business.segmentId === null) return "business_without_segment";

  const [connection] = await ctx.tx
    .select({ status: channelConnections.status })
    .from(channelConnections)
    .where(eq(channelConnections.id, conversation.connectionId))
    .limit(1);
  if (
    connection === undefined ||
    connection.status === "revoked" ||
    connection.status === "disabled"
  ) {
    return "connection_inactive";
  }

  const [replies] = await ctx.tx
    .select({ total: count() })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        eq(messages.direction, "outbound"),
        eq(messages.author, "bot"),
        notInArray(messages.status, ["superseded", "failed"]),
      ),
    );
  if ((replies?.total ?? 0) >= settings.values["conversation.max_bot_replies"]) {
    return "max_bot_replies";
  }

  const facts: TurnFacts = {
    tenant: ctx.tenant,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    channel: conversation.channel,
    trigger,
    settings,
    now,
  };
  for (const guard of p.guards) {
    const reason = await guard.check(ctx, facts);
    if (reason !== null) return `${guard.name}:${reason}`;
  }
  return null;
}

/**
 * Step "claim" of a requested turn (C13: a follow-up, or a check-in after a takeover ended):
 * the same lease, turn row and guards as a reply turn, with no customer message to answer.
 * Unanswered customer messages are the reply run's to answer, so the request gives way to
 * them. Safe to repeat, like `claimTurn`.
 */
export async function claimRequestedTurn(
  ctx: BusinessContext,
  p: PipelineContext,
  data: RequestedData,
  turnId: string,
  runId: string,
): Promise<ClaimResult> {
  const now = p.clock();
  const conversation = await lockConversation(ctx, data.conversationId);
  if (conversation === undefined) return { kind: "done", reason: "not_found" };

  if (conversation.leaseOwner === turnId) {
    const [turn] = await ctx.tx
      .select({ status: conversationTurns.status })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
      .limit(1);
    if (turn?.status !== "running") return { kind: "done", reason: "already_finished" };
    return claimedTurn(ctx, conversation, turnId, data.traceId);
  }
  const [earlier] = await ctx.tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(eq(conversationTurns.id, turnId))
    .limit(1);
  if (earlier !== undefined) return { kind: "done", reason: "already_finished" };

  const [unanswered] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        replyableInbound,
        gt(messages.sequence, conversation.handled),
      ),
    )
    .limit(1);
  if (unanswered !== undefined) return { kind: "done", reason: "pending_messages" };

  if (conversation.leaseOwner !== null) {
    if (conversation.leaseExpiresAt !== null && conversation.leaseExpiresAt > now) {
      return { kind: "busy" };
    }
    await ctx.tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: "lease_expired",
        errorMessage: "The turn lease expired before the turn finished.",
        completedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, conversation.leaseOwner),
          eq(conversationTurns.status, "running"),
        ),
      );
  }

  const throughSeq = conversation.handled;
  const [last] = await ctx.tx
    .select({ ordinal: max(conversationTurns.ordinal) })
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversation.id));
  await ctx.tx.insert(conversationTurns).values({
    id: turnId,
    ...ctx.tenant,
    conversationId: conversation.id,
    ordinal: (last?.ordinal ?? 0) + 1,
    trigger: data.trigger,
    status: "running",
    runId,
    traceId: data.traceId,
    throughSeq,
    pendingCount: 0,
    startedAt: now,
  });
  await ctx.tx
    .update(conversations)
    .set({
      turnLeaseOwner: turnId,
      turnLeaseExpiresAt: new Date(now.getTime() + p.options.leaseSeconds * 1000),
    })
    .where(eq(conversations.id, conversation.id));

  const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
  const reason = await guardReason(ctx, p, conversation, settings, now, data.trigger);
  if (reason !== null) {
    await finishSkipped(ctx, turnId, conversation.id, throughSeq, reason, now);
    p.logger.info("turn.skipped", {
      traceId: data.traceId,
      businessId: ctx.tenant.businessId,
      conversationId: conversation.id,
      trigger: data.trigger,
      reason,
    });
    return { kind: "skipped", turnId, reason };
  }
  return claimedTurn(ctx, conversation, turnId, data.traceId, throughSeq);
}

/** A guard stopped the turn: the pending messages count as handled and the lease is free. */
async function finishSkipped(
  ctx: BusinessContext,
  turnId: string,
  conversationId: ConversationId,
  throughSeq: number,
  reason: string,
  now: Date,
): Promise<void> {
  await ctx.tx
    .update(conversationTurns)
    .set({ status: "skipped", skipReason: reason, completedAt: now })
    .where(eq(conversationTurns.id, turnId));
  await ctx.tx
    .update(conversations)
    .set({
      handledThroughSeq: sql`greatest(${conversations.handledThroughSeq}, ${throughSeq})`,
      turnLeaseOwner: null,
      turnLeaseExpiresAt: null,
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.turnLeaseOwner, turnId)));
}
