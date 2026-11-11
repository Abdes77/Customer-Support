import type { BusinessRef } from "@repo/db";
import {
  and,
  conversations,
  conversationTurns,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  messages,
} from "@repo/db";
import {
  type AnyJobEvent,
  type CronJobDefinition,
  defineCronJob,
  describeJobError,
  jobEvent,
} from "@repo/jobs";

import type { PipelineContext } from "./deps";
import { receivedEventId, sendSweepEventId } from "./event-ids";
import { raiseInAppAlert, recordDeadLetter } from "./failures";

export const SWEEPER_FUNCTION_ID = "pipeline-sweeper";

const BATCH = 200;

export interface SweepResult {
  readonly reEnqueued: number;
  readonly reSent: number;
  readonly leasesReleased: number;
}

/**
 * One business's sweep (ARCHITECTURE §2, step 6, and §4):
 * - inbound messages whose `message.received` was never emitted (the webhook crashed between
 *   storing and emitting) are emitted again, with the same event id;
 * - outbound messages still `queued` long after they were stored (their send event was lost)
 *   get a new send event;
 * - turn leases that expired (the run crashed) are released and their turns marked failed,
 *   so the next message is answered without delay.
 */
export async function sweepBusiness(
  p: PipelineContext,
  business: BusinessRef,
): Promise<SweepResult> {
  const now = p.clock();
  const scope = p.db.forBusiness(business.businessId, { agencyId: business.agencyId });

  const found = await scope.run(async (ctx) => {
    const unenqueued = await ctx.tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        traceId: messages.traceId,
        createdAt: messages.createdAt,
        channel: conversations.channel,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.direction, "inbound"),
          isNull(messages.enqueuedAt),
          lt(
            messages.createdAt,
            new Date(now.getTime() - p.options.sweepUnenqueuedAfterSeconds * 1000),
          ),
        ),
      )
      .orderBy(messages.createdAt)
      .limit(BATCH);
    const stuck = await ctx.tx
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        traceId: messages.traceId,
        channel: conversations.channel,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "queued"),
          lt(
            messages.createdAt,
            new Date(now.getTime() - p.options.sweepQueuedAfterSeconds * 1000),
          ),
        ),
      )
      .orderBy(messages.createdAt)
      .limit(BATCH);
    const expired = await ctx.tx
      .update(conversations)
      .set({ turnLeaseOwner: null, turnLeaseExpiresAt: null })
      .where(
        and(isNotNull(conversations.turnLeaseOwner), lt(conversations.turnLeaseExpiresAt, now)),
      )
      .returning({ id: conversations.id });
    if (expired.length > 0) {
      // A turn whose conversation no longer has a lease cannot commit any more. Its customer
      // messages stay unanswered until the next one arrives, so the turn is flagged: a dead
      // letter and an in-app alert, like a turn that failed for good.
      const failed = await ctx.tx
        .update(conversationTurns)
        .set({
          status: "failed",
          errorCode: "lease_expired",
          errorMessage: "The turn lease expired before the turn finished.",
          completedAt: now,
        })
        .where(
          and(
            inArray(
              conversationTurns.conversationId,
              expired.map((row) => row.id),
            ),
            eq(conversationTurns.status, "running"),
          ),
        )
        .returning({
          id: conversationTurns.id,
          conversationId: conversationTurns.conversationId,
          traceId: conversationTurns.traceId,
          runId: conversationTurns.runId,
        });
      for (const turn of failed) {
        await recordDeadLetter(ctx, {
          source: SWEEPER_FUNCTION_ID,
          eventName: null,
          eventId: null,
          traceId: turn.traceId,
          conversationId: turn.conversationId,
          messageId: null,
          errorCode: "lease_expired",
          errorMessage: "The turn lease expired before the turn finished.",
          retryable: null,
          attempts: 1,
          payload: { turnId: turn.id, runId: turn.runId, conversationId: turn.conversationId },
        });
        await raiseInAppAlert(ctx, {
          kind: "turn_failed",
          severity: "warning",
          conversationId: turn.conversationId,
          subject: "The bot could not answer a conversation.",
          dedupeKey: `turn_failed:${turn.id}`,
          payload: { turnId: turn.id, conversationId: turn.conversationId },
        });
      }
    }
    return { unenqueued, stuck, expired: expired.length };
  });

  const minute = Math.floor(now.getTime() / 60_000);
  const events: AnyJobEvent[] = [
    ...found.unenqueued.map((row) =>
      jobEvent("message.received", receivedEventId(row.id), {
        traceId: row.traceId,
        agencyId: business.agencyId,
        businessId: business.businessId,
        conversationId: row.conversationId,
        messageId: row.id,
        channel: row.channel,
        receivedAt: row.createdAt.toISOString(),
      }),
    ),
    ...found.stuck.map((row) =>
      jobEvent("message.send_requested", sendSweepEventId(row.id, minute), {
        traceId: row.traceId,
        agencyId: business.agencyId,
        businessId: business.businessId,
        conversationId: row.conversationId,
        messageId: row.id,
        channel: row.channel,
      }),
    ),
  ];
  if (events.length > 0) await p.events.send(events);
  if (found.unenqueued.length > 0) {
    await scope.run(async (ctx) => {
      await ctx.tx
        .update(messages)
        .set({ enqueuedAt: now })
        .where(
          and(
            inArray(
              messages.id,
              found.unenqueued.map((row) => row.id),
            ),
            isNull(messages.enqueuedAt),
          ),
        );
    });
  }
  if (events.length > 0 || found.expired > 0) {
    p.logger.warn("sweeper.recovered", {
      businessId: business.businessId,
      reEnqueued: found.unenqueued.length,
      reSent: found.stuck.length,
      leasesReleased: found.expired,
    });
  }
  return {
    reEnqueued: found.unenqueued.length,
    reSent: found.stuck.length,
    leasesReleased: found.expired,
  };
}

export function sweeperJob(p: PipelineContext): CronJobDefinition {
  return defineCronJob({
    id: SWEEPER_FUNCTION_ID,
    name: "Recover lost pipeline work",
    retries: 1,
    trigger: { cron: "* * * * *" },
    handler: async ({ step }) => {
      const list = await step.run("businesses", () =>
        p.db.directory.listBusinesses({ statuses: ["onboarding", "active", "paused"] }),
      );
      const totals = { reEnqueued: 0, reSent: 0, leasesReleased: 0 };
      for (const business of list) {
        // One business's failure must not stop the others from being swept, now or in the
        // runs after this one (a failing step would fail the run at the same business every
        // minute). It is logged and raised as an alert; the next run tries again.
        const result = await step.run(`sweep-${business.businessId}`, () =>
          sweepBusiness(p, business).catch(async (error: unknown) => {
            await recordSweepFailure(p, business, error);
            return { reEnqueued: 0, reSent: 0, leasesReleased: 0 } satisfies SweepResult;
          }),
        );
        totals.reEnqueued += result.reEnqueued;
        totals.reSent += result.reSent;
        totals.leasesReleased += result.leasesReleased;
      }
      return totals;
    },
    onFailure: async ({ error, runId }) => {
      // Only listing the businesses can fail the run, and there is no business to file it under.
      p.logger.error("sweeper.failed", { runId, error });
    },
  });
}

async function recordSweepFailure(
  p: PipelineContext,
  business: BusinessRef,
  error: unknown,
): Promise<void> {
  const described = describeJobError(error);
  p.logger.error("sweeper.business_failed", { businessId: business.businessId, error: described });
  try {
    // One alert per business and day: the sweep runs every minute.
    const day = p.clock().toISOString().slice(0, 10);
    await p.db.forBusiness(business.businessId, { agencyId: business.agencyId }).run((ctx) =>
      raiseInAppAlert(ctx, {
        kind: "sweeper_failed",
        severity: "warning",
        conversationId: null,
        subject: "Recovering lost pipeline work failed for this business.",
        dedupeKey: `sweeper_failed:${day}`,
        payload: { errorCode: described.code },
      }),
    );
  } catch (alertError) {
    p.logger.error("sweeper.alert_failed", {
      businessId: business.businessId,
      error: describeJobError(alertError),
    });
  }
}
