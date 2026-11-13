import {
  AppError,
  type ChannelId,
  type ContactId,
  type ConversationId,
  type EventPayload,
  type MessageId,
  newTraceId,
  type NormalizedInboundMessage,
  ParsedWebhook,
  type TraceId,
  ValidationError,
} from "@repo/core";
import {
  and,
  attachments,
  type BusinessContext,
  type ChannelConnectionRef,
  contactIdentities,
  contacts,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  messages,
  sql,
} from "@repo/db";
import { isObjectPath, tenantPrefix } from "@repo/db/storage";
import { loadSettings } from "@repo/settings/server";
import { type AnyJobEvent, jobEvent } from "@repo/jobs";

import type { InboundObserver, PipelineContext } from "../deps";
import { receivedEventId } from "../event-ids";
import { applySignals, applyStatuses } from "./signals";

/** Connection statuses whose messages are stored. Revoked and disabled ones are ignored. */
const RECEIVING_STATUSES = new Set(["pending", "active", "error"]);

/**
 * Inbound kinds that ask for an answer. A reaction is stored and shown in the inbox but does
 * not start a turn: a thumbs-up on the bot's message is not a question.
 */
export function isReplyableKind(kind: string): boolean {
  return kind !== "reaction";
}

/** Reactions that mean "yes" to a yes-or-no question (`channels.meta.reactions`). */
const YES_REACTIONS = new Set(["👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "❤", "❤️", "♥️", "😍", "🥰"]);

/**
 * `channels.meta.reactions` = "treat_as_reply" (C17: the option did nothing before): on
 * Messenger and Instagram, a thumbs-up or a heart on the bot's latest message, when that
 * message asked a question, is stored as the customer's answer (a text message holding the
 * emoji, with the reaction kept in the payload) and starts a turn like any message. Anything
 * else stays a reaction: stored, shown, never answered.
 */
async function reactionAsAnswer(
  ctx: BusinessContext,
  message: NormalizedInboundMessage,
  conversationId: ConversationId,
  logger: Pick<PipelineContext, "logger">["logger"] | undefined,
): Promise<boolean> {
  const reaction = message.reaction;
  if (message.kind !== "reaction" || reaction === null || reaction.removed) return false;
  if (message.channel !== "messenger" && message.channel !== "instagram") return false;
  if (reaction.emoji === null || !YES_REACTIONS.has(reaction.emoji.trim())) return false;
  const settings = await loadSettings(ctx, ctx.tenant, logger === undefined ? {} : { logger });
  if (settings.values["channels.meta.reactions"] !== "treat_as_reply") return false;
  const [latest] = await ctx.tx
    .select({
      author: messages.author,
      text: messages.text,
      externalMessageId: messages.externalMessageId,
      payload: messages.payload,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "outbound")))
    .orderBy(desc(messages.sequence))
    .limit(1);
  if (latest?.author !== "bot") return false;
  if (!(latest.text ?? "").trim().endsWith("?")) return false;
  // The reaction must be on that very message (or one of its parts).
  const parts = (asParts(latest.payload) ?? []).concat(latest.externalMessageId ?? []);
  return parts.includes(reaction.targetExternalMessageId);
}

function asParts(payload: unknown): string[] | null {
  if (payload === null || typeof payload !== "object") return null;
  const delivery = (payload as Record<string, unknown>)["delivery"];
  if (delivery === null || typeof delivery !== "object") return null;
  const parts = (delivery as Record<string, unknown>)["parts"];
  if (!Array.isArray(parts)) return null;
  return (parts as unknown[]).flatMap((part): string[] => {
    const id: unknown =
      part !== null && typeof part === "object"
        ? ((part as Record<string, unknown>)["providerMessageId"] ??
          (part as Record<string, unknown>)["externalMessageId"])
        : part;
    return typeof id === "string" ? [id] : [];
  });
}

export interface StoredInbound {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly traceId: TraceId;
  readonly receivedAt: string;
  readonly channel: ChannelId;
  readonly duplicate: boolean;
  readonly replyable: boolean;
  /** Set once `message.received` was emitted (or the message needs no turn). */
  readonly enqueued: boolean;
  /** What the inbound observers want sent with the message (C13). Empty for duplicates. */
  readonly observerEvents?: readonly AnyJobEvent[];
}

export interface IngestResult {
  readonly stored: number;
  readonly duplicates: number;
  readonly emitted: number;
  /** Messages for an unknown, revoked or disabled account: acknowledged, not stored. */
  readonly ignored: number;
  readonly statuses: number;
  readonly signals: number;
}

type ConnectionLookup = (
  channel: ChannelId,
  externalAccountId: string,
) => Promise<ChannelConnectionRef | null>;

/** Caches directory lookups for the duration of one webhook. */
export function connectionLookup(p: PipelineContext): ConnectionLookup {
  const cache = new Map<string, Promise<ChannelConnectionRef | null>>();
  return (channel, externalAccountId) => {
    const key = `${channel}\u0000${externalAccountId}`;
    let found = cache.get(key);
    if (found === undefined) {
      found = p.db.directory.findChannelConnection(channel, externalAccountId);
      cache.set(key, found);
    }
    return found;
  };
}

/**
 * ARCHITECTURE §2, steps 4 to 6, for every channel: resolve the tenant, store each message
 * once, emit `message.received`, mark it enqueued. Webhook routes call it after verifying
 * and parsing; channels that fetch messages themselves (email, the widget) call it directly.
 *
 * Throws when storing or emitting fails, so the caller answers 500 and the provider retries;
 * the retry finds the stored rows and only emits what is still missing.
 */
export async function ingest(p: PipelineContext, input: ParsedWebhook): Promise<IngestResult> {
  const checked = ParsedWebhook.safeParse(input);
  if (!checked.success) {
    throw new ValidationError("The parsed webhook does not match the contract.", {
      details: { paths: checked.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  const parsed = checked.data;
  const lookup = connectionLookup(p);
  const stored: (StoredInbound & { ref: ChannelConnectionRef })[] = [];
  let ignored = 0;

  for (const message of parsed.messages) {
    const ref = await lookup(message.channel, message.externalAccountId);
    if (ref === null || !RECEIVING_STATUSES.has(ref.status)) {
      ignored += 1;
      p.logger.warn("ingest.account_ignored", {
        channel: message.channel,
        reason: ref === null ? "unknown_account" : `connection_${ref.status}`,
        businessId: ref?.businessId,
      });
      continue;
    }
    const result = await p.db
      .forBusiness(ref.businessId, { agencyId: ref.agencyId })
      .run((ctx) => storeInbound(ctx, ref, message, p.clock(), p));
    stored.push({ ...result, ref });
  }

  // Emit for every stored row that still needs it (new rows, and duplicates whose earlier
  // delivery failed to emit). The deterministic id makes a double emit harmless.
  const toEmit = stored.filter((row) => row.replyable && !row.enqueued);
  const events: AnyJobEvent[] = toEmit.map((row) =>
    jobEvent("message.received", receivedEventId(row.messageId), {
      traceId: row.traceId,
      agencyId: row.ref.agencyId,
      businessId: row.ref.businessId,
      conversationId: row.conversationId,
      messageId: row.messageId,
      channel: row.channel,
      receivedAt: row.receivedAt,
    } satisfies EventPayload<"message.received">),
  );
  // What the inbound observers asked for (C13: an opt-out confirmation to send). A lost one
  // is not lost for good: a queued message is re-emitted by the sweeper.
  const observed = stored.flatMap((row) => row.observerEvents ?? []);
  if (events.length > 0 || observed.length > 0) {
    await p.events.send([...events, ...observed]);
    if (toEmit.length > 0) await markEnqueued(p, toEmit);
  }

  const statusCount = await applyStatuses(p, parsed.statuses, lookup);
  const signalCount = await applySignals(p, parsed.signals, lookup);

  const duplicates = stored.filter((row) => row.duplicate).length;
  return {
    stored: stored.length - duplicates,
    duplicates,
    emitted: events.length,
    ignored,
    statuses: statusCount,
    signals: signalCount,
  };
}

async function markEnqueued(
  p: PipelineContext,
  rows: readonly (StoredInbound & { ref: ChannelConnectionRef })[],
): Promise<void> {
  const byBusiness = new Map<string, (StoredInbound & { ref: ChannelConnectionRef })[]>();
  for (const row of rows) {
    const list = byBusiness.get(row.ref.businessId) ?? [];
    list.push(row);
    byBusiness.set(row.ref.businessId, list);
  }
  for (const list of byBusiness.values()) {
    const ref = list[0]!.ref;
    await p.db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
      await ctx.tx
        .update(messages)
        .set({ enqueuedAt: p.clock() })
        .where(
          and(
            inArray(
              messages.id,
              list.map((row) => row.messageId),
            ),
            isNull(messages.enqueuedAt),
          ),
        );
    });
  }
}

function payloadOf(message: NormalizedInboundMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (message.location !== null) payload["location"] = message.location;
  if (message.interactiveReply !== null) payload["interactiveReply"] = message.interactiveReply;
  if (message.reaction !== null) payload["reaction"] = message.reaction;
  if (message.email !== null) payload["email"] = message.email;
  if (Object.keys(message.metadata).length > 0) payload["metadata"] = message.metadata;
  return payload;
}

async function findStored(
  ctx: BusinessContext,
  ref: ChannelConnectionRef,
  externalMessageId: string,
) {
  const [row] = await ctx.tx
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      traceId: messages.traceId,
      createdAt: messages.createdAt,
      enqueuedAt: messages.enqueuedAt,
      kind: messages.kind,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelConnectionId, ref.connectionId),
        eq(messages.externalMessageId, externalMessageId),
      ),
    )
    .limit(1);
  return row;
}

function duplicateOf(
  row: NonNullable<Awaited<ReturnType<typeof findStored>>>,
  channel: ChannelId,
): StoredInbound {
  return {
    messageId: row.id,
    conversationId: row.conversationId,
    traceId: row.traceId,
    receivedAt: row.createdAt.toISOString(),
    channel,
    duplicate: true,
    replyable: isReplyableKind(row.kind),
    enqueued: row.enqueuedAt !== null,
  };
}

/**
 * Stores one inbound message in the business's system scope: contact, conversation, message
 * and attachments. A message already stored under `(connection, external id)` is returned as
 * a duplicate and nothing is written.
 */
export async function storeInbound(
  ctx: BusinessContext,
  ref: ChannelConnectionRef,
  message: NormalizedInboundMessage,
  now: Date,
  p?: Pick<PipelineContext, "inboundObservers" | "logger">,
): Promise<StoredInbound> {
  const existing = await findStored(ctx, ref, message.externalMessageId);
  if (existing !== undefined) return duplicateOf(existing, message.channel);

  const contactId = await upsertContact(ctx, message, now);
  const conversationId = await upsertConversation(ctx, ref, contactId, message);

  // Lock the conversation: concurrent deliveries of the same message serialise here, and
  // the second one finds the first one's row below instead of taking a sequence number.
  await ctx.tx.execute(
    sql`select 1 from conversations where id = ${conversationId}::uuid for update`,
  );
  const again = await findStored(ctx, ref, message.externalMessageId);
  if (again !== undefined) return duplicateOf(again, message.channel);

  const sentAt = new Date(message.sentAt);
  const windowTime = sentAt.getTime() > now.getTime() ? now : sentAt;
  const [counter] = await ctx.tx
    .update(conversations)
    .set({
      messageSeq: sql`${conversations.messageSeq} + 1`,
      lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${windowTime.toISOString()}::timestamptz)`,
      lastMessageAt: now,
      unreadCount: sql`${conversations.unreadCount} + 1`,
    })
    .where(eq(conversations.id, conversationId))
    .returning({ sequence: conversations.messageSeq });
  if (counter === undefined) {
    throw new AppError("internal", "The conversation disappeared while storing a message.", {
      retryable: true,
    });
  }

  const answer = await reactionAsAnswer(ctx, message, conversationId, p?.logger);
  const kind = answer ? "text" : message.kind;
  const replyable = isReplyableKind(kind);
  const traceId = newTraceId();
  const inserted = await ctx.tx
    .insert(messages)
    .values({
      ...ctx.tenant,
      conversationId,
      channelConnectionId: ref.connectionId,
      direction: "inbound",
      author: "customer",
      kind,
      text: answer ? (message.reaction?.emoji ?? message.text) : message.text,
      payload: answer ? { ...payloadOf(message), reactionAsAnswer: true } : payloadOf(message),
      externalMessageId: message.externalMessageId,
      replyToExternalMessageId: message.replyToExternalMessageId,
      sequence: counter.sequence,
      status: "received",
      traceId,
      sentAt,
      // A message that needs no turn is "enqueued" at once, so the sweeper leaves it alone.
      enqueuedAt: replyable ? null : now,
    })
    .onConflictDoNothing({ target: [messages.channelConnectionId, messages.externalMessageId] })
    .returning({ id: messages.id, createdAt: messages.createdAt });
  const row = inserted[0];
  if (row === undefined) {
    // The same provider message reached another conversation of this connection at the
    // same moment (possible only around a conversation being closed). Roll back and let
    // the provider's retry take the duplicate branch.
    throw new AppError("conflict", "The message was stored concurrently; retry.", {
      retryable: true,
    });
  }

  if (message.attachments.length > 0) {
    await ctx.tx.insert(attachments).values(
      message.attachments.map((attachment) => {
        const { source } = attachment;
        const base = {
          ...ctx.tenant,
          messageId: row.id,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          sizeBytes: attachment.sizeBytes,
          source,
        };
        if (source.type !== "storage") return { ...base, status: "pending" as const };
        // A file "already in our storage" must be inside this tenant's folder: a webhook
        // must never be able to point the bot at another business's files.
        if (!isObjectPath(source.path) || !source.path.startsWith(tenantPrefix(ctx.tenant))) {
          return {
            ...base,
            status: "failed" as const,
            error: "The file is outside this business.",
          };
        }
        return {
          ...base,
          storageBucket: source.bucket,
          storagePath: source.path,
          status: "stored" as const,
        };
      }),
    );
  }

  const observerEvents =
    p === undefined || p.inboundObservers.length === 0
      ? []
      : await observeInbound(ctx, p, {
          messageId: row.id,
          conversationId,
          contactId,
          channel: message.channel,
          kind: message.kind,
          text: message.text ?? message.interactiveReply?.title ?? null,
          traceId,
          now,
        });

  return {
    messageId: row.id,
    conversationId,
    traceId,
    receivedAt: row.createdAt.toISOString(),
    channel: message.channel,
    duplicate: false,
    replyable,
    enqueued: !replyable,
    observerEvents,
  };
}

/**
 * Runs the inbound observers (C13) inside the transaction that stored the message, each under
 * its own savepoint: one that fails is rolled back and logged (never with the message text),
 * and the message is still stored.
 */
async function observeInbound(
  ctx: BusinessContext,
  p: Pick<PipelineContext, "inboundObservers" | "logger">,
  facts: Parameters<InboundObserver["stored"]>[1],
): Promise<AnyJobEvent[]> {
  const events: AnyJobEvent[] = [];
  for (const observer of p.inboundObservers) {
    try {
      const produced = await ctx.tx.transaction((tx) => observer.stored({ ...ctx, tx }, facts));
      events.push(...produced);
    } catch (error) {
      p.logger.error("ingest.observer_failed", {
        observer: observer.name,
        businessId: ctx.tenant.businessId,
        conversationId: facts.conversationId,
        messageId: facts.messageId,
        error: error instanceof Error ? { name: error.name } : { name: "Error" },
      });
    }
  }
  return events;
}

async function upsertContact(
  ctx: BusinessContext,
  message: NormalizedInboundMessage,
  now: Date,
): Promise<ContactId> {
  const { sender } = message;
  const findIdentity = async () => {
    const [identity] = await ctx.tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.businessId, ctx.tenant.businessId),
          eq(contactIdentities.channel, message.channel),
          eq(contactIdentities.externalId, sender.externalId),
        ),
      )
      .limit(1);
    return identity?.contactId;
  };

  let contactId = await findIdentity();
  if (contactId === undefined) {
    const [created] = await ctx.tx
      .insert(contacts)
      .values({
        ...ctx.tenant,
        displayName: sender.displayName,
        phone: sender.phone,
        email: sender.email,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: contacts.id });
    const claimed = await ctx.tx
      .insert(contactIdentities)
      .values({
        ...ctx.tenant,
        contactId: created!.id,
        channel: message.channel,
        externalId: sender.externalId,
        displayName: sender.displayName,
        lastSeenAt: now,
      })
      .onConflictDoNothing()
      .returning({ contactId: contactIdentities.contactId });
    if (claimed.length === 1) return created!.id;
    // Another delivery created the identity first: use its contact, drop ours.
    await ctx.tx.delete(contacts).where(eq(contacts.id, created!.id));
    contactId = await findIdentity();
    if (contactId === undefined) {
      throw new AppError("conflict", "The contact could not be resolved; retry.", {
        retryable: true,
      });
    }
    return contactId;
  }

  await ctx.tx
    .update(contactIdentities)
    .set({
      lastSeenAt: now,
      displayName: sql`coalesce(${sender.displayName}, ${contactIdentities.displayName})`,
    })
    .where(
      and(
        eq(contactIdentities.channel, message.channel),
        eq(contactIdentities.externalId, sender.externalId),
        eq(contactIdentities.businessId, ctx.tenant.businessId),
      ),
    );
  // Fill what the contact record does not know yet; never overwrite what a person entered.
  await ctx.tx
    .update(contacts)
    .set({
      lastSeenAt: now,
      displayName: sql`coalesce(${contacts.displayName}, ${sender.displayName})`,
      phone: sql`coalesce(${contacts.phone}, ${sender.phone})`,
      email: sql`coalesce(${contacts.email}, ${sender.email})`,
    })
    .where(eq(contacts.id, contactId));
  return contactId;
}

async function upsertConversation(
  ctx: BusinessContext,
  ref: ChannelConnectionRef,
  contactId: ContactId,
  message: NormalizedInboundMessage,
): Promise<ConversationId> {
  const thread = message.externalThreadId;
  const find = async () => {
    const [row] = await ctx.tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.channelConnectionId, ref.connectionId),
          eq(conversations.contactId, contactId),
          eq(conversations.status, "open"),
          sql`coalesce(${conversations.externalThreadId}, '') = ${thread ?? ""}`,
        ),
      )
      .limit(1);
    return row?.id;
  };
  const found = await find();
  if (found !== undefined) return found;
  const [created] = await ctx.tx
    .insert(conversations)
    .values({
      ...ctx.tenant,
      contactId,
      channelConnectionId: ref.connectionId,
      channel: message.channel,
      externalThreadId: thread,
      subject: message.email?.subject ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: conversations.id });
  if (created !== undefined) return created.id;
  const raced = await find();
  if (raced === undefined) {
    throw new AppError("conflict", "The conversation could not be resolved; retry.", {
      retryable: true,
    });
  }
  return raced;
}
