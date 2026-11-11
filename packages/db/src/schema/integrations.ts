import {
  type AnyPgColumn,
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

import type {
  ContactId,
  ConversationId,
  IntegrationConnectionId,
  LeadId,
  UserId,
} from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { contactFk, conversationFk } from "./conversations";
import { leadFk } from "./leads";
import { businessPolicies } from "./policies";
import { users } from "./tenancy";
import { BOOKING_STATUSES, CONNECTION_STATUSES, INTEGRATION_EVENT_STATUSES } from "./vocab";

/**
 * One connected integration of a business: a CRM, a calendar, Calendly or an outgoing
 * webhook. Like channel connections, the row holds no secret, is switched off rather than
 * deleted while bookings refer to it, and is written only by the connect flows (C12, C14)
 * through the system scope: inbound webhooks of an integration are mapped to a tenant by
 * what is stored here, so a user must not be able to point a row at someone else's account.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").$type<IntegrationConnectionId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    /** "hubspot", "gohighlevel", "jobber", "housecall_pro", "servicetitan", "webhook",
     * "google_calendar", "outlook_calendar", "calendly", ... The owning chunk validates it. */
    provider: text("provider").notNull(),
    displayName: text("display_name"),
    externalAccountId: text("external_account_id"),
    status: text("status", { enum: CONNECTION_STATUSES }).notNull().default("pending"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    /** Safe to show in the admin panel: no secrets, no raw provider payloads. */
    lastError: text("last_error"),
    lastErrorAt: timestamptz("last_error_at"),
    lastSyncedAt: timestamptz("last_synced_at"),
    connectedBy: uuid("connected_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    connectedAt: timestamptz("connected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("integration_connections", t),
    unique("integration_connections_id_business_key").on(t.id, t.businessId),
    index("integration_connections_business_idx").on(t.businessId, t.provider),
    check("integration_connections_status_check", oneOf(t.status, CONNECTION_STATUSES)),
    ...businessPolicies("integration_connections"),
  ],
);

function integrationConnectionFk(
  table: string,
  t: { readonly integrationConnectionId: AnyPgColumn; readonly businessId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_integration_connection_fk`,
    columns: [t.integrationConnectionId, t.businessId],
    foreignColumns: [integrationConnections.id, integrationConnections.businessId],
  });
}

/** Encrypted credentials of one integration connection. See `channel_connection_secrets`. */
export const integrationConnectionSecrets = pgTable(
  "integration_connection_secrets",
  {
    connectionId: uuid("connection_id").$type<IntegrationConnectionId>().primaryKey(),
    ...tenantColumns(),
    ciphertext: text("ciphertext").notNull(),
    keyId: text("key_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("integration_connection_secrets", t),
    foreignKey({
      name: "integration_connection_secrets_connection_fk",
      columns: [t.connectionId, t.businessId],
      foreignColumns: [integrationConnections.id, integrationConnections.businessId],
    }).onDelete("cascade"),
    index("integration_connection_secrets_business_idx").on(t.businessId),
    index("integration_connection_secrets_key_idx").on(t.keyId),
    ...businessPolicies("integration_connection_secrets").filter((policy) =>
      policy.name.endsWith("_system"),
    ),
  ],
);

/**
 * The integration event log: one row per operation against an external system (push a lead,
 * update it, test the connection), with its attempts and outcome. `idempotency_key` is
 * unique per connection, so a retried job updates its row instead of pushing twice.
 */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    integrationConnectionId: uuid("integration_connection_id")
      .$type<IntegrationConnectionId>()
      .notNull(),
    leadId: uuid("lead_id").$type<LeadId>(),
    /** "lead.qualified", "push_lead", "update_lead", "test_connection", ... */
    eventType: text("event_type").notNull(),
    status: text("status", { enum: INTEGRATION_EVENT_STATUSES }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    errorCode: text("error_code"),
    /** Safe to show in the admin panel. */
    errorMessage: text("error_message"),
    retryable: boolean("retryable"),
    /** Sanitized summaries only: never credentials, never a full provider payload. */
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    durationMs: integer("duration_ms"),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("integration_events", t),
    integrationConnectionFk("integration_events", t).onDelete("cascade"),
    leadFk("integration_events", t),
    uniqueIndex("integration_events_idempotency_key").on(
      t.integrationConnectionId,
      t.idempotencyKey,
    ),
    index("integration_events_business_occurred_idx").on(t.businessId, t.occurredAt),
    index("integration_events_lead_idx").on(t.leadId),
    check("integration_events_status_check", oneOf(t.status, INTEGRATION_EVENT_STATUSES)),
    ...businessPolicies("integration_events"),
  ],
);

/** A meeting booked (or being booked) for a lead: calendar event, Calendly or manual (C12). */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    contactId: uuid("contact_id").$type<ContactId>().notNull(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    leadId: uuid("lead_id").$type<LeadId>(),
    /** The calendar connection that holds the event; null for manual bookings. */
    integrationConnectionId: uuid("integration_connection_id").$type<IntegrationConnectionId>(),
    /** "google_calendar", "outlook_calendar", "calendly" or "manual". */
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id"),
    externalUrl: text("external_url"),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("pending"),
    /** Null while a scheduling link is out and the customer has not picked a time. */
    startsAt: timestamptz("starts_at"),
    endsAt: timestamptz("ends_at"),
    timezone: text("timezone"),
    title: text("title"),
    location: text("location"),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    cancelledAt: timestamptz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("bookings", t),
    contactFk("bookings", t),
    conversationFk("bookings", t),
    leadFk("bookings", t),
    integrationConnectionFk("bookings", t),
    uniqueIndex("bookings_external_event_key").on(t.integrationConnectionId, t.externalEventId),
    index("bookings_business_starts_idx").on(t.businessId, t.startsAt),
    index("bookings_lead_idx").on(t.leadId),
    index("bookings_conversation_idx").on(t.conversationId),
    check("bookings_status_check", oneOf(t.status, BOOKING_STATUSES)),
    ...businessPolicies("bookings", { clientRead: true }),
  ],
);
