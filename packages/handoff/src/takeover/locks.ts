import type { ConversationId, TraceId, UserId } from "@repo/core";
import {
  and,
  type BusinessContext,
  type BusinessTenant,
  eq,
  isNull,
  recordSystemAudit,
  takeoverLocks,
  type TakeoverSource,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import type { AppSettings } from "@repo/settings";

/*
 * Takeover locks (invariant I5: the bot never sends while a person holds the conversation).
 * A conversation has at most one active lock (a partial unique index). The pipeline's guards
 * read the lock; this module starts, extends and releases it, and announces each change.
 */

/** The same ids the pipeline gives its takeover events (`takeover-started-<lock id>`). */
export const takeoverStartedEventId = (lockId: string) => `takeover-started-${lockId}`;
export const takeoverReleasedEventId = (lockId: string) => `takeover-released-${lockId}`;
export const checkInRequestId = (lockId: string) => `release-${lockId}`;

export interface ActiveLock {
  readonly id: string;
  readonly source: TakeoverSource;
  readonly userId: UserId | null;
  readonly reason: string | null;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
}

export async function activeLock(
  ctx: BusinessContext,
  conversationId: ConversationId,
  lock: "update" | "none" = "none",
): Promise<ActiveLock | null> {
  const query = ctx.tx
    .select({
      id: takeoverLocks.id,
      source: takeoverLocks.source,
      userId: takeoverLocks.userId,
      reason: takeoverLocks.reason,
      startedAt: takeoverLocks.startedAt,
      lastActivityAt: takeoverLocks.lastActivityAt,
    })
    .from(takeoverLocks)
    .where(and(eq(takeoverLocks.conversationId, conversationId), isNull(takeoverLocks.releasedAt)))
    .limit(1);
  const [row] = lock === "update" ? await query.for("update") : await query;
  return row ?? null;
}

export function takeoverStartedEvent(
  tenant: BusinessTenant,
  input: {
    readonly lockId: string;
    readonly conversationId: ConversationId;
    readonly traceId: string;
    readonly userId: UserId | null;
    readonly source: TakeoverSource;
  },
): AnyJobEvent {
  return jobEvent("conversation.takeover_started", takeoverStartedEventId(input.lockId), {
    traceId: input.traceId as TraceId,
    agencyId: tenant.agencyId,
    businessId: tenant.businessId,
    conversationId: input.conversationId,
    userId: input.userId,
    source: input.source,
  });
}

/**
 * Starts a takeover unless one is active. `exemptThroughSeq` lets the bot's messages up to that
 * sequence still go out (the bot's own handoff message). Returns the new lock and its event,
 * or null when a person already holds the conversation (its activity is moved forward).
 */
export async function startTakeover(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly source: TakeoverSource;
    readonly userId: UserId | null;
    readonly reason: string;
    readonly traceId: string;
    readonly now: Date;
    readonly exemptThroughSeq?: number | null;
  },
): Promise<{ readonly lockId: string; readonly event: AnyJobEvent } | null> {
  const existing = await activeLock(ctx, input.conversationId, "update");
  if (existing !== null) {
    await ctx.tx
      .update(takeoverLocks)
      .set({ lastActivityAt: input.now })
      .where(eq(takeoverLocks.id, existing.id));
    return null;
  }
  const [row] = await ctx.tx
    .insert(takeoverLocks)
    .values({
      ...ctx.tenant,
      conversationId: input.conversationId,
      userId: input.userId,
      source: input.source,
      reason: input.reason.slice(0, 500),
      startedAt: input.now,
      lastActivityAt: input.now,
      exemptThroughSeq: input.exemptThroughSeq ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: takeoverLocks.id });
  if (row === undefined) return null;
  await recordSystemAudit(
    ctx,
    input.userId === null
      ? { type: "system", label: `handoff:${input.source}` }
      : { type: "user", userId: input.userId },
    {
      action: "conversation.takeover",
      targetType: "conversation",
      targetId: input.conversationId,
      summary:
        input.source === "admin_panel"
          ? "A person took the conversation over."
          : "The conversation was handed to a person.",
      metadata: { lockId: row.id, source: input.source },
      traceId: input.traceId as TraceId,
    },
  );
  return {
    lockId: row.id,
    event: takeoverStartedEvent(ctx.tenant, {
      lockId: row.id,
      conversationId: input.conversationId,
      traceId: input.traceId,
      userId: input.userId,
      source: input.source,
    }),
  };
}

/** A person or the customer wrote: the idle release counts from now. */
export async function touchTakeover(
  ctx: BusinessContext,
  conversationId: ConversationId,
  now: Date,
): Promise<boolean> {
  const rows = await ctx.tx
    .update(takeoverLocks)
    .set({ lastActivityAt: now })
    .where(and(eq(takeoverLocks.conversationId, conversationId), isNull(takeoverLocks.releasedAt)))
    .returning({ id: takeoverLocks.id });
  return rows.length > 0;
}

/**
 * Releases the active lock (a person's "give back to the bot", or the idle timeout). For the
 * idle timeout the caller names the lock and the activity it saw, and the release happens only
 * if neither changed since (a message in between keeps the person in charge). Returns the
 * events to emit: the release, and with `handoff.on_release` = check-in a requested turn
 * (the engine checks in only when the customer's last message is unanswered).
 */
export async function releaseTakeover(
  ctx: BusinessContext,
  input: {
    readonly conversationId: ConversationId;
    readonly reason: "manual" | "idle_timeout";
    readonly userId: UserId | null;
    readonly traceId: string;
    readonly now: Date;
    readonly values: AppSettings;
    readonly expect?: { readonly lockId: string; readonly lastActivityAt: Date };
  },
): Promise<{ readonly lockId: string; readonly events: AnyJobEvent[] } | null> {
  const lock = await activeLock(ctx, input.conversationId, "update");
  if (lock === null) return null;
  if (
    input.expect !== undefined &&
    (lock.id !== input.expect.lockId ||
      lock.lastActivityAt.getTime() !== input.expect.lastActivityAt.getTime())
  ) {
    return null;
  }
  await ctx.tx
    .update(takeoverLocks)
    .set({ releasedAt: input.now, releasedBy: input.userId, releaseReason: input.reason })
    .where(eq(takeoverLocks.id, lock.id));
  await recordSystemAudit(
    ctx,
    input.userId === null
      ? { type: "system", label: "handoff:idle_release" }
      : { type: "user", userId: input.userId },
    {
      action: "conversation.release",
      targetType: "conversation",
      targetId: input.conversationId,
      summary:
        input.reason === "manual"
          ? "The conversation was given back to the bot."
          : "The conversation went back to the bot after the idle time.",
      metadata: { lockId: lock.id, reason: input.reason },
      traceId: input.traceId as TraceId,
    },
  );
  const events: AnyJobEvent[] = [
    jobEvent("conversation.takeover_released", takeoverReleasedEventId(lock.id), {
      traceId: input.traceId as TraceId,
      agencyId: ctx.tenant.agencyId,
      businessId: ctx.tenant.businessId,
      conversationId: input.conversationId,
      userId: input.userId,
      source: input.reason,
    }),
  ];
  if (input.values["handoff.on_release"] === "check_in") {
    events.push(
      jobEvent("conversation.turn_requested", `turn-${checkInRequestId(lock.id)}`, {
        traceId: input.traceId as TraceId,
        agencyId: ctx.tenant.agencyId,
        businessId: ctx.tenant.businessId,
        conversationId: input.conversationId,
        trigger: "takeover_released",
        requestId: checkInRequestId(lock.id),
      }),
    );
  }
  return { lockId: lock.id, events };
}
