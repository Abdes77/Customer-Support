import { z } from "zod";

import {
  AppError,
  type ChannelConnectionId,
  type EventPayload,
  ExternalServiceError,
  type MessageId,
  type OutboundMessage,
  type SendTarget,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  conversations,
  eq,
  inArray,
  lt,
  messages,
  or,
  sql,
} from "@repo/db";
import {
  type AnyJobEvent,
  defineEventJob,
  type EventJobDefinition,
  jobEvent,
  type JobContext,
} from "@repo/jobs";

import { loadConnectionContext } from "../connection";
import type { PipelineContext } from "../deps";
import { sendFailedEventId } from "../event-ids";
import { raiseInAppAlert, recordDeadLetter } from "../failures";
import { applyHeldStatuses, recordParts } from "./deliveries";
import { prepareSend, type SendTargetInfo } from "./prepare";
import { messagingWindow } from "./window";

type SendData = EventPayload<"message.send_requested">;

export const SEND_FUNCTION_ID = "pipeline-send";

type ClaimSend =
  | { readonly kind: "claimed"; readonly sequence: number }
  | { readonly kind: "done"; readonly reason: string };

type PartResult =
  | { readonly ok: true; readonly externalMessageId: string; readonly sentAt: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly windowClosed: boolean;
    };

/**
 * Claims the message for this run: `queued` → `sending`, recording the run in the payload.
 * Another run (a sweeper re-emit) finds it claimed and stops; this run's own retry finds its
 * id and goes on.
 */
async function claimSend(
  ctx: BusinessContext,
  messageId: MessageId,
  runId: string,
): Promise<ClaimSend> {
  const delivery = JSON.stringify({ delivery: { runId } });
  const [row] = await ctx.tx
    .update(messages)
    .set({
      status: "sending",
      payload: sql`${messages.payload} || ${delivery}::jsonb`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.direction, "outbound"),
        or(
          eq(messages.status, "queued"),
          and(
            eq(messages.status, "sending"),
            sql`${messages.payload} -> 'delivery' ->> 'runId' = ${runId}`,
          ),
        ),
      ),
    )
    .returning({ sequence: messages.sequence });
  if (row !== undefined) return { kind: "claimed", sequence: row.sequence };
  const [current] = await ctx.tx
    .select({ status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return {
    kind: "done",
    reason: current === undefined ? "not_found" : `status_${current.status}`,
  };
}

/** True while an earlier outbound message of the conversation is still on its way. */
async function hasPendingPredecessor(
  ctx: BusinessContext,
  data: SendData,
  sequence: number,
): Promise<boolean> {
  const [earlier] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, data.conversationId),
        eq(messages.direction, "outbound"),
        lt(messages.sequence, sequence),
        inArray(messages.status, ["queued", "sending"]),
      ),
    )
    .limit(1);
  return earlier !== undefined;
}

/**
 * A free-form part is sent only when the window is still open this long from now: the
 * window may have closed since `prepare` (order waits, retries after a rate limit), and
 * Meta reports a closed window (131047) possibly only later, in a "failed" status, when no
 * template can replace the message any more.
 */
export const SEND_WINDOW_MARGIN_MS = 60_000;

const JournalEntry = z.object({
  runId: z.string(),
  externalMessageId: z.string().min(1),
  sentAt: z.string(),
});

/**
 * One part of an outbound message, in its own step. What the provider accepted is noted in
 * the message's `payload.sendJournal` before the step returns, so a re-run of the step whose
 * memoized result was lost (the answer to the job platform never arrived) returns it instead
 * of sending the part a second time. A crash between the provider's answer and that note, or
 * a provider timeout after it accepted the message, can still send twice (DECISIONS 168).
 */
export async function sendPart(
  p: PipelineContext,
  data: SendData,
  info: SendTargetInfo,
  part: OutboundMessage,
  index: number,
  runId: string,
): Promise<PartResult> {
  const adapter = p.adapters.find(info.channel);
  if (adapter === undefined) {
    return {
      ok: false,
      code: "no_adapter",
      message: "The channel is not available.",
      windowClosed: false,
    };
  }
  const journalKey = `${part.kind === "template" ? "t" : ""}${index}`;
  const scope = p.db.forBusiness(data.businessId, { agencyId: data.agencyId });
  const state = await scope.run(async (ctx) => {
    const [row] = await ctx.tx
      .select({
        payload: messages.payload,
        lastInboundAt: conversations.lastInboundAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, data.messageId))
      .limit(1);
    return row;
  });
  const journal: unknown = state?.payload["sendJournal"];
  const journaled = JournalEntry.safeParse(
    journal !== null && typeof journal === "object"
      ? (journal as Record<string, unknown>)[journalKey]
      : undefined,
  );
  if (journaled.success && journaled.data.runId === runId) {
    return {
      ok: true,
      externalMessageId: journaled.data.externalMessageId,
      sentAt: journaled.data.sentAt,
    };
  }
  if (part.kind !== "template") {
    // Invariant I6 checked again at the moment of sending, with the customer's latest message.
    const lastInboundAt = state?.lastInboundAt ?? null;
    const window = messagingWindow(
      adapter.capabilities,
      lastInboundAt === null ? null : new Date(lastInboundAt),
      new Date(p.clock().getTime() + SEND_WINDOW_MARGIN_MS),
      info.sentByHuman,
    );
    if (!window.open) {
      return {
        ok: false,
        code: "window_closed",
        message: "The messaging window closed before the message could be sent.",
        windowClosed: true,
      };
    }
  }
  const connection = await scope.run((ctx) =>
    loadConnectionContext(ctx, p.db, info.connectionId as ChannelConnectionId),
  );
  const target: SendTarget = {
    connection,
    conversationId: info.conversationId,
    recipientExternalId: info.recipientExternalId,
    externalThreadId: info.externalThreadId,
    replyToExternalMessageId: info.replyToExternalMessageId,
    window: info.window,
    email: info.email,
    idempotencyKey: `${data.messageId}:${part.kind === "template" ? "t" : ""}${index}`,
    sentByHuman: info.sentByHuman,
  };
  const result = await adapter.send(part, target);
  if (result.ok) {
    const entry = JSON.stringify({
      [journalKey]: { runId, externalMessageId: result.externalMessageId, sentAt: result.sentAt },
    });
    try {
      await scope.run(async (ctx) => {
        await ctx.tx
          .update(messages)
          .set({
            payload: sql`${messages.payload} || jsonb_build_object('sendJournal', coalesce(${messages.payload} -> 'sendJournal', '{}'::jsonb) || ${entry}::jsonb)`,
          })
          .where(and(eq(messages.id, data.messageId), eq(messages.status, "sending")));
      });
    } catch (error) {
      // The part went out: failing the step now would send it again on the retry.
      p.logger.warn("send.journal_failed", {
        traceId: data.traceId,
        businessId: data.businessId,
        messageId: data.messageId,
        error,
      });
    }
    return { ok: true, externalMessageId: result.externalMessageId, sentAt: result.sentAt };
  }
  const { error } = result;
  if (error.retryable && !error.windowClosed) {
    // Thrown, so the job platform retries this step (honouring retry-after).
    throw new ExternalServiceError(`Sending failed: ${error.code}`, {
      provider: info.channel,
      retryable: true,
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      details: { code: error.code },
    });
  }
  return {
    ok: false,
    code: error.windowClosed ? "window_closed" : error.code,
    message: error.message.slice(0, 500),
    windowClosed: error.windowClosed,
  };
}

/**
 * Asks the channel's window fallback for an approved template that may replace the message
 * now that the messaging window is closed (invariant I6). When it has one, the message row
 * becomes that template (kind, text the customer will see, the template in the payload, the
 * original text kept), so the inbox and the bot's history show what was really sent and a
 * retried run sends the same template. Null: no template, the message fails.
 */
async function resolveWindowFallback(
  p: PipelineContext,
  data: SendData,
  info: SendTargetInfo,
  author: "bot" | "human_agent",
  step: JobContext<SendData>["step"],
): Promise<Extract<OutboundMessage, { kind: "template" }> | null> {
  const resolver = p.windowFallbacks.find((item) => item.channel === info.channel);
  if (resolver === undefined) return null;
  const result = await step.run("window-fallback", () =>
    resolver.resolve({
      agencyId: data.agencyId,
      businessId: data.businessId,
      connectionId: info.connectionId as ChannelConnectionId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      author,
    }),
  );
  if (result.kind === "none") {
    p.logger.info("send.window_fallback_none", {
      traceId: data.traceId,
      businessId: data.businessId,
      messageId: data.messageId,
      reason: result.reason,
    });
    return null;
  }
  await step.run("window-fallback-record", () =>
    p.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
      const fallback = JSON.stringify({
        template: {
          templateName: result.message.templateName,
          languageCode: result.message.languageCode,
          variables: result.message.variables,
          ...(result.message.namedVariables === undefined
            ? {}
            : { namedVariables: result.message.namedVariables }),
        },
      });
      await ctx.tx
        .update(messages)
        .set({
          kind: "template",
          text: result.renderedText,
          payload: sql`${messages.payload} || ${fallback}::jsonb || jsonb_build_object('windowFallback', jsonb_build_object('originalKind', ${messages.kind}::text, 'originalText', ${messages.text}::text))`,
        })
        .where(and(eq(messages.id, data.messageId), eq(messages.status, "sending")));
      return null;
    }),
  );
  return result.message;
}

/**
 * Marks the message failed for good: status, dead letter, in-app alert, and the
 * `message.send_failed` event to emit (invariant I7: never dropped silently).
 */
export async function markSendFailed(
  ctx: BusinessContext,
  p: PipelineContext,
  data: SendData,
  failure: { readonly code: string; readonly message: string; readonly retryable: boolean | null },
  eventId: string | null,
): Promise<AnyJobEvent | null> {
  const [row] = await ctx.tx
    .update(messages)
    .set({
      status: "failed",
      failedAt: p.clock(),
      errorCode: failure.code.slice(0, 100),
      errorMessage: failure.message.slice(0, 1000),
    })
    .where(and(eq(messages.id, data.messageId), inArray(messages.status, ["queued", "sending"])))
    .returning({ id: messages.id });
  if (row === undefined) return null;
  await recordDeadLetter(ctx, {
    source: SEND_FUNCTION_ID,
    eventName: "message.send_requested",
    eventId,
    traceId: data.traceId,
    conversationId: data.conversationId,
    messageId: data.messageId,
    errorCode: failure.code,
    errorMessage: failure.message,
    retryable: failure.retryable,
    attempts: 1,
    payload: { ...data },
  });
  await raiseInAppAlert(ctx, {
    kind: "send_failed",
    severity: "warning",
    conversationId: data.conversationId,
    subject: "A message could not be sent.",
    dedupeKey: `send_failed:${data.messageId}`,
    payload: { messageId: data.messageId, channel: data.channel, errorCode: failure.code },
  });
  p.logger.warn("send.failed", {
    traceId: data.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    messageId: data.messageId,
    errorCode: failure.code,
  });
  return jobEvent("message.send_failed", sendFailedEventId(data.messageId), {
    traceId: data.traceId,
    agencyId: data.agencyId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    messageId: data.messageId,
    channel: data.channel,
    errorCode: failure.code.slice(0, 100) || "send_failed",
  });
}

async function markSent(
  ctx: BusinessContext,
  p: PipelineContext,
  data: SendData,
  runId: string,
  parts: readonly Extract<PartResult, { ok: true }>[],
): Promise<void> {
  const first = parts[0]!;
  const delivery = JSON.stringify({
    delivery: { runId, parts: parts.map((part) => part.externalMessageId) },
  });
  const now = p.clock();
  await ctx.tx
    .update(messages)
    .set({
      status: "sent",
      externalMessageId: first.externalMessageId,
      sentAt: new Date(first.sentAt),
      // The parts are recorded now; the journal of the send steps is no longer needed.
      payload: sql`(${messages.payload} - 'sendJournal') || ${delivery}::jsonb`,
    })
    .where(and(eq(messages.id, data.messageId), eq(messages.status, "sending")));
  await ctx.tx
    .update(conversations)
    .set({
      lastOutboundAt: sql`greatest(${conversations.lastOutboundAt}, ${now.toISOString()}::timestamptz)`,
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(eq(conversations.id, data.conversationId));
}

/**
 * One outbound message (ARCHITECTURE §2, steps 15 to 17): claim it, wait for the messages
 * before it, decide whether it may leave, send it part by part with retries, record the
 * result. Concurrency 1 per conversation plus the predecessor check keep a conversation's
 * messages in order (invariant I4).
 */
export async function runSend(
  p: PipelineContext,
  { event, step, runId, logger }: JobContext<SendData>,
): Promise<{ readonly outcome: string }> {
  const data = event.data;
  const scope = () => p.db.forBusiness(data.businessId, { agencyId: data.agencyId });
  const log = logger.child({
    traceId: data.traceId,
    businessId: data.businessId,
    messageId: data.messageId,
  });

  const claim = await step.run("claim", () =>
    scope().run((ctx) => claimSend(ctx, data.messageId, runId)),
  );
  if (claim.kind === "done") return { outcome: claim.reason };

  const waits = p.options.orderWaitsMs;
  for (let attempt = 0; ; attempt += 1) {
    const blocked = await step.run(`order-${attempt}`, () =>
      scope().run((ctx) => hasPendingPredecessor(ctx, data, claim.sequence)),
    );
    if (!blocked) break;
    const delay = waits[attempt];
    if (delay === undefined) {
      throw new AppError(
        "conflict",
        "An earlier message of the conversation is still being sent.",
        {
          retryable: true,
        },
      );
    }
    await step.sleep(`order-wait-${attempt}`, delay);
  }

  const plan = await step.run("prepare", () =>
    scope().run((ctx) => prepareSend(ctx, p, data.messageId)),
  );
  if (plan.kind === "done") return { outcome: plan.reason };

  let failure: { code: string; message: string; retryable: boolean | null } | null =
    plan.kind === "fail" ? { code: plan.code, message: plan.message, retryable: false } : null;
  const sent: Extract<PartResult, { ok: true }>[] = [];

  if (plan.kind === "send" || plan.kind === "window_closed") {
    let parts: readonly OutboundMessage[] = plan.kind === "send" ? plan.parts : [];
    let prefix = "send";
    // Asked at most once: when the window is known to be closed, or when the provider says
    // so for the first part of a free-form message.
    let fallbackAsked = false;
    const fallback = async (): Promise<boolean> => {
      fallbackAsked = true;
      const resolved = await resolveWindowFallback(p, data, plan.target, plan.author, step);
      if (resolved === null) return false;
      parts = [resolved];
      prefix = "send-fallback";
      return true;
    };
    if (plan.kind === "window_closed" && !(await fallback())) {
      failure = {
        code: "window_closed",
        message: "The messaging window is closed and no approved template can replace the message.",
        retryable: false,
      };
    }
    const target = plan.target;
    for (let index = 0; failure === null && index < parts.length; index += 1) {
      const part = parts[index]!;
      const result = await step.run(`${prefix}-${index}`, () =>
        sendPart(p, data, target, part, index, runId),
      );
      if (result.ok) {
        sent.push(result);
        continue;
      }
      const canFallBack =
        result.windowClosed &&
        index === 0 &&
        !fallbackAsked &&
        plan.kind === "send" &&
        plan.freeForm &&
        p.windowFallbacks.some((item) => item.channel === target.channel);
      if (canFallBack && (await fallback())) {
        index = -1;
        continue;
      }
      failure = { code: result.code, message: result.message, retryable: false };
    }
  }

  const connectionId = plan.kind === "fail" ? null : plan.target.connectionId;
  const failedEvent = await step.run("finish", () =>
    scope().run(async (ctx) => {
      // Every provider message that went out is recorded, also when a later part failed, so
      // its delivery statuses count; statuses that arrived first are applied now.
      if (connectionId !== null && sent.length > 0) {
        await recordParts(ctx, data.messageId, connectionId, sent);
      }
      let failedNow: AnyJobEvent | null = null;
      if (failure === null) await markSent(ctx, p, data, runId, sent);
      else failedNow = await markSendFailed(ctx, p, data, failure, event.id);
      if (connectionId !== null && sent.length > 0) {
        await applyHeldStatuses(
          ctx,
          connectionId,
          sent.map((part) => part.externalMessageId),
        );
      }
      return failedNow;
    }),
  );
  if (failedEvent !== null) {
    await step.run("emit-failure", async () => {
      await p.events.send([failedEvent]);
      return null;
    });
    return { outcome: "failed" };
  }
  log.debug("send.sent", { parts: sent.length });
  return { outcome: "sent" };
}

export function sendJob(p: PipelineContext): EventJobDefinition<"message.send_requested"> {
  return defineEventJob({
    id: SEND_FUNCTION_ID,
    name: "Send a message",
    retries: p.options.sendRetries,
    trigger: { event: "message.send_requested" },
    concurrency: { key: "event.data.conversationId", limit: 1 },
    handler: (ctx) => runSend(p, ctx),
    onFailure: async ({ event, error }) => {
      const failed = await p.db
        .forBusiness(event.data.businessId, { agencyId: event.data.agencyId })
        .run((ctx) =>
          markSendFailed(
            ctx,
            p,
            event.data,
            { code: error.code ?? "send_failed", message: error.message, retryable: true },
            event.id,
          ),
        );
      if (failed !== null) await p.events.send([failed]);
    },
  });
}
