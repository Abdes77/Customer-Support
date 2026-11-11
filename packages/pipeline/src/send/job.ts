import {
  AppError,
  type ChannelConnectionId,
  type EventPayload,
  ExternalServiceError,
  type MessageId,
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
import { prepareSend, type SendPlan } from "./prepare";

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

async function sendPart(
  p: PipelineContext,
  data: SendData,
  plan: Extract<SendPlan, { kind: "send" }>,
  index: number,
): Promise<PartResult> {
  const adapter = p.adapters.find(plan.target.channel);
  if (adapter === undefined) {
    return {
      ok: false,
      code: "no_adapter",
      message: "The channel is not available.",
      windowClosed: false,
    };
  }
  const connection = await p.db
    .forBusiness(data.businessId, { agencyId: data.agencyId })
    .run((ctx) =>
      loadConnectionContext(ctx, p.db, plan.target.connectionId as ChannelConnectionId),
    );
  const target: SendTarget = {
    connection,
    conversationId: plan.target.conversationId,
    recipientExternalId: plan.target.recipientExternalId,
    externalThreadId: plan.target.externalThreadId,
    replyToExternalMessageId: plan.target.replyToExternalMessageId,
    window: plan.target.window,
    email: plan.target.email,
    idempotencyKey: `${data.messageId}:${index}`,
    sentByHuman: plan.target.sentByHuman,
  };
  const part = plan.parts[index]!;
  const result = await adapter.send(part, target);
  if (result.ok) {
    return { ok: true, externalMessageId: result.externalMessageId, sentAt: result.sentAt };
  }
  const { error } = result;
  if (error.retryable && !error.windowClosed) {
    // Thrown, so the job platform retries this step (honouring retry-after).
    throw new ExternalServiceError(`Sending failed: ${error.code}`, {
      provider: plan.target.channel,
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
      payload: sql`${messages.payload} || ${delivery}::jsonb`,
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
  if (plan.kind === "send") {
    for (let index = 0; index < plan.parts.length; index += 1) {
      const result = await step.run(`send-${index}`, () => sendPart(p, data, plan, index));
      if (!result.ok) {
        failure = { code: result.code, message: result.message, retryable: false };
        break;
      }
      sent.push(result);
    }
  }

  const failedEvent = await step.run("finish", () =>
    scope().run(async (ctx) => {
      if (failure === null) {
        await markSent(ctx, p, data, runId, sent);
        return null;
      }
      return markSendFailed(ctx, p, data, failure, event.id);
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
