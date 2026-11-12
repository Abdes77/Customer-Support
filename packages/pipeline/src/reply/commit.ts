import type {
  EngineTurnResult,
  EventPayload,
  ExecutedAction,
  MessageId,
  ReplyDraft,
  TraceId,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  conversations,
  conversationTurns,
  eq,
  gt,
  inArray,
  isNull,
  messages,
  type MessageStatus,
  sql,
  takeoverLocks,
  type TurnStatus,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";

import type { CommittedTurn, PipelineContext } from "../deps";
import { sendEventId, takeoverStartedEventId } from "../event-ids";
import { raiseInAppAlert, recordDeadLetter } from "../failures";
import type { ClaimedTurn } from "./claim";
import { replyableInbound } from "./claim";
import type { GenerateResult } from "./generate";

type ReceivedData = EventPayload<"message.received">;

export interface CommitResult {
  readonly status: TurnStatus;
  readonly messageIds: readonly string[];
  /** Events to emit once the commit is durable: sends and takeovers. */
  readonly events: readonly AnyJobEvent[];
}

function usable(draft: ReplyDraft): boolean {
  return draft.text.trim().length > 0;
}

function outboundValues(draft: ReplyDraft, subjectFallback: string | null) {
  if (draft.kind === "email") {
    return {
      kind: "email",
      text: draft.text.trim(),
      payload: { subject: draft.subject ?? subjectFallback },
    };
  }
  return {
    kind: "text",
    text: draft.text.trim(),
    payload:
      draft.quickReplies === undefined || draft.quickReplies.length === 0
        ? {}
        : { quickReplies: draft.quickReplies },
  };
}

function sendEvents(
  ctx: BusinessContext,
  data: ReceivedData,
  traceId: string,
  messageIds: readonly string[],
): AnyJobEvent[] {
  return messageIds.map((messageId) =>
    jobEvent("message.send_requested", sendEventId(messageId), {
      traceId: traceId as TraceId,
      agencyId: ctx.tenant.agencyId,
      businessId: ctx.tenant.businessId,
      conversationId: data.conversationId,
      messageId: messageId as MessageId,
      channel: data.channel,
    }),
  );
}

/**
 * Step "commit" (steps 13 and 14): in one transaction, with the turn and the conversation
 * locked, check the lease is still ours, do the stale check, store the drafts as outbound
 * messages with sequence numbers, move the watermark, record the turn and free the lease.
 * Repeating it after it committed returns the same messages.
 */
export async function commitTurn(
  ctx: BusinessContext,
  p: PipelineContext,
  data: ReceivedData,
  claim: ClaimedTurn,
  generated: GenerateResult,
): Promise<CommitResult> {
  const now = p.clock();
  // Conversation first, then the turn: the same order as the claim and the sweeper, which
  // lock the conversation and then close an expired turn. The other order can deadlock.
  const [conversation] = await ctx.tx
    .select({
      id: conversations.id,
      leaseOwner: conversations.turnLeaseOwner,
      subject: conversations.subject,
    })
    .from(conversations)
    .where(eq(conversations.id, data.conversationId))
    .for("update")
    .limit(1);
  const [turn] = await ctx.tx
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.id, claim.turnId))
    .for("update")
    .limit(1);
  if (turn === undefined) return { status: "failed", messageIds: [], events: [] };
  if (turn.status !== "running") {
    // Already committed: hand back what is still waiting to be sent.
    const queued =
      turn.replyMessageIds.length === 0
        ? []
        : await ctx.tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                inArray(messages.id, turn.replyMessageIds as MessageId[]),
                eq(messages.status, "queued"),
              ),
            );
    const observed = await observeTurn(ctx, p, {
      conversationId: data.conversationId,
      turnId: turn.id,
      traceId: turn.traceId,
      status: turn.status,
      actions: turn.actions.filter(isExecutedAction),
      now,
    });
    return {
      status: turn.status,
      messageIds: turn.replyMessageIds,
      events: [
        ...sendEvents(
          ctx,
          data,
          turn.traceId,
          queued.map((row) => row.id),
        ),
        ...observed,
      ],
    };
  }

  if (conversation?.leaseOwner !== turn.id || generated.kind === "abandoned") {
    const reason = generated.kind === "abandoned" ? generated.reason : "lease_lost";
    await ctx.tx
      .update(conversationTurns)
      .set({ status: "failed", errorCode: reason, completedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    if (conversation?.leaseOwner === turn.id) await releaseLease(ctx, turn.id, null);
    p.logger.warn("turn.abandoned", {
      traceId: turn.traceId,
      conversationId: data.conversationId,
      reason,
    });
    return { status: "failed", messageIds: [], events: [] };
  }

  const result: EngineTurnResult = generated.result;
  const drafts = result.outcome === "replied" ? result.replies.filter(usable) : [];
  let status: TurnStatus;
  let advance = true;
  let messageStatus: MessageStatus = "queued";
  const events: AnyJobEvent[] = [];

  if (drafts.length > 0) {
    // Stale check: a newer customer message arrived while the engine was writing. Keep the
    // drafts but do not send them; the newer run answers everything. At most one supersede
    // in a row, so a customer who keeps typing still gets an answer.
    const [newer] = await ctx.tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          replyableInbound,
          gt(messages.sequence, turn.throughSeq),
        ),
      )
      .limit(1);
    const [previous] = await ctx.tx
      .select({ status: conversationTurns.status })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, conversation.id),
          eq(conversationTurns.ordinal, turn.ordinal - 1),
        ),
      )
      .limit(1);
    if (newer !== undefined && previous?.status !== "superseded") {
      status = "superseded";
      advance = false;
      messageStatus = "superseded";
    } else {
      status = "replied";
    }
  } else if (result.outcome === "refused") {
    status = "refused";
  } else if (result.outcome === "failed") {
    status = "failed";
    advance = false;
  } else {
    status = "no_reply";
  }

  const messageIds: string[] = [];
  for (const draft of drafts) {
    const [counter] = await ctx.tx
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, conversation.id))
      .returning({ sequence: conversations.messageSeq });
    const values = outboundValues(draft, conversation.subject);
    const [row] = await ctx.tx
      .insert(messages)
      .values({
        ...ctx.tenant,
        conversationId: conversation.id,
        channelConnectionId: claim.connectionId,
        direction: "outbound",
        author: "bot",
        kind: values.kind,
        text: values.text,
        payload: values.payload,
        sequence: counter!.sequence,
        status: messageStatus,
        traceId: turn.traceId,
        ...(messageStatus === "superseded" ? { errorCode: "newer_message" } : {}),
      })
      .returning({ id: messages.id });
    messageIds.push(row!.id);
  }
  if (status === "replied") events.push(...sendEvents(ctx, data, turn.traceId, messageIds));

  if (status === "refused") {
    const event = await startRuleTakeover(
      ctx,
      data,
      turn.traceId,
      "The model declined to answer.",
      now,
    );
    if (event !== null) events.push(event);
  }
  if (status === "failed") {
    await recordDeadLetter(ctx, {
      source: "pipeline-reply",
      eventName: "message.received",
      eventId: null,
      traceId: turn.traceId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      errorCode: "engine_failed",
      errorMessage: "The conversation engine could not produce a reply.",
      retryable: false,
      attempts: 1,
      payload: { ...data },
    });
    await raiseInAppAlert(ctx, {
      kind: "turn_failed",
      severity: "warning",
      conversationId: data.conversationId,
      subject: "The bot could not answer a conversation.",
      dedupeKey: `turn_failed:${turn.id}`,
      payload: { turnId: turn.id, conversationId: data.conversationId },
    });
  }

  await ctx.tx
    .update(conversationTurns)
    .set({
      status,
      engineOutcome: result.outcome,
      promptVersion: result.promptVersion,
      settingsVersion: result.settingsVersion,
      actions: result.actions as unknown[],
      replyMessageIds: messageIds,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      completedAt: now,
    })
    .where(eq(conversationTurns.id, turn.id));
  await releaseLease(ctx, turn.id, advance ? turn.throughSeq : null);
  events.push(
    ...(await observeTurn(ctx, p, {
      conversationId: data.conversationId,
      turnId: turn.id,
      traceId: turn.traceId,
      status,
      actions: result.actions,
      now,
    })),
  );

  p.logger.info("turn.committed", {
    traceId: turn.traceId,
    businessId: ctx.tenant.businessId,
    conversationId: data.conversationId,
    turnId: turn.id,
    status,
    replies: messageIds.length,
    actions: result.actions.length,
  });
  return { status, messageIds, events };
}

function isExecutedAction(value: unknown): value is ExecutedAction {
  if (value === null || typeof value !== "object") return false;
  const entry = value as { action?: { type?: unknown }; outcome?: { status?: unknown } };
  return typeof entry.action?.type === "string" && typeof entry.outcome?.status === "string";
}

/**
 * Runs the turn observers (C5: the lead side of the turn) inside the commit transaction,
 * each under its own savepoint: an observer that fails is rolled back and logged, and the
 * turn still commits. Returns the events they want sent with the turn's.
 */
async function observeTurn(
  ctx: BusinessContext,
  p: PipelineContext,
  turn: CommittedTurn,
): Promise<AnyJobEvent[]> {
  const events: AnyJobEvent[] = [];
  for (const observer of p.observers) {
    try {
      const produced = await ctx.tx.transaction((tx) => observer.committed({ ...ctx, tx }, turn));
      events.push(...produced);
    } catch (error) {
      p.logger.error("turn.observer_failed", {
        observer: observer.name,
        traceId: turn.traceId,
        businessId: ctx.tenant.businessId,
        conversationId: turn.conversationId,
        error: observerError(error),
      });
    }
  }
  return events;
}

/**
 * What is safe to log of an observer's error. A failed query's message carries the query's
 * parameters (lead field values, evidence, report text: customer data), and the database's
 * own message can quote a value, so of those only the names and the SQLSTATE code are kept.
 */
function observerError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "Error" };
  const cause = error.cause;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : null;
  if (error.message.startsWith("Failed query") || cause !== undefined) {
    return { name: error.name, cause: cause instanceof Error ? cause.name : null, code };
  }
  return { name: error.name, message: error.message, stack: error.stack };
}

/** Frees the turn lease (if this turn holds it) and, when given, moves the watermark. */
export async function releaseLease(
  ctx: BusinessContext,
  turnId: string,
  handledThrough: number | null,
): Promise<void> {
  await ctx.tx
    .update(conversations)
    .set({
      turnLeaseOwner: null,
      turnLeaseExpiresAt: null,
      ...(handledThrough === null
        ? {}
        : {
            handledThroughSeq: sql`greatest(${conversations.handledThroughSeq}, ${handledThrough})`,
          }),
    })
    .where(eq(conversations.turnLeaseOwner, turnId));
}

/**
 * Hands the conversation to people because a rule says so (the model refused). C13 owns the
 * takeover rules and the release; this only records the lock and announces it.
 */
export async function startRuleTakeover(
  ctx: BusinessContext,
  data: Pick<ReceivedData, "conversationId">,
  traceId: string,
  reason: string,
  now: Date,
): Promise<AnyJobEvent | null> {
  const [active] = await ctx.tx
    .select({ id: takeoverLocks.id })
    .from(takeoverLocks)
    .where(
      and(eq(takeoverLocks.conversationId, data.conversationId), isNull(takeoverLocks.releasedAt)),
    )
    .limit(1);
  if (active !== undefined) return null;
  const [lock] = await ctx.tx
    .insert(takeoverLocks)
    .values({
      ...ctx.tenant,
      conversationId: data.conversationId,
      source: "rule",
      reason,
      startedAt: now,
      lastActivityAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: takeoverLocks.id });
  if (lock === undefined) return null;
  return jobEvent("conversation.takeover_started", takeoverStartedEventId(lock.id), {
    traceId: traceId as TraceId,
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.tenant.businessId,
    conversationId: data.conversationId,
    userId: null,
    source: "rule",
  });
}
