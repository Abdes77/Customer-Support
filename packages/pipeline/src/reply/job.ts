import { randomUUID } from "node:crypto";

import { AppError, type EventPayload } from "@repo/core";
import { and, conversations, conversationTurns, eq } from "@repo/db";
import {
  defineEventJob,
  type EventJobDefinition,
  type JobContext,
  type StepTools,
} from "@repo/jobs";

import type { PipelineContext } from "../deps";
import { raiseInAppAlert, recordDeadLetter } from "../failures";
import { downloadAttachment, enrichAttachment } from "./attachments";
import { claimRequestedTurn, claimTurn, type ClaimResult, planTurn } from "./claim";
import { commitTurn, releaseLease } from "./commit";
import { generateTurn } from "./generate";
import { showPresence } from "./presence";

type ReceivedData = EventPayload<"message.received">;
type RequestedData = EventPayload<"conversation.turn_requested">;

export const REPLY_FUNCTION_ID = "pipeline-reply";
export const REQUESTED_TURN_FUNCTION_ID = "pipeline-requested-turn";

export interface ReplyRunOutcome {
  readonly outcome: string;
  readonly turnId: string | null;
  readonly messageIds: readonly string[];
}

/**
 * One reply turn for one conversation (ARCHITECTURE §2, steps 8 to 14). Inngest debounces
 * the trigger per conversation and lets one step of a conversation run at a time; the turn
 * lease, the watermark and the stale check in PostgreSQL make the result correct even when
 * runs overlap, repeat or arrive out of order.
 */
export async function runReplyTurn(
  p: PipelineContext,
  { event, step, runId, logger }: JobContext<ReceivedData>,
): Promise<ReplyRunOutcome> {
  const data = event.data;
  const log = logger.child({
    traceId: data.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
  });
  const scope = () => p.db.forBusiness(data.businessId, { agencyId: data.agencyId });
  const scopeTenant = { agencyId: data.agencyId, businessId: data.businessId };

  const plan = await step.run("plan", () => scope().run((ctx) => planTurn(ctx, p, data)));
  if (plan.kind === "done") return { outcome: plan.reason, turnId: null, messageIds: [] };
  // Several quick messages get one reply: wait, then give way if a newer one arrived.
  await step.sleepUntil("reply-wait", new Date(plan.waitUntil));

  let claim: ClaimResult;
  const waits = p.options.leaseWaitsMs;
  // A busy lease is a live one (an expired lease is taken over). Its holder renews it once,
  // when it starts generating, so it holds the conversation for at most about two leases.
  const leaseDeadline = 2 * p.options.leaseSeconds * 1000 + 60_000;
  for (let attempt = 0, waited = 0; ; attempt += 1) {
    claim = await step.run(`claim-${attempt}`, () =>
      scope().run((ctx) => claimTurn(ctx, p, data, plan, runId)),
    );
    if (claim.kind !== "busy") break;
    if (waited > leaseDeadline) {
      // Cannot happen while leases expire; kept as a hard stop for the loop.
      throw new AppError("conflict", "The conversation's turn lease stayed busy.", {
        retryable: true,
      });
    }
    const delay = waits[Math.min(attempt, waits.length - 1)] ?? 1000;
    waited += delay;
    await step.sleep(`lease-wait-${attempt}`, delay);
  }
  if (claim.kind === "done") return { outcome: claim.reason, turnId: null, messageIds: [] };
  if (claim.kind === "skipped") {
    await emitSkipped(p, step, claim);
    return { outcome: `skipped:${claim.reason}`, turnId: claim.turnId, messageIds: [] };
  }
  const claimed = claim;

  for (const attachmentId of claimed.attachmentIds) {
    await step.run(`attachment-${attachmentId}`, () =>
      downloadAttachment(p, data, claimed.channel, attachmentId),
    );
  }
  // Voice messages and the like become text the engine can read (C9).
  if (p.attachmentEnrichers.some((item) => item.channel === claimed.channel)) {
    for (const attachmentId of claimed.attachmentIds) {
      await step.run(`enrich-${attachmentId}`, () =>
        enrichAttachment(p, data, claimed.channel, attachmentId),
      );
    }
  }
  await step.run("presence-on", () => showPresence(p, data, claimed, "on", log));

  const generated = await step.run("generate", () => generateTurn(p, data, claimed, log));
  const commit = await step.run("commit", () =>
    scope().run((ctx) => commitTurn(ctx, p, data, claimed, generated)),
  );
  if (commit.events.length > 0) {
    await step.run("emit", async () => {
      await p.events.send(commit.events);
      // Observers mark what they handed over as sent (C5's outbox); best effort.
      for (const observer of p.observers) {
        await observer.emitted?.(scopeTenant, commit.events, p.clock());
      }
      return null;
    });
  }
  if (commit.status !== "replied") {
    await step.run("presence-off", () => showPresence(p, data, claimed, "off", log));
  }
  return { outcome: commit.status, turnId: claimed.turnId, messageIds: commit.messageIds };
}

/** Sends what the guard that stopped a turn asked for (C17: a limit's notice and alerts). */
async function emitSkipped(
  p: PipelineContext,
  step: StepTools,
  claim: Extract<ClaimResult, { kind: "skipped" }>,
): Promise<void> {
  const events = claim.events ?? [];
  if (events.length === 0) return;
  await step.run("emit-skipped", async () => {
    await p.events.send(events);
    return null;
  });
}

/**
 * The run failed for good: free the conversation (so the next message is answered without
 * waiting for the lease to expire), close the turn, and leave a dead letter and an alert.
 */
export async function onReplyFailure(
  p: PipelineContext,
  data: ReceivedData,
  failure: {
    readonly runId: string;
    readonly error: { readonly message: string; readonly code: string | null };
  },
  eventId: string | null,
): Promise<void> {
  await p.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
    // Lock the conversation before touching its turns (the order the claim and the sweeper use).
    await ctx.tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, data.conversationId))
      .for("update");
    const turns = await ctx.tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, data.conversationId),
          eq(conversationTurns.runId, failure.runId),
          eq(conversationTurns.status, "running"),
        ),
      );
    for (const turn of turns) {
      await ctx.tx
        .update(conversationTurns)
        .set({
          status: "failed",
          errorCode: failure.error.code ?? "run_failed",
          errorMessage: failure.error.message.slice(0, 1000),
          completedAt: p.clock(),
        })
        .where(eq(conversationTurns.id, turn.id));
      await releaseLease(ctx, turn.id, null);
    }
    await recordDeadLetter(ctx, {
      source: REPLY_FUNCTION_ID,
      eventName: "message.received",
      eventId,
      traceId: data.traceId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      errorCode: failure.error.code,
      errorMessage: failure.error.message,
      retryable: null,
      attempts: p.options.replyRetries + 1,
      payload: { ...data },
    });
    await raiseInAppAlert(ctx, {
      kind: "turn_failed",
      severity: "warning",
      conversationId: data.conversationId,
      subject: "The bot could not answer a conversation.",
      dedupeKey: `turn_failed:run:${failure.runId}`,
      payload: { runId: failure.runId, conversationId: data.conversationId },
    });
  });
  p.logger.error("turn.failed", {
    traceId: data.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    error: failure.error,
  });
}

export function replyJob(p: PipelineContext): EventJobDefinition<"message.received"> {
  return defineEventJob({
    id: REPLY_FUNCTION_ID,
    name: "Reply to a conversation",
    retries: p.options.replyRetries,
    trigger: { event: "message.received" },
    debounce: {
      key: "event.data.conversationId",
      period: p.options.debounce.period,
      timeout: p.options.debounce.timeout,
    },
    concurrency: { key: "event.data.conversationId", limit: 1 },
    handler: (ctx) => runReplyTurn(p, ctx),
    onFailure: ({ event, error, runId }) =>
      onReplyFailure(p, event.data, { runId, error }, event.id),
  });
}

/**
 * A turn no customer message started (C13): a follow-up to a customer who went quiet, a
 * check-in the bot scheduled, or picking the conversation up after a person released it. The
 * same claim (lease, turn row, guards with the turn's trigger), generate and commit steps as a
 * reply turn, without the debounce wait and with nothing pending; the engine decides what, if
 * anything, is due. A customer message that is still unanswered, or arrives while the turn is
 * written, wins: the reply run answers it and the requested turn sends nothing.
 */
export async function runRequestedTurn(
  p: PipelineContext,
  { event, step, runId, logger }: JobContext<RequestedData>,
): Promise<ReplyRunOutcome> {
  const data = event.data;
  const log = logger.child({
    traceId: data.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    trigger: data.trigger,
  });
  const scope = () => p.db.forBusiness(data.businessId, { agencyId: data.agencyId });
  const scopeTenant = { agencyId: data.agencyId, businessId: data.businessId };
  // The turn's id is fixed once, so a retried claim finds its own turn.
  const turnId = await step.run("plan", () => Promise.resolve(randomUUID()));

  let claim: ClaimResult;
  const waits = p.options.leaseWaitsMs;
  const leaseDeadline = 2 * p.options.leaseSeconds * 1000 + 60_000;
  for (let attempt = 0, waited = 0; ; attempt += 1) {
    claim = await step.run(`claim-${attempt}`, () =>
      scope().run((ctx) => claimRequestedTurn(ctx, p, data, turnId, runId)),
    );
    if (claim.kind !== "busy") break;
    if (waited > leaseDeadline) {
      throw new AppError("conflict", "The conversation's turn lease stayed busy.", {
        retryable: true,
      });
    }
    const delay = waits[Math.min(attempt, waits.length - 1)] ?? 1000;
    waited += delay;
    await step.sleep(`lease-wait-${attempt}`, delay);
  }
  if (claim.kind === "done") return { outcome: claim.reason, turnId: null, messageIds: [] };
  if (claim.kind === "skipped") {
    await emitSkipped(p, step, claim);
    return { outcome: `skipped:${claim.reason}`, turnId: claim.turnId, messageIds: [] };
  }
  const claimed = claim;
  const turnData = { ...data, messageId: null };

  const generated = await step.run("generate", () => generateTurn(p, data, claimed, log));
  const commit = await step.run("commit", () =>
    scope().run((ctx) => commitTurn(ctx, p, turnData, claimed, generated)),
  );
  if (commit.events.length > 0) {
    await step.run("emit", async () => {
      await p.events.send(commit.events);
      for (const observer of p.observers) {
        await observer.emitted?.(scopeTenant, commit.events, p.clock());
      }
      return null;
    });
  }
  return { outcome: commit.status, turnId: claimed.turnId, messageIds: commit.messageIds };
}

/** A requested turn failed for good: free the conversation, close the turn, leave a record. */
export async function onRequestedTurnFailure(
  p: PipelineContext,
  data: RequestedData,
  failure: {
    readonly runId: string;
    readonly error: { readonly message: string; readonly code: string | null };
  },
  eventId: string | null,
): Promise<void> {
  await p.db.forBusiness(data.businessId, { agencyId: data.agencyId }).run(async (ctx) => {
    await ctx.tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, data.conversationId))
      .for("update");
    const turns = await ctx.tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, data.conversationId),
          eq(conversationTurns.runId, failure.runId),
          eq(conversationTurns.status, "running"),
        ),
      );
    for (const turn of turns) {
      await ctx.tx
        .update(conversationTurns)
        .set({
          status: "failed",
          errorCode: failure.error.code ?? "run_failed",
          errorMessage: failure.error.message.slice(0, 1000),
          completedAt: p.clock(),
        })
        .where(eq(conversationTurns.id, turn.id));
      await releaseLease(ctx, turn.id, null);
    }
    await recordDeadLetter(ctx, {
      source: REQUESTED_TURN_FUNCTION_ID,
      eventName: "conversation.turn_requested",
      eventId,
      traceId: data.traceId,
      conversationId: data.conversationId,
      messageId: null,
      errorCode: failure.error.code,
      errorMessage: failure.error.message,
      retryable: null,
      attempts: p.options.replyRetries + 1,
      payload: { ...data },
    });
    await raiseInAppAlert(ctx, {
      kind: "turn_failed",
      severity: "warning",
      conversationId: data.conversationId,
      subject:
        data.trigger === "follow_up"
          ? "The bot could not send a follow-up."
          : "The bot could not pick a conversation up after it was released.",
      dedupeKey: `turn_failed:run:${failure.runId}`,
      payload: { runId: failure.runId, conversationId: data.conversationId },
    });
  });
  p.logger.error("turn.requested_failed", {
    traceId: data.traceId,
    businessId: data.businessId,
    conversationId: data.conversationId,
    trigger: data.trigger,
    error: failure.error,
  });
}

export function requestedTurnJob(
  p: PipelineContext,
): EventJobDefinition<"conversation.turn_requested"> {
  return defineEventJob({
    id: REQUESTED_TURN_FUNCTION_ID,
    name: "Follow up or check in on a conversation",
    retries: p.options.replyRetries,
    trigger: { event: "conversation.turn_requested" },
    concurrency: { key: "event.data.conversationId", limit: 1 },
    handler: (ctx) => runRequestedTurn(p, ctx),
    onFailure: ({ event, error, runId }) =>
      onRequestedTurnFailure(p, event.data, { runId, error }, event.id),
  });
}
