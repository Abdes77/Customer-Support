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
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  messageParts,
  messages,
  or,
  sql,
  takeoverLocks,
} from "@repo/db";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import type { PipelineContext } from "../deps";
import { applyDeliveryStatus } from "../send/deliveries";
import { optionsAsText } from "../send/prepare";
import { splitText } from "../send/split";
import { takeoverStartedEventId } from "../event-ids";

type Lookup = (
  channel: ChannelId,
  externalAccountId: string,
) => Promise<ChannelConnectionRef | null>;

export { nextOutboundStatus } from "../send/deliveries";

/**
 * Applies provider delivery statuses to our outbound messages (see `send/deliveries.ts` for
 * statuses that arrive early, during a send, or for one part of a split message). Returns how
 * many changed something now; held statuses are applied by the send step later.
 */
export async function applyStatuses(
  p: PipelineContext,
  statuses: readonly DeliveryStatusUpdate[],
  lookup: Lookup,
): Promise<number> {
  let changed = 0;
  for (const update of statuses) {
    const ref = await lookup(update.channel, update.externalAccountId);
    if (ref === null) continue;
    const outcome = await p.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run((ctx) =>
      applyDeliveryStatus(ctx, ref.connectionId, update.externalMessageId, {
        status: update.status,
        occurredAt: new Date(update.occurredAt),
        error: update.error,
      }),
    );
    if (outcome === "applied") changed += 1;
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
    if (signal.type === "provider_event") {
      // The event may name a group account (a WhatsApp Business Account): the channel's
      // handler finds the connections it concerns.
      const handler = p.providerEvents.find((item) => item.channel === signal.channel);
      if (handler === undefined) {
        p.logger.info("ingest.provider_event_unhandled", {
          channel: signal.channel,
          event: signal.event,
        });
        continue;
      }
      if (await handler.handle(signal)) handled += 1;
      continue;
    }
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
      case "delivery_watermark": {
        const changed = await applyWatermark(p, ref, signal);
        if (changed > 0) handled += 1;
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

  // Our own sends can echo back as "replies from the inbox"; they are already stored.
  if (await isOurSend(ctx, p, ref, conversationId, signal)) return null;

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

/** Leading and trailing whitespace and runs of spaces do not count. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The options a send wrote under the text (`optionsAsText`), if any. */
function withoutWrittenOptions(text: string): string {
  return text.replace(/\n\n(?:• [^\n]*\n?)+$/u, "");
}

/** How far before the echo a message of ours may have gone out to explain it. */
const UNVERIFIED_ECHO_LOOKBACK_MS = 30 * 60_000;

/**
 * A text an adapter cut to the platform's limit ends with an ellipsis; only long texts are
 * cut, so a shorter "…" ending is part of the words.
 */
const MIN_CUT_ECHO_LENGTH = 200;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Every text a send of this message may have put on the wire, normalized: the whole text,
 * each part the send step splits it into (`prepare`), with and without its quick replies
 * written under it.
 */
function sentTexts(
  text: string,
  quickReplies: readonly string[],
  maxLength: number | null,
): Set<string> {
  const bodies = quickReplies.length > 0 ? [text, optionsAsText(text, quickReplies)] : [text];
  const texts = new Set<string>();
  for (const body of bodies) {
    texts.add(normalized(body));
    if (maxLength !== null) {
      for (const part of splitText(body, maxLength)) texts.add(normalized(part));
    }
  }
  texts.delete("");
  return texts;
}

/**
 * Whether the words of an echo are exactly one of the texts we sent (never a part of one: a
 * person answering "Thanks!" must not be taken for a bot message that starts with it).
 */
function echoIsOneOf(echo: string, texts: ReadonlySet<string>): boolean {
  const plain = normalized(echo);
  const withoutOptions = normalized(withoutWrittenOptions(echo));
  if (texts.has(plain) || texts.has(withoutOptions)) return true;
  for (const candidate of [plain, withoutOptions]) {
    if (!candidate.endsWith("…")) continue;
    const kept = candidate.slice(0, -1).trimEnd();
    if (kept.length < MIN_CUT_ECHO_LENGTH) continue;
    for (const text of texts) {
      if (text.length > kept.length && text.startsWith(kept)) return true;
    }
  }
  return false;
}

/**
 * Whether an echo of a message the business sent is one of ours: its provider id is a
 * message we stored, a part we recorded, or a part a send step noted in its journal (the
 * steps of a split message note each part before the message is finished). An echo the
 * provider could not attribute (`unverified`: Instagram echoes carry no app id) can also
 * arrive in the moment between the provider accepting our send and our noting it, be the
 * second message of an attachment with a caption (never recorded), or be the first copy of a
 * part a retried send step sent twice (its id was never known). It counts as ours when its
 * words are exactly the text, or one part, of one of our outbound messages that is being
 * sent or went out shortly before the echo (without words: when that message is an
 * attachment). A person's reply would have to repeat a whole message (or part) of ours to
 * be taken for ours; replies from the provider's inbox recorded earlier never count.
 */
async function isOurSend(
  ctx: BusinessContext,
  p: PipelineContext,
  ref: ChannelConnectionRef,
  conversationId: ConversationId,
  signal: Extract<ChannelSignal, { type: "human_agent_replied" }>,
): Promise<boolean> {
  const id = signal.externalMessageId;
  const [stored] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.channelConnectionId, ref.connectionId), eq(messages.externalMessageId, id)),
    )
    .limit(1);
  if (stored !== undefined) return true;
  const [part] = await ctx.tx
    .select({ id: messageParts.id })
    .from(messageParts)
    .where(
      and(
        eq(messageParts.channelConnectionId, ref.connectionId),
        eq(messageParts.externalMessageId, id),
      ),
    )
    .limit(1);
  if (part !== undefined) return true;
  const [journaled] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "outbound"),
        sql`exists (select 1 from jsonb_each(coalesce(${messages.payload} -> 'sendJournal', '{}'::jsonb)) as j where j.value ->> 'externalMessageId' = ${id})`,
      ),
    )
    .limit(1);
  if (journaled !== undefined) return true;
  if (signal.attribution !== "unverified") return false;

  // Measured from the echo, not from now: Meta redelivers late webhooks for hours.
  const echoAt = Math.min(Date.parse(signal.occurredAt), p.clock().getTime());
  const since = new Date(echoAt - UNVERIFIED_ECHO_LOOKBACK_MS);
  const recent = await ctx.tx
    .select({ kind: messages.kind, text: messages.text, payload: messages.payload })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "outbound"),
        inArray(messages.author, ["bot", "human_agent"]),
        sql`coalesce(${messages.payload} ->> 'source', '') <> 'provider_inbox'`,
        or(
          eq(messages.status, "sending"),
          and(
            inArray(messages.status, ["sent", "delivered", "read", "failed"]),
            sql`coalesce(${messages.sentAt}, ${messages.failedAt}, ${messages.createdAt}) >= ${since.toISOString()}::timestamptz`,
          ),
        ),
      ),
    )
    .orderBy(desc(messages.sequence))
    .limit(20);
  if (signal.text === null || signal.text.trim().length === 0) {
    return recent.some((row) => row.kind === "media");
  }
  const maxLength = p.adapters.find(signal.channel)?.capabilities.maxTextLength ?? null;
  return recent.some(
    (row) =>
      row.text !== null &&
      echoIsOneOf(
        signal.text!,
        sentTexts(row.text, stringList(row.payload["quickReplies"]), maxLength),
      ),
  );
}

/**
 * Applies a delivery or read watermark (Messenger: "every message sent before this time
 * was delivered / read") to what we sent this contact on this connection: every recorded
 * part, and every outbound message stored without parts (a person's reply from the
 * provider's inbox), sent at or before the watermark. Goes through the same path as a
 * status for one message id, so statuses only move forward and a part still being sent is
 * held. Returns how many changed.
 */
async function applyWatermark(
  p: PipelineContext,
  ref: ChannelConnectionRef,
  signal: Extract<ChannelSignal, { type: "delivery_watermark" }>,
): Promise<number> {
  const watermark = new Date(signal.watermark);
  const occurredAt = new Date(signal.occurredAt);
  const behind = signal.status === "read" ? ["sent", "delivered"] : ["sent"];
  return p.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
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
    if (identity === undefined) return 0;
    const ofContact = sql`${messages.conversationId} in (select c.id from conversations c where c.channel_connection_id = ${ref.connectionId}::uuid and c.contact_id = ${identity.contactId}::uuid)`;
    const parts = await ctx.tx
      .select({ externalMessageId: messageParts.externalMessageId })
      .from(messageParts)
      .innerJoin(messages, eq(messages.id, messageParts.messageId))
      .where(
        and(
          eq(messageParts.channelConnectionId, ref.connectionId),
          inArray(messageParts.status, behind as ("sent" | "delivered")[]),
          lte(messageParts.sentAt, watermark),
          ofContact,
        ),
      )
      .limit(200);
    const loose = await ctx.tx
      .select({ externalMessageId: messages.externalMessageId })
      .from(messages)
      .where(
        and(
          eq(messages.channelConnectionId, ref.connectionId),
          eq(messages.direction, "outbound"),
          isNotNull(messages.externalMessageId),
          inArray(messages.status, behind as ("sent" | "delivered")[]),
          lte(messages.sentAt, watermark),
          sql`not exists (select 1 from message_parts mp where mp.message_id = ${messages.id})`,
          ofContact,
        ),
      )
      .limit(200);
    // One provider id at a time, in a fixed order: each takes an advisory lock, and two
    // watermarks applied at once must not take them in opposite orders.
    const ids = [
      ...new Set(
        [...parts, ...loose]
          .map((row) => row.externalMessageId)
          .filter((value): value is string => value !== null),
      ),
    ].sort();
    let changed = 0;
    for (const externalMessageId of ids) {
      const outcome = await applyDeliveryStatus(ctx, ref.connectionId, externalMessageId, {
        status: signal.status,
        occurredAt,
        error: null,
      });
      if (outcome === "applied") changed += 1;
    }
    return changed;
  });
}
