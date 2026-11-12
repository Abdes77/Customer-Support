import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { CHANNEL_IDS, type ChannelConnectionId, type UserId } from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { businessPolicies } from "./policies";
import { users } from "./tenancy";
import { CONNECTION_STATUSES, MESSAGE_TEMPLATE_STATUSES } from "./vocab";

/**
 * One connected channel account of a business: a WhatsApp number, a Facebook Page, an
 * Instagram account, an inbox, a website widget or the test channel.
 *
 * `(channel, external_account_id)` is unique across all tenants: it is the key that maps an
 * unauthenticated webhook to exactly one tenant (ARCHITECTURE §2, step 4).
 *
 * That is also why no signed-in user may write this table: whoever owns the row for an
 * account receives its messages. Rows are created and changed by the connect flows of
 * C8 to C11, which prove control of the account (OAuth, Embedded Signup, a mailbox login)
 * and then write through the system scope.
 *
 * This row never holds a secret. Credentials live in `channel_connection_secrets`, which no
 * signed-in user can read. Connections are switched off (`revoked`, `disabled`), not
 * deleted, while conversations refer to them.
 */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: uuid("id").$type<ChannelConnectionId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    channel: text("channel", { enum: CHANNEL_IDS }).notNull(),
    /** Phone number id, Page id, Instagram account id, inbox address or widget public key. */
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name"),
    status: text("status", { enum: CONNECTION_STATUSES }).notNull().default("pending"),
    /** Non-secret configuration chosen by a person (allowed origins, IMAP host and port...). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Non-secret state kept by the system (sync cursors, watch expiry, token expiry...). */
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    lastErrorAt: timestamptz("last_error_at"),
    connectedBy: uuid("connected_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    connectedAt: timestamptz("connected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("channel_connections", t),
    unique("channel_connections_id_business_key").on(t.id, t.businessId),
    uniqueIndex("channel_connections_account_key").on(t.channel, t.externalAccountId),
    index("channel_connections_business_idx").on(t.businessId, t.channel),
    // Meta reports template and account events per WhatsApp Business Account, which can hold
    // several connected numbers (C9): `directory.findChannelConnectionsByBusinessAccount`.
    index("channel_connections_business_account_idx").on(
      t.channel,
      sql`(${t.config} ->> 'businessAccountId')`,
    ),
    check("channel_connections_channel_check", oneOf(t.channel, CHANNEL_IDS)),
    check("channel_connections_status_check", oneOf(t.status, CONNECTION_STATUSES)),
    ...businessPolicies("channel_connections"),
  ],
);

/** A child row's `(channel_connection_id, business_id)` must be a connection of that business. */
export function channelConnectionFk(
  table: string,
  t: { readonly channelConnectionId: AnyPgColumn; readonly businessId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_channel_connection_fk`,
    columns: [t.channelConnectionId, t.businessId],
    foreignColumns: [channelConnections.id, channelConnections.businessId],
  });
}

/**
 * The encrypted credentials of one channel connection (OAuth tokens, page tokens, IMAP and
 * SMTP passwords) as one AES-256-GCM envelope. Written and read through `channelSecrets`
 * only. There is no policy for signed-in users: not even the ciphertext reaches a browser.
 */
export const channelConnectionSecrets = pgTable(
  "channel_connection_secrets",
  {
    connectionId: uuid("connection_id").$type<ChannelConnectionId>().primaryKey(),
    ...tenantColumns(),
    ciphertext: text("ciphertext").notNull(),
    /** Id of the key that encrypted the envelope, so rotation can find old rows. */
    keyId: text("key_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("channel_connection_secrets", t),
    foreignKey({
      name: "channel_connection_secrets_connection_fk",
      columns: [t.connectionId, t.businessId],
      foreignColumns: [channelConnections.id, channelConnections.businessId],
    }).onDelete("cascade"),
    index("channel_connection_secrets_business_idx").on(t.businessId),
    index("channel_connection_secrets_key_idx").on(t.keyId),
    ...businessPolicies("channel_connection_secrets").filter((policy) =>
      policy.name.endsWith("_system"),
    ),
  ],
);

/** A provider-approved message template (WhatsApp), created and synced by C9. */
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    name: text("name").notNull(),
    language: text("language").notNull().default("en_US"),
    category: text("category"),
    /** What the system uses it for, for example "follow_up". */
    purpose: text("purpose"),
    status: text("status", { enum: MESSAGE_TEMPLATE_STATUSES }).notNull().default("draft"),
    externalTemplateId: text("external_template_id"),
    components: jsonb("components").$type<unknown[]>().notNull().default([]),
    rejectionReason: text("rejection_reason"),
    lastSyncedAt: timestamptz("last_synced_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("message_templates", t),
    channelConnectionFk("message_templates", t).onDelete("cascade"),
    uniqueIndex("message_templates_name_key").on(t.channelConnectionId, t.name, t.language),
    index("message_templates_business_idx").on(t.businessId),
    check("message_templates_status_check", oneOf(t.status, MESSAGE_TEMPLATE_STATUSES)),
    ...businessPolicies("message_templates", {
      insert: "staff",
      update: "staff",
      delete: "staff",
    }),
  ],
);
