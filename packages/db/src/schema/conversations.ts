import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  ATTACHMENT_KINDS,
  type AttachmentSource,
  CHANNEL_IDS,
  type ChannelConnectionId,
  type ContactId,
  type ConversationId,
  type MessageId,
  type TraceId,
  TURN_AUTHORS,
  type UserId,
} from "@repo/core";

import { tenantFk } from "./businesses";
import { channelConnectionFk } from "./channels";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import {
  ADMIN_OF_AGENCY,
  businessPolicies,
  CURRENT_USER,
  IN_BUSINESS_SCOPE,
  STAFF_OF_AGENCY,
  systemPolicies,
  userPolicies,
} from "./policies";
import { users } from "./tenancy";
import {
  ATTACHMENT_STATUSES,
  CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  TAKEOVER_RELEASE_REASONS,
  TAKEOVER_SOURCES,
} from "./vocab";

/*
 * Everything in this file except internal notes is written by the message pipeline (C3) and
 * by the features built on it, through the system scope. Signed-in users only read these
 * tables: a manual reply, an assignment or a takeover is a server function that checks the
 * user and then acts through `forBusiness()`, so sequence numbers, leases and statuses are
 * never edited from a browser.
 */

/** A customer of one business. The same person writing to two businesses is two contacts. */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").$type<ContactId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    displayName: text("display_name"),
    /** E.164. */
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    /** IANA time zone when known; quiet hours fall back to the business's zone. */
    timezone: text("timezone"),
    /** Set when the contact sent an opt-out keyword: the bot stops writing to them. */
    optedOutAt: timestamptz("opted_out_at"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("contacts", t),
    unique("contacts_id_business_key").on(t.id, t.businessId),
    index("contacts_business_phone_idx").on(t.businessId, t.phone),
    index("contacts_business_email_idx").on(t.businessId, sql`lower(${t.email})`),
    index("contacts_business_created_idx").on(t.businessId, t.createdAt),
    ...businessPolicies("contacts", { clientRead: true }),
  ],
);

/** A child row's `(contact_id, business_id)` must be a contact of that business. */
export function contactFk(
  table: string,
  t: { readonly contactId: AnyPgColumn; readonly businessId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_contact_fk`,
    columns: [t.contactId, t.businessId],
    foreignColumns: [contacts.id, contacts.businessId],
  }).onDelete("cascade");
}

/**
 * How a provider knows a contact: wa_id, PSID, IGSID, widget visitor id or lower-cased
 * email address. One contact can have several.
 */
export const contactIdentities = pgTable(
  "contact_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    contactId: uuid("contact_id").$type<ContactId>().notNull(),
    channel: text("channel", { enum: CHANNEL_IDS }).notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamptz("last_seen_at"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("contact_identities", t),
    contactFk("contact_identities", t),
    uniqueIndex("contact_identities_external_key").on(t.businessId, t.channel, t.externalId),
    index("contact_identities_contact_idx").on(t.contactId),
    check("contact_identities_channel_check", oneOf(t.channel, CHANNEL_IDS)),
    ...businessPolicies("contact_identities", { clientRead: true }),
  ],
);

/**
 * One thread with one contact on one channel connection.
 *
 * Pipeline state kept here (ARCHITECTURE §2):
 * - `message_seq`: the last sequence number handed out. Take the next one with
 *   `update ... set message_seq = message_seq + 1 ... returning message_seq`.
 * - `turn_lease_owner` / `turn_lease_expires_at`: the turn lease. A reply run takes it
 *   atomically before generating and releases it after its messages are stored; an expired
 *   lease may be taken over, so a crashed run cannot block the conversation.
 * - `last_inbound_at`: when the customer last wrote (messaging windows, stale checks).
 * - `handled_through_seq`: the watermark of inbound messages a turn has dealt with.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").$type<ConversationId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    contactId: uuid("contact_id").$type<ContactId>().notNull(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    channel: text("channel", { enum: CHANNEL_IDS }).notNull(),
    /** Provider thread key when one contact can hold several threads (email). */
    externalThreadId: text("external_thread_id"),
    /** Email subject of the thread. */
    subject: text("subject"),
    status: text("status", { enum: CONVERSATION_STATUSES }).notNull().default("open"),
    assignedUserId: uuid("assigned_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    messageSeq: integer("message_seq").notNull().default(0),
    /**
     * Every inbound message with a sequence up to this one has been dealt with by a turn:
     * answered, or deliberately left unanswered (takeover, opt-out). The next turn answers
     * the inbound messages above it (C3).
     */
    handledThroughSeq: integer("handled_through_seq").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    lastInboundAt: timestamptz("last_inbound_at"),
    lastOutboundAt: timestamptz("last_outbound_at"),
    lastMessageAt: timestamptz("last_message_at"),
    turnLeaseOwner: text("turn_lease_owner"),
    turnLeaseExpiresAt: timestamptz("turn_lease_expires_at"),
    closedAt: timestamptz("closed_at"),
    closedReason: text("closed_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("conversations", t),
    contactFk("conversations", t),
    channelConnectionFk("conversations", t),
    unique("conversations_id_business_key").on(t.id, t.businessId),
    // At most one open conversation per contact and thread on a connection, so two webhook
    // deliveries racing to create it cannot both win.
    uniqueIndex("conversations_open_thread_key")
      .on(t.channelConnectionId, t.contactId, sql`coalesce(${t.externalThreadId}, '')`)
      .where(sql`${t.status} = 'open'`),
    index("conversations_business_last_message_idx").on(t.businessId, t.lastMessageAt),
    index("conversations_contact_idx").on(t.contactId),
    index("conversations_assigned_user_idx").on(t.assignedUserId),
    check("conversations_channel_check", oneOf(t.channel, CHANNEL_IDS)),
    check("conversations_status_check", oneOf(t.status, CONVERSATION_STATUSES)),
    ...businessPolicies("conversations", { clientRead: true }),
  ],
);

/** A child row's `(conversation_id, business_id)` must be a conversation of that business. */
export function conversationFk(
  table: string,
  t: { readonly conversationId: AnyPgColumn; readonly businessId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_conversation_fk`,
    columns: [t.conversationId, t.businessId],
    foreignColumns: [conversations.id, conversations.businessId],
  }).onDelete("cascade");
}

/**
 * One message, inbound or outbound.
 *
 * - `(channel_connection_id, external_message_id)` is unique: insert an inbound message with
 *   ON CONFLICT DO NOTHING on it and a provider's duplicate delivery is stored once.
 * - `sequence` orders the messages of a conversation and is unique within it.
 * - `enqueued_at` is set once `message.received` was emitted for an inbound message; the
 *   sweeper re-emits rows where it stayed empty.
 * - `trace_id` links the message to its model calls, actions and sends.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").$type<MessageId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>().notNull(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    direction: text("direction", { enum: MESSAGE_DIRECTIONS }).notNull(),
    author: text("author", { enum: TURN_AUTHORS }).notNull(),
    /** The person who wrote a manual reply in the admin panel. */
    authorUserId: uuid("author_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    /** Inbound: a kind of `NormalizedInboundMessage`. Outbound: text, media, template, email. */
    kind: text("kind").notNull().default("text"),
    text: text("text"),
    /** Everything else of the normalized message: location, reply, envelope, quick replies. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    externalMessageId: text("external_message_id"),
    replyToExternalMessageId: text("reply_to_external_message_id"),
    sequence: integer("sequence").notNull(),
    status: text("status", { enum: MESSAGE_STATUSES }).notNull(),
    traceId: uuid("trace_id").$type<TraceId>().notNull().defaultRandom(),
    enqueuedAt: timestamptz("enqueued_at"),
    /** Inbound: when the customer sent it. Outbound: when the provider accepted it. */
    sentAt: timestamptz("sent_at"),
    deliveredAt: timestamptz("delivered_at"),
    readAt: timestamptz("read_at"),
    failedAt: timestamptz("failed_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("messages", t),
    conversationFk("messages", t),
    channelConnectionFk("messages", t),
    unique("messages_id_business_key").on(t.id, t.businessId),
    uniqueIndex("messages_external_key").on(t.channelConnectionId, t.externalMessageId),
    uniqueIndex("messages_conversation_sequence_key").on(t.conversationId, t.sequence),
    index("messages_business_created_idx").on(t.businessId, t.createdAt),
    index("messages_trace_idx").on(t.traceId),
    // The sweeper's work list: inbound messages whose event was never emitted.
    index("messages_unenqueued_idx")
      .on(t.createdAt)
      .where(sql`${t.direction} = 'inbound' and ${t.enqueuedAt} is null`),
    // The send function's work list.
    index("messages_outbox_idx")
      .on(t.conversationId, t.sequence)
      .where(sql`${t.status} in ('queued', 'sending')`),
    check("messages_direction_check", oneOf(t.direction, MESSAGE_DIRECTIONS)),
    check("messages_author_check", oneOf(t.author, TURN_AUTHORS)),
    check("messages_status_check", oneOf(t.status, MESSAGE_STATUSES)),
    check(
      "messages_direction_author_check",
      sql`(${t.direction} = 'inbound' and ${t.author} = 'customer' and ${t.status} = 'received') or (${t.direction} = 'outbound' and ${t.author} <> 'customer' and ${t.status} <> 'received')`,
    ),
    ...businessPolicies("messages", { clientRead: true }),
  ],
);

/**
 * A file attached to a message. `source` says where the bytes came from; once the pipeline
 * has stored them, `storage_bucket` and `storage_path` point into the private bucket
 * (`{agencyId}/{businessId}/{conversationId}/{messageId}/{file}`). `analysis` is the text
 * the engine replays instead of the photo in later turns.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    messageId: uuid("message_id").$type<MessageId>().notNull(),
    kind: text("kind", { enum: ATTACHMENT_KINDS }).notNull(),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    source: jsonb("source").$type<AttachmentSource>(),
    storageBucket: text("storage_bucket"),
    storagePath: text("storage_path"),
    status: text("status", { enum: ATTACHMENT_STATUSES }).notNull().default("pending"),
    analysis: text("analysis"),
    analyzedAt: timestamptz("analyzed_at"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("attachments", t),
    foreignKey({
      name: "attachments_message_fk",
      columns: [t.messageId, t.businessId],
      foreignColumns: [messages.id, messages.businessId],
    }).onDelete("cascade"),
    index("attachments_message_idx").on(t.messageId),
    index("attachments_business_idx").on(t.businessId),
    check("attachments_kind_check", oneOf(t.kind, ATTACHMENT_KINDS)),
    check("attachments_status_check", oneOf(t.status, ATTACHMENT_STATUSES)),
    ...businessPolicies("attachments", { clientRead: true }),
  ],
);

/**
 * A person holds the conversation and the bot stays silent (invariant I5). A lock is active
 * while `released_at` is null; a conversation has at most one active lock. C13 owns the
 * rules (who may take over, idle release).
 */
export const takeoverLocks = pgTable(
  "takeover_locks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>().notNull(),
    /** Null when the takeover was detected in the provider's own inbox or made by a rule. */
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: TAKEOVER_SOURCES }).notNull(),
    reason: text("reason"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    /** Moved forward by every human message; the idle release counts from here. */
    lastActivityAt: timestamptz("last_activity_at").notNull().defaultNow(),
    releasedAt: timestamptz("released_at"),
    releasedBy: uuid("released_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    releaseReason: text("release_reason", { enum: TAKEOVER_RELEASE_REASONS }),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("takeover_locks", t),
    conversationFk("takeover_locks", t),
    uniqueIndex("takeover_locks_active_key")
      .on(t.conversationId)
      .where(sql`${t.releasedAt} is null`),
    index("takeover_locks_business_idx").on(t.businessId),
    check("takeover_locks_source_check", oneOf(t.source, TAKEOVER_SOURCES)),
    check(
      "takeover_locks_release_reason_check",
      sql`${t.releaseReason} is null or ${oneOf(t.releaseReason, TAKEOVER_RELEASE_REASONS)}`,
    ),
    ...businessPolicies("takeover_locks", { clientRead: true }),
  ],
);

/** A note agency staff leave on a conversation. Never shown to client users or customers. */
export const internalNotes = pgTable(
  "internal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>().notNull(),
    authorUserId: uuid("author_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("internal_notes", t),
    conversationFk("internal_notes", t),
    index("internal_notes_conversation_idx").on(t.conversationId, t.createdAt),
    // Staff write notes under their own name and change only their own; admins moderate.
    ...userPolicies("internal_notes", {
      select: STAFF_OF_AGENCY,
      insert: `(${STAFF_OF_AGENCY} and author_user_id = ${CURRENT_USER})`,
      update: `(${STAFF_OF_AGENCY} and author_user_id = ${CURRENT_USER})`,
      delete: `((${STAFF_OF_AGENCY} and author_user_id = ${CURRENT_USER}) or ${ADMIN_OF_AGENCY})`,
    }),
    ...systemPolicies("internal_notes", { read: IN_BUSINESS_SCOPE, write: IN_BUSINESS_SCOPE }),
  ],
);

/**
 * A website-widget visitor session (C8). The session token itself is signed with
 * WIDGET_SESSION_SECRET and not stored; this row lets a session be found, expired and revoked.
 */
export const widgetSessions = pgTable(
  "widget_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    visitorId: text("visitor_id").notNull(),
    contactId: uuid("contact_id").$type<ContactId>(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    origin: text("origin"),
    userAgent: text("user_agent"),
    /** A keyed hash of the visitor's IP address, for rate limits. Never the address itself. */
    ipHash: text("ip_hash"),
    lastSeenAt: timestamptz("last_seen_at"),
    expiresAt: timestamptz("expires_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("widget_sessions", t),
    channelConnectionFk("widget_sessions", t).onDelete("cascade"),
    contactFk("widget_sessions", t),
    conversationFk("widget_sessions", t),
    uniqueIndex("widget_sessions_visitor_key").on(t.channelConnectionId, t.visitorId),
    index("widget_sessions_business_idx").on(t.businessId),
    ...businessPolicies("widget_sessions"),
  ],
);
