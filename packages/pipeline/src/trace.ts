import type { ExecutedAction, MessageId } from "@repo/core";
import {
  and,
  asc,
  type BusinessContext,
  conversationTurns,
  eq,
  gte,
  inArray,
  messageParts,
  messages,
  modelCalls,
  or,
} from "@repo/db";

/**
 * The trace of one customer message (C17): which turn answered it, the model calls that turn
 * made, the actions it took and the messages it sent, each with ids, statuses, times and
 * tokens, never text. It links what the logs (`traceId`), Sentry (`trace` context and tags),
 * `model_calls.trace_id`, `conversation_turns` and `messages.trace_id` record separately.
 *
 * A turn answers every customer message above the conversation's watermark, so a message
 * that arrived in a burst is answered by the turn of the burst's last message, under that
 * message's trace id: the turns listed are those whose range covers the message, up to and
 * including the first that moved the watermark (a failed or superseded attempt does not).
 */
export interface MessageTrace {
  readonly message: {
    readonly id: string;
    readonly traceId: string;
    readonly conversationId: string;
    readonly sequence: number;
    readonly receivedAt: string;
    readonly enqueuedAt: string | null;
  };
  readonly turns: readonly {
    readonly id: string;
    readonly traceId: string;
    readonly trigger: string;
    readonly status: string;
    readonly skipReason: string | null;
    readonly engineOutcome: string | null;
    readonly promptVersion: string | null;
    readonly startedAt: string;
    readonly completedAt: string | null;
    readonly actions: readonly { readonly type: string; readonly status: string }[];
    readonly modelCalls: readonly {
      readonly id: string;
      readonly purpose: string;
      readonly model: string;
      readonly stopReason: string | null;
      readonly latencyMs: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadInputTokens: number;
      readonly costMicroUsd: number | null;
    }[];
    readonly replies: readonly {
      readonly id: string;
      readonly status: string;
      readonly sequence: number;
      readonly externalMessageId: string | null;
      readonly parts: readonly { readonly externalMessageId: string; readonly status: string }[];
    }[];
  }[];
}

const SETTLED = new Set(["replied", "no_reply", "refused", "skipped"]);

/** The trace of an inbound message, read inside the business's scope; null when unknown. */
export async function traceMessage(
  ctx: BusinessContext,
  messageId: MessageId,
): Promise<MessageTrace | null> {
  const [message] = await ctx.tx
    .select({
      id: messages.id,
      traceId: messages.traceId,
      conversationId: messages.conversationId,
      sequence: messages.sequence,
      direction: messages.direction,
      createdAt: messages.createdAt,
      enqueuedAt: messages.enqueuedAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (message?.direction !== "inbound") return null;

  const candidates = await ctx.tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, message.conversationId),
        gte(conversationTurns.throughSeq, message.sequence),
      ),
    )
    .orderBy(asc(conversationTurns.ordinal));
  const turns: typeof candidates = [];
  for (const turn of candidates) {
    turns.push(turn);
    if (SETTLED.has(turn.status)) break;
  }

  const traceIds = [...new Set(turns.map((turn) => turn.traceId))];
  const replyIds = turns.flatMap((turn) => turn.replyMessageIds) as MessageId[];
  const calls =
    traceIds.length === 0
      ? []
      : await ctx.tx
          .select()
          .from(modelCalls)
          .where(
            and(
              eq(modelCalls.conversationId, message.conversationId),
              inArray(modelCalls.traceId, traceIds),
            ),
          )
          .orderBy(asc(modelCalls.startedAt));
  const replies =
    replyIds.length === 0
      ? []
      : await ctx.tx
          .select({
            id: messages.id,
            status: messages.status,
            sequence: messages.sequence,
            traceId: messages.traceId,
            externalMessageId: messages.externalMessageId,
          })
          .from(messages)
          .where(or(inArray(messages.id, replyIds)))
          .orderBy(asc(messages.sequence));
  const parts =
    replyIds.length === 0
      ? []
      : await ctx.tx
          .select({
            messageId: messageParts.messageId,
            externalMessageId: messageParts.externalMessageId,
            status: messageParts.status,
          })
          .from(messageParts)
          .where(inArray(messageParts.messageId, replyIds));

  return {
    message: {
      id: message.id,
      traceId: message.traceId,
      conversationId: message.conversationId,
      sequence: message.sequence,
      receivedAt: message.createdAt.toISOString(),
      enqueuedAt: message.enqueuedAt?.toISOString() ?? null,
    },
    turns: turns.map((turn) => ({
      id: turn.id,
      traceId: turn.traceId,
      trigger: turn.trigger,
      status: turn.status,
      skipReason: turn.skipReason,
      engineOutcome: turn.engineOutcome,
      promptVersion: turn.promptVersion,
      startedAt: turn.startedAt.toISOString(),
      completedAt: turn.completedAt?.toISOString() ?? null,
      actions: (turn.actions as ExecutedAction[]).map((entry) => ({
        type: entry.action.type,
        status: entry.outcome.status,
      })),
      modelCalls: calls
        .filter((call) => call.traceId === turn.traceId)
        .map((call) => ({
          id: call.id,
          purpose: call.purpose,
          model: call.model,
          stopReason: call.stopReason,
          latencyMs: call.latencyMs,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          cacheReadInputTokens: call.cacheReadInputTokens,
          costMicroUsd: call.costMicroUsd,
        })),
      replies: replies
        .filter((reply) => turn.replyMessageIds.includes(reply.id))
        .map((reply) => ({
          id: reply.id,
          status: reply.status,
          sequence: reply.sequence,
          externalMessageId: reply.externalMessageId,
          parts: parts
            .filter((part) => part.messageId === reply.id)
            .map((part) => ({ externalMessageId: part.externalMessageId, status: part.status })),
        })),
    })),
  };
}
