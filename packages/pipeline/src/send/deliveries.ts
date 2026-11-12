import type { ChannelConnectionId, DeliveryStatusUpdate, MessageId } from "@repo/core";
import {
  and,
  asc,
  type BusinessContext,
  eq,
  inArray,
  messageParts,
  messages,
  type MessageStatus,
  pendingDeliveryStatuses,
  sql,
} from "@repo/db";

/*
 * Delivery statuses of outbound messages (ARCHITECTURE §2, step 17), with the three cases the
 * C3 review found missing:
 *
 * 1. A status can arrive before the send step has stored the provider's id (the provider
 *    answers the send request and fires its "sent" webhook at almost the same time). It is
 *    held in `pending_delivery_statuses` and applied when the send step records the id.
 * 2. A status for a message whose send run is still going is held the same way, so a
 *    provider "failed" can never overtake the run that is still sending (or retrying) it.
 * 3. A message split into several provider messages records every part
 *    (`message_parts`), so each part's statuses count; the message is delivered when every
 *    part is, read when every part is, failed when a part failed before that.
 *
 * Both writers take a transaction-level advisory lock on (connection, provider id) before
 * looking, so a status and the recording of its part cannot miss each other.
 */

/** Statuses only move forward; "failed" never overrides delivered or read. */
const RANK: Partial<Record<MessageStatus, number>> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

export function nextOutboundStatus(
  current: MessageStatus,
  update: DeliveryStatusUpdate["status"],
): MessageStatus | null {
  const currentRank = RANK[current];
  if (currentRank === undefined) return null; // failed, superseded or inbound: final
  if (update === "failed") return currentRank < 3 ? "failed" : null;
  const nextRank = RANK[update];
  return nextRank !== undefined && nextRank > currentRank ? update : null;
}

/**
 * The status a message has from its parts: the lowest status every part reached, unless a
 * part failed before the message counted as delivered.
 */
export function aggregateStatus(
  parts: readonly DeliveryStatusUpdate["status"][],
): DeliveryStatusUpdate["status"] | null {
  if (parts.length === 0) return null;
  if (parts.includes("failed")) return "failed";
  let lowest: DeliveryStatusUpdate["status"] = "read";
  for (const status of parts) {
    if ((RANK[status] ?? 0) < (RANK[lowest] ?? 0)) lowest = status;
  }
  return lowest;
}

async function lockProviderId(
  ctx: BusinessContext,
  connectionId: string,
  externalMessageId: string,
): Promise<void> {
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`delivery:${connectionId}:${externalMessageId}`}))`,
  );
}

export interface StatusInput {
  readonly status: DeliveryStatusUpdate["status"];
  readonly occurredAt: Date;
  readonly error: { readonly code: string; readonly message: string } | null;
}

async function hold(
  ctx: BusinessContext,
  connectionId: string,
  externalMessageId: string,
  input: StatusInput,
): Promise<void> {
  await ctx.tx
    .insert(pendingDeliveryStatuses)
    .values({
      ...ctx.tenant,
      channelConnectionId: connectionId as ChannelConnectionId,
      externalMessageId,
      status: input.status,
      occurredAt: input.occurredAt,
      errorCode: input.error?.code.slice(0, 100) ?? null,
      errorMessage: input.error?.message.slice(0, 1000) ?? null,
    })
    .onConflictDoNothing();
}

function timestamps(status: MessageStatus, at: Date, error: StatusInput["error"]) {
  return {
    ...(status === "delivered" ? { deliveredAt: at } : {}),
    ...(status === "read" ? { readAt: at } : {}),
    ...(status === "failed"
      ? {
          failedAt: at,
          errorCode: error?.code.slice(0, 100) ?? "provider_failed",
          errorMessage: error?.message.slice(0, 1000) ?? null,
        }
      : {}),
  };
}

/** Moves the message to the status of its parts, if that is a step forward. */
async function refreshMessage(
  ctx: BusinessContext,
  messageId: MessageId,
  input: StatusInput,
): Promise<boolean> {
  const [message] = await ctx.tx
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(eq(messages.id, messageId))
    .for("update")
    .limit(1);
  if (message === undefined) return false;
  const parts = await ctx.tx
    .select({ status: messageParts.status })
    .from(messageParts)
    .where(eq(messageParts.messageId, messageId));
  const target = aggregateStatus(parts.map((part) => part.status));
  if (target === null) return false;
  const next = nextOutboundStatus(message.status, target);
  if (next === null) return false;
  await ctx.tx
    .update(messages)
    .set({ status: next, ...timestamps(next, input.occurredAt, input.error) })
    .where(eq(messages.id, message.id));
  return true;
}

export type StatusOutcome = "applied" | "held" | "ignored";

/**
 * Applies one provider status inside the business's scope. Returns `held` when it had to
 * wait for the send step, `ignored` when it changes nothing.
 */
export async function applyDeliveryStatus(
  ctx: BusinessContext,
  connectionId: string,
  externalMessageId: string,
  input: StatusInput,
): Promise<StatusOutcome> {
  await lockProviderId(ctx, connectionId, externalMessageId);
  const [part] = await ctx.tx
    .select({
      id: messageParts.id,
      messageId: messageParts.messageId,
      status: messageParts.status,
      messageStatus: messages.status,
    })
    .from(messageParts)
    .innerJoin(messages, eq(messages.id, messageParts.messageId))
    .where(
      and(
        eq(messageParts.channelConnectionId, connectionId as ChannelConnectionId),
        eq(messageParts.externalMessageId, externalMessageId),
      ),
    )
    .limit(1);

  if (part !== undefined) {
    if (part.messageStatus === "queued" || part.messageStatus === "sending") {
      await hold(ctx, connectionId, externalMessageId, input);
      return "held";
    }
    const nextPart = nextOutboundStatus(part.status, input.status);
    if (nextPart === null) return "ignored";
    await ctx.tx
      .update(messageParts)
      .set({
        status: nextPart as DeliveryStatusUpdate["status"],
        ...timestamps(nextPart, input.occurredAt, input.error),
      })
      .where(eq(messageParts.id, part.id));
    await refreshMessage(ctx, part.messageId, input);
    return "applied";
  }

  // Messages without parts: replies a person sent from the provider's own inbox, and messages
  // sent before parts were recorded.
  const [row] = await ctx.tx
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.channelConnectionId, connectionId as ChannelConnectionId),
        eq(messages.externalMessageId, externalMessageId),
        eq(messages.direction, "outbound"),
      ),
    )
    .for("update")
    .limit(1);
  if (row === undefined || row.status === "queued" || row.status === "sending") {
    await hold(ctx, connectionId, externalMessageId, input);
    return "held";
  }
  const next = nextOutboundStatus(row.status, input.status);
  if (next === null) return "ignored";
  await ctx.tx
    .update(messages)
    .set({ status: next, ...timestamps(next, input.occurredAt, input.error) })
    .where(eq(messages.id, row.id));
  return "applied";
}

/**
 * Records the provider messages a send produced (all of them, also when a later part
 * failed), under the same locks the status path takes.
 */
export async function recordParts(
  ctx: BusinessContext,
  messageId: MessageId,
  connectionId: string,
  parts: readonly { readonly externalMessageId: string; readonly sentAt: string }[],
): Promise<void> {
  for (const [index, part] of parts.entries()) {
    await lockProviderId(ctx, connectionId, part.externalMessageId);
    await ctx.tx
      .insert(messageParts)
      .values({
        ...ctx.tenant,
        messageId,
        channelConnectionId: connectionId as ChannelConnectionId,
        partIndex: index,
        externalMessageId: part.externalMessageId,
        status: "sent",
        sentAt: new Date(part.sentAt),
      })
      .onConflictDoNothing();
  }
}

/**
 * Applies the statuses that arrived for these provider ids before they were recorded, in
 * the order they happened, and drops them. Call after the message left `sending`.
 */
export async function applyHeldStatuses(
  ctx: BusinessContext,
  connectionId: string,
  externalMessageIds: readonly string[],
): Promise<number> {
  if (externalMessageIds.length === 0) return 0;
  const held = await ctx.tx
    .select()
    .from(pendingDeliveryStatuses)
    .where(
      and(
        eq(pendingDeliveryStatuses.channelConnectionId, connectionId as ChannelConnectionId),
        inArray(pendingDeliveryStatuses.externalMessageId, [...externalMessageIds]),
      ),
    )
    .orderBy(asc(pendingDeliveryStatuses.occurredAt));
  if (held.length === 0) return 0;
  await ctx.tx.delete(pendingDeliveryStatuses).where(
    inArray(
      pendingDeliveryStatuses.id,
      held.map((row) => row.id),
    ),
  );
  let applied = 0;
  for (const row of held) {
    const outcome = await applyDeliveryStatus(ctx, connectionId, row.externalMessageId, {
      status: row.status,
      occurredAt: row.occurredAt,
      error:
        row.errorCode === null ? null : { code: row.errorCode, message: row.errorMessage ?? "" },
    });
    if (outcome === "applied") applied += 1;
  }
  return applied;
}
