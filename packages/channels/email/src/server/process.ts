import { createHash } from "node:crypto";

import {
  AppError,
  type ChannelConnectionId,
  type ChannelSignal,
  type DeliveryStatusUpdate,
  type InboundAttachment,
  type Logger,
} from "@repo/core";
import {
  and,
  type BusinessContext,
  type BusinessTenant,
  contacts,
  conversations,
  desc,
  eq,
  gte,
  inArray,
  messageParts,
  messages,
  sql,
  storedUploads,
} from "@repo/db";
import { uploadPath } from "@repo/db/storage";
import type { AppResolvedSettings } from "@repo/settings";

import { cleanBody } from "../body/clean";
import {
  businessAddressReason,
  classifyEmail,
  type EmailClass,
  failedDmarc,
  replyAddressOf,
} from "../classify";
import { replyCore } from "../compose";
import type { EmailConnectionConfig } from "../config";
import { parseEmail, type ParsedEmail } from "../mime/parse";
import { attachmentKind, selectAttachments, toInboundMessage } from "../normalize";
import { threadKeyOf } from "../thread";
import type { EmailServerDeps } from "./deps";

/*
 * One fetched email, from raw bytes to the pipeline: read it, decide what it is
 * (`classifyEmail`), find its conversation, keep its files, and hand it to `ingest`
 * (ARCHITECTURE §2, steps 4 to 6), as a customer message, a delivery status (a bounce of
 * ours) or a signal (a person at the business answered from the mailbox).
 */

export type ProcessOutcome =
  | "ingested"
  | "automatic_in_thread"
  | "automatic"
  | "own_send"
  | "loop"
  | "bounce"
  | "bounce_delayed"
  | "bounce_unmatched"
  | "bounce_unverified"
  | "staff_reply"
  | "internal"
  | "ignored_sender"
  | "unreadable"
  | "rejected";

export interface FetchedEmail {
  readonly raw: Uint8Array;
  /** "inbox" for received mail, "sent" for the mailbox's sent folder. */
  readonly folder: "inbox" | "sent";
  /** The provider's own id (Gmail id, Graph id, IMAP `uidvalidity:uid`). */
  readonly providerMessageId: string;
  /** `gmail:<thread>` or `graph:<conversation>`; null for IMAP. */
  readonly providerThreadKey: string | null;
  readonly receivedAt: Date;
}

export interface ProcessContext {
  readonly tenant: BusinessTenant;
  readonly connectionId: ChannelConnectionId;
  readonly config: EmailConnectionConfig;
  readonly settings: AppResolvedSettings;
  readonly logger: Logger;
}

/** The thread an email belongs to, and whether a conversation of ours already has it. */
export interface ResolvedThread {
  readonly key: string | null;
  readonly known: boolean;
}

/**
 * The conversation thread of a message: the thread of the newest message it answers that we
 * stored (its In-Reply-To, then its References from newest to oldest; our own sends are
 * stored under their Message-ID), else the provider's thread when a conversation has it,
 * else a new key (`threadKeyOf`).
 */
export async function resolveThread(
  ctx: BusinessContext,
  connectionId: ChannelConnectionId,
  email: ParsedEmail,
  providerThreadKey: string | null,
): Promise<ResolvedThread> {
  const candidates: string[] = [];
  for (const id of [email.inReplyTo, ...[...email.references].reverse()]) {
    if (id !== null && !candidates.includes(id) && candidates.length < 30) candidates.push(id);
  }
  if (candidates.length > 0) {
    const rows = await ctx.tx
      .select({
        externalMessageId: messages.externalMessageId,
        thread: conversations.externalThreadId,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.channelConnectionId, connectionId),
          inArray(messages.externalMessageId, candidates),
        ),
      );
    for (const id of candidates) {
      const row = rows.find((item) => item.externalMessageId === id);
      if (row !== undefined) return { key: row.thread, known: true };
    }
  }
  const key = threadKeyOf({
    providerThreadId: providerThreadKey,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
  });
  if (key === null) return { key, known: false };
  const [existing] = await ctx.tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, connectionId),
        eq(conversations.externalThreadId, key),
      ),
    )
    .limit(1);
  return { key, known: existing !== undefined };
}

/** The ids among `candidates` that are messages we sent from this connection. */
/**
 * Our outbound messages a delivery report names, among those sent to one of the recipients
 * the report says failed (C17): a report forged by someone who knows a Message-ID (anyone
 * the email was sent or forwarded to) must also name its real recipient, and can then only
 * fail a message to that address.
 */
async function ourOutbound(
  ctx: BusinessContext,
  connectionId: ChannelConnectionId,
  candidates: readonly string[],
  recipients: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0 || recipients.length === 0) return [];
  const rows = await ctx.tx
    .select({ id: messages.externalMessageId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        eq(messages.channelConnectionId, connectionId),
        eq(messages.direction, "outbound"),
        inArray(messages.externalMessageId, candidates.slice(0, 50)),
        inArray(sql`lower(${contacts.email})`, recipients.slice(0, 20)),
      ),
    );
  return rows.map((row) => row.id).filter((id): id is string => id !== null);
}

/** How far back an outbound message of ours may have been written to explain a sent copy. */
const OWN_COPY_LOOKBACK_MS = 24 * 3600_000;
/** A reply's words must be at least this long to recognize our copy by them alone. */
const MIN_CORE_MATCH_CHARS = 20;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a message in the mailbox's Sent folder is a copy of something this system sent,
 * recognized without its headers (C11 review): Gmail or Exchange may rewrite the Message-ID
 * or drop our loop header, and our own copy must then never read as a person replying (it
 * would hand the thread over after the bot's first reply). Matched, in this order, by:
 * - its Message-ID being one of our outbound messages or parts on this connection;
 * - its provider id being the one the provider returned when we sent (Gmail's message id,
 *   `payload.delivery.providerIds` or the send journal);
 * - its words: one of our outbound messages of the same thread, written in the last day,
 *   whose text (without the greeting and closing the composer replaces) appears whole above
 *   the quote of the copy. A person's reply would have to repeat a whole reply of ours.
 * Returns how it matched, or null.
 */
export async function ownSentCopy(
  ctx: BusinessContext,
  connectionId: ChannelConnectionId,
  input: {
    readonly messageId: string;
    readonly providerMessageId: string;
    readonly threadKey: string;
    readonly text: string;
    readonly at: Date;
  },
): Promise<"message_id" | "provider_id" | "content" | null> {
  const [byId] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelConnectionId, connectionId),
        eq(messages.direction, "outbound"),
        eq(messages.externalMessageId, input.messageId),
      ),
    )
    .limit(1);
  if (byId !== undefined) return "message_id";
  const [part] = await ctx.tx
    .select({ id: messageParts.id })
    .from(messageParts)
    .where(
      and(
        eq(messageParts.channelConnectionId, connectionId),
        eq(messageParts.externalMessageId, input.messageId),
      ),
    )
    .limit(1);
  if (part !== undefined) return "message_id";

  const ours = await ctx.tx
    .select({
      text: messages.text,
      payload: messages.payload,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.channelConnectionId, connectionId),
        eq(conversations.externalThreadId, input.threadKey),
        eq(messages.direction, "outbound"),
        inArray(messages.author, ["bot", "human_agent"]),
        sql`coalesce(${messages.payload} ->> 'source', '') <> 'provider_inbox'`,
        gte(messages.createdAt, new Date(input.at.getTime() - OWN_COPY_LOOKBACK_MS)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50);
  for (const row of ours) {
    const delivery = asRecord(row.payload["delivery"]);
    const recorded: unknown = delivery["providerIds"];
    const providerIds: unknown[] = Array.isArray(recorded) ? (recorded as unknown[]) : [];
    const journal = Object.values(asRecord(row.payload["sendJournal"])).map(
      (entry) => asRecord(entry)["providerMessageId"],
    );
    if ([...providerIds, ...journal].includes(input.providerMessageId)) return "provider_id";
  }
  const copy = collapse(input.text);
  for (const row of ours) {
    if (row.text === null || row.createdAt.getTime() > input.at.getTime() + 600_000) continue;
    const core = replyCore(row.text);
    if (core.length >= MIN_CORE_MATCH_CHARS && copy.includes(core)) return "content";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A stable UUID from text (for upload paths that a re-sync overwrites instead of doubling). */
export function uuidFrom(text: string): string {
  const hash = createHash("sha256").update(text).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** The id we store the message under: its Message-ID, or one made from the provider's id. */
export function storedMessageId(email: ParsedEmail, fetched: FetchedEmail, inbox: string): string {
  if (email.messageId !== null) return email.messageId;
  const domain = inbox.slice(inbox.indexOf("@") + 1);
  return `<missing-${uuidFrom(`${fetched.providerMessageId}`)}@${domain}>`;
}

async function storeAttachments(
  deps: EmailServerDeps,
  context: ProcessContext,
  email: ParsedEmail,
  messageKey: string,
): Promise<InboundAttachment[]> {
  const storage = deps.storage(context.tenant);
  const out: InboundAttachment[] = [];
  const selected = selectAttachments(email);
  for (const [index, attachment] of selected.entries()) {
    const upload = {
      ownerId: context.connectionId,
      uploadId: uuidFrom(`${context.connectionId}\u0000${messageKey}\u0000${index}`),
      fileName: attachment.fileName ?? `attachment-${index + 1}`,
    };
    // Recorded before the file is written: a file whose email is never ingested is found and
    // deleted by the retention job (C17). A re-sync writes the same path again.
    await deps.db
      .forBusiness(context.tenant.businessId, { agencyId: context.tenant.agencyId })
      .run((ctx) =>
        ctx.tx
          .insert(storedUploads)
          .values({ ...ctx.tenant, path: uploadPath(context.tenant, upload), source: "email" })
          .onConflictDoNothing(),
      );
    const location = await storage.putUpload(upload, attachment.bytes, {
      contentType: attachment.mimeType,
    });
    out.push({
      kind: attachmentKind(attachment.mimeType),
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      sizeBytes: attachment.bytes.byteLength,
      source: { type: "storage", bucket: location.bucket, path: location.path },
    });
  }
  return out;
}

/**
 * Reads, classifies and delivers one fetched email. Runs inside the sync step; a database
 * or ingest failure is thrown (the step retries and the cursor stays where it was), while an
 * email that can never be read or stored is logged and skipped so it cannot hold the inbox.
 */
export async function processEmail(
  deps: EmailServerDeps,
  context: ProcessContext,
  fetched: FetchedEmail,
): Promise<ProcessOutcome> {
  const { config, settings, logger } = context;
  let email: ParsedEmail;
  try {
    email = await parseEmail(fetched.raw);
  } catch {
    logger.warn("email.unreadable", {
      businessId: context.tenant.businessId,
      connectionId: context.connectionId,
    });
    return "unreadable";
  }
  const values = settings.values;
  let kind: EmailClass = classifyEmail(email, {
    inboxAddresses: [config.address],
    internalDomains: values["channels.email.internal_domains"],
    ignoredSenders: values["channels.email.ignored_senders"].map((item) => item.toLowerCase()),
    loopToken: config.loopToken,
  });
  // Whatever sits in the Sent folder was written from the mailbox (read through the
  // authenticated API or IMAP session: a stranger cannot put mail there).
  if (fetched.folder === "sent" && kind.kind !== "own_send" && kind.kind !== "loop") {
    kind = { kind: "business", reason: "inbox" };
  }
  // A received email whose From is the business's own address or domain is never a
  // customer's, but it is never a hand-over either: From is not authenticated, so a forged
  // "From: the business" naming a known thread would silence the bot (C11 review).
  if (fetched.folder === "inbox" && kind.kind === "business") return "internal";
  const messageId = storedMessageId(email, fetched, config.address);
  const scope = deps.db.forBusiness(context.tenant.businessId, {
    agencyId: context.tenant.agencyId,
  });
  const occurredAt = (
    email.date !== null && Date.parse(email.date) <= fetched.receivedAt.getTime()
      ? new Date(email.date)
      : fetched.receivedAt
  ).toISOString();

  switch (kind.kind) {
    case "own_send":
    case "loop":
    case "ignored_sender":
      return kind.kind;

    case "bounce": {
      if (!kind.failed) return "bounce_delayed";
      if (kind.spoofed) return "bounce_unverified";
      const ours = await scope.run((ctx) =>
        ourOutbound(ctx, context.connectionId, kind.candidates, kind.recipients),
      );
      if (ours.length === 0) return "bounce_unmatched";
      const statuses: DeliveryStatusUpdate[] = ours.map((id) => ({
        channel: "email",
        externalAccountId: config.address,
        externalMessageId: id,
        status: "failed",
        occurredAt,
        error: {
          code: "bounced",
          message: (kind.diagnostic ?? "The email bounced.").slice(0, 300),
        },
      }));
      await deps.ingest({ messages: [], statuses, signals: [] });
      return "bounce";
    }

    case "business": {
      // A person at the business wrote to customers (from the mailbox, or a colleague's
      // reply-all): each customer in it whose thread we hold hands over to the person.
      const recipients = [...email.to, ...email.cc].filter(
        (item) =>
          businessAddressReason(item.address, {
            inboxAddresses: [config.address],
            internalDomains: values["channels.email.internal_domains"],
          }) === null,
      );
      if (recipients.length === 0) return "internal";
      const thread = await scope.run((ctx) =>
        resolveThread(ctx, context.connectionId, email, fetched.providerThreadKey),
      );
      if (!thread.known || thread.key === null) return "internal";
      const text = cleanBody(email).text;
      const threadKey = thread.key;
      // Our own send whose headers the provider rewrote must not read as a person's reply.
      const ownCopy = await scope.run((ctx) =>
        ownSentCopy(ctx, context.connectionId, {
          messageId,
          providerMessageId: fetched.providerMessageId,
          threadKey,
          text,
          at: fetched.receivedAt,
        }),
      );
      if (ownCopy !== null) {
        // Detectable: the loop header should have recognized it (HUMAN_TODO 31).
        logger.warn("email.own_send_without_marker", {
          businessId: context.tenant.businessId,
          connectionId: context.connectionId,
          provider: config.provider,
          matchedBy: ownCopy,
        });
        return "own_send";
      }
      const signals: ChannelSignal[] = recipients.map((recipient) => ({
        type: "human_agent_replied",
        channel: "email",
        externalAccountId: config.address,
        contactExternalId: recipient.address,
        externalMessageId: messageId,
        text: text.length > 0 ? text : null,
        occurredAt,
        attribution: "external",
        externalThreadId: threadKey,
      }));
      await deps.ingest({ messages: [], statuses: [], signals });
      return "staff_reply";
    }

    case "automatic":
    case "customer": {
      const thread = await scope.run((ctx) =>
        resolveThread(ctx, context.connectionId, email, fetched.providerThreadKey),
      );
      // Automatic mail outside a conversation of ours is not a customer: drop it. Inside one
      // (an out-of-office answer to the bot) it is stored for the team, and the channel guard
      // keeps the bot from answering it.
      if (kind.kind === "automatic" && !thread.known) return "automatic";
      const sender = replyAddressOf(email);
      if (sender === null) return "automatic";
      try {
        const attachments = await storeAttachments(deps, context, email, messageId);
        const message = toInboundMessage({
          email,
          inboxAddress: config.address,
          externalMessageId: messageId,
          threadKey: thread.key,
          sender,
          body: cleanBody(email),
          attachments,
          receivedAt: fetched.receivedAt,
          metadata: {
            provider: config.provider,
            providerMessageId: fetched.providerMessageId.slice(0, 200),
            ...(kind.kind === "automatic"
              ? { automated: kind.reason }
              : // The receiving server says From is forged (DMARC failed): stored for the
                // team, never answered by the bot, so nobody can make the business's inbox
                // write to an address of their choosing (C17: reflection).
                failedDmarc(email)
                ? { automated: "dmarc_fail" }
                : {}),
          },
        });
        await deps.ingest({ messages: [message], statuses: [], signals: [] });
      } catch (error) {
        // A message the contract or storage refuses for good is skipped; anything else is
        // retried with the whole step.
        if (error instanceof AppError && !error.retryable) {
          logger.warn("email.rejected", {
            businessId: context.tenant.businessId,
            connectionId: context.connectionId,
            code: error.code,
          });
          return "rejected";
        }
        throw error;
      }
      return kind.kind === "automatic" ? "automatic_in_thread" : "ingested";
    }
  }
}
