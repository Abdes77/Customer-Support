import {
  type ChannelId,
  type ChannelSignal,
  type ConversationId,
  type DeliveryStatusUpdate,
  newTraceId,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  type ChannelConnectionRef,
  channelConnections,
  contactIdentities,
  conversations,
  eq,
  isNull,
  messages,
  type MessageStatus,
  sql,
  takeoverLocks,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import type { PipelineContext } from "../deps";
import { takeoverStartedEventId } from "../event-ids";

type Lookup = (
  channel: ChannelId,
  externalAccountId: string,
) => Promise<ChannelConnectionRef | null>;

/** Outbound statuses only move forward; "failed" never overrides delivered or read. */
const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
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
  const currentRank = STATUS_RANK[current];
  if (currentRank === undefined) return null; // failed, superseded or inbound: final
  if (update === "failed") return currentRank < 3 ? "failed" : null;
  const nextRank = STATUS_RANK[update];
  return nextRank !== undefined && nextRank > currentRank ? update : null;
}

/** Applies provider delivery statuses to our outbound messages. Returns how many changed. */
export async function applyStatuses(
  p: PipelineContext,
  statuses: readonly DeliveryStatusUpdate[],
  lookup: Lookup,
): Promise<number> {
  let changed = 0;
  for (const update of statuses) {
    const ref = await lookup(update.channel, update.externalAccountId);
    if (ref === null) continue;
    changed += await p.db
      .forBusiness(ref.businessId, { agencyId: ref.agencyId })
      .run(async (ctx) => {
        const [row] = await ctx.tx
          .select({ id: messages.id, status: messages.status })
          .from(messages)
          .where(
            and(
              eq(messages.channelConnectionId, ref.connectionId),
              eq(messages.externalMessageId, update.externalMessageId),
              eq(messages.direction, "outbound"),
            ),
          )
          .for("update")
          .limit(1);
        if (row === undefined) return 0;
        const next = nextOutboundStatus(row.status, update.status);
        if (next === null) return 0;
        const at = new Date(update.occurredAt);
        await ctx.tx
          .update(messages)
          .set({
            status: next,
            ...(next === "delivered" ? { deliveredAt: at } : {}),
            ...(next === "read" ? { readAt: at } : {}),
            ...(next === "failed"
              ? {
                  failedAt: at,
                  errorCode: update.error?.code ?? "provider_failed",
                  errorMessage: update.error?.message ?? null,
                }
              : {}),
          })
          .where(eq(messages.id, row.id));
        return 1;
      });
  }
  return changed;
}

/** Handles provider signals: a person replied in the provider's inbox, access was revoked. */
export async function applySignals(
  p: PipelineContext,
  signals: readonly ChannelSignal[],
  lookup: Lookup,
): Promise<number> {
  let handled = 0;
  const events: AnyJobEvent[] = [];
  for (const signal of signals) {
    const ref = await lookup(signal.channel, signal.externalAccountId);
    if (ref === null) {
      p.logger.warn("ingest.signal_ignored", { channel: signal.channel, type: signal.type });
      continue;
    }
    const scope = p.db.forBusiness(ref.businessId, { agencyId: ref.agencyId });
    switch (signal.type) {
      case "connection_revoked":
        await scope.run(async (ctx) => {
          await ctx.tx
            .update(channelConnections)
            .set({
              status: "revoked",
              lastError: signal.reason.slice(0, 500),
              lastErrorAt: new Date(signal.occurredAt),
            })
            .where(eq(channelConnections.id, ref.connectionId));
        });
        p.logger.warn("channel.connection_revoked", {
          businessId: ref.businessId,
          connectionId: ref.connectionId,
          channel: signal.channel,
        });
        handled += 1;
        break;
      case "human_agent_replied": {
        const event = await scope.run((ctx) => recordHumanReply(ctx, p, ref, signal));
        if (event !== null) events.push(event);
        handled += 1;
        break;
      }
    }
  }
  if (events.length > 0) await p.events.send(events);
  return handled;
}

/**
 * Someone at the business answered from the provider's own inbox (Meta Business Suite, the
 * mailbox). The reply is stored as a human-agent message, the customer's messages so far
 * count as handled, and, when `handoff.provider_inbox_takeover` is on, the bot steps back
 * as if they had taken over in the admin panel (C13 owns the release rules).
 */
async function recordHumanReply(
  ctx: BusinessContext,
  p: PipelineContext,
  ref: ChannelConnectionRef,
  signal: Extract<ChannelSignal, { type: "human_agent_replied" }>,
): Promise<AnyJobEvent | null> {
  const [identity] = await ctx.tx
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, signal.channel),
        eq(contactIdentities.externalId, signal.contactExternalId),
      ),
    )
    .limit(1);
  if (identity === undefined) return null;
  const [conversation] = await ctx.tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, ref.connectionId),
        eq(conversations.contactId, identity.contactId),
        eq(conversations.status, "open"),
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(1)
    .for("update");
  if (conversation === undefined) return null;
  const conversationId: ConversationId = conversation.id;

  const [known] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelConnectionId, ref.connectionId),
        eq(messages.externalMessageId, signal.externalMessageId),
      ),
    )
    .limit(1);
  // Our own sends can echo back as "replies from the inbox"; they are already stored.
  if (known !== undefined) return null;

  const at = new Date(signal.occurredAt);
  const [counter] = await ctx.tx
    .update(conversations)
    .set({
      messageSeq: sql`${conversations.messageSeq} + 1`,
      lastOutboundAt: at,
      lastMessageAt: p.clock(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({ sequence: conversations.messageSeq });
  await ctx.tx
    .insert(messages)
    .values({
      ...ctx.tenant,
      conversationId,
      channelConnectionId: ref.connectionId,
      direction: "outbound",
      author: "human_agent",
      kind: "text",
      text: signal.text,
      payload: { source: "provider_inbox" },
      externalMessageId: signal.externalMessageId,
      sequence: counter!.sequence,
      status: "sent",
      sentAt: at,
      enqueuedAt: p.clock(),
    })
    .onConflictDoNothing({ target: [messages.channelConnectionId, messages.externalMessageId] });
  // What the person answered needs no answer from the bot.
  await ctx.tx
    .update(conversations)
    .set({
      handledThroughSeq: sql`greatest(${conversations.handledThroughSeq}, (select coalesce(max(m.sequence), 0) from messages m where m.conversation_id = ${conversationId}::uuid and m.direction = 'inbound'))`,
    })
    .where(eq(conversations.id, conversationId));

  const settings = await loadSettings(ctx, ctx.tenant, { logger: p.logger });
  if (!settings.values["handoff.provider_inbox_takeover"]) return null;

  const [active] = await ctx.tx
    .select({ id: takeoverLocks.id })
    .from(takeoverLocks)
    .where(and(eq(takeoverLocks.conversationId, conversationId), isNull(takeoverLocks.releasedAt)))
    .limit(1);
  if (active !== undefined) {
    await ctx.tx
      .update(takeoverLocks)
      .set({ lastActivityAt: at })
      .where(eq(takeoverLocks.id, active.id));
    return null;
  }
  const [lock] = await ctx.tx
    .insert(takeoverLocks)
    .values({
      ...ctx.tenant,
      conversationId,
      source: "provider_inbox",
      reason: "A person replied from the provider's inbox.",
      startedAt: at,
      lastActivityAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: takeoverLocks.id });
  if (lock === undefined) return null;
  p.logger.info("conversation.takeover_started", {
    businessId: ctx.tenant.businessId,
    conversationId,
    source: "provider_inbox",
  });
  return jobEvent("conversation.takeover_started", takeoverStartedEventId(lock.id), {
    traceId: newTraceId(),
    agencyId: ctx.tenant.agencyId,
    businessId: ctx.tenant.businessId,
    conversationId,
    userId: null,
    source: "provider_inbox",
  });
}
