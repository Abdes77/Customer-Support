import { AppError, type EventPayload } from "@repo/core";
import { and, conversations, conversationTurns, eq } from "@repo/db";
import { defineEventJob, type EventJobDefinition, type JobContext } from "@repo/jobs";

import type { PipelineContext } from "../deps";
import { raiseInAppAlert, recordDeadLetter } from "../failures";
import { downloadAttachment } from "./attachments";
import { claimTurn, type ClaimResult, planTurn } from "./claim";
import { commitTurn, releaseLease } from "./commit";
import { generateTurn } from "./generate";
import { showPresence } from "./presence";

type ReceivedData = EventPayload<"message.received">;

export const REPLY_FUNCTION_ID = "pipeline-reply";

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
    return { outcome: `skipped:${claim.reason}`, turnId: claim.turnId, messageIds: [] };
  }
  const claimed = claim;

  for (const attachmentId of claimed.attachmentIds) {
    await step.run(`attachment-${attachmentId}`, () =>
      downloadAttachment(p, data, claimed.channel, attachmentId),
    );
  }
  await step.run("presence-on", () => showPresence(p, data, claimed, "on", log));

  const generated = await step.run("generate", () => generateTurn(p, data, claimed, log));
  const commit = await step.run("commit", () =>
    scope().run((ctx) => commitTurn(ctx, p, data, claimed, generated)),
  );
  if (commit.events.length > 0) {
    await step.run("emit", async () => {
      await p.events.send(commit.events);
      return null;
    });
  }
  if (commit.status !== "replied") {
    await step.run("presence-off", () => showPresence(p, data, claimed, "off", log));
  }
  return { outcome: commit.status, turnId: claimed.turnId, messageIds: commit.messageIds };
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
