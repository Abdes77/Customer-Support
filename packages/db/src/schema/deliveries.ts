import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { type ChannelConnectionId, DELIVERY_STATUSES, type MessageId } from "@repo/core";

import { tenantFk } from "./businesses";
import { channelConnectionFk } from "./channels";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { messages } from "./conversations";
import { businessPolicies } from "./policies";

/*
 * Delivery tracking of outbound messages (C9, closing gaps found in the C3 review).
 *
 * One outbound message can leave as several provider messages (a long reply split at the
 * channel's limit, C3), and the provider reports each one separately. Its statuses can also
 * arrive before our send step has recorded the provider's id, because the provider answers
 * the send request and fires the "sent" webhook at nearly the same moment.
 */

/**
 * One provider message of an outbound message: its provider id and how far it got. The
 * message's own status is derived from its parts (the furthest status every part reached;
 * failed when a part failed before the message counted as delivered).
 */
export const messageParts = pgTable(
  "message_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    messageId: uuid("message_id").$type<MessageId>().notNull(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    partIndex: integer("part_index").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull().default("sent"),
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
    tenantFk("message_parts", t),
    channelConnectionFk("message_parts", t),
    foreignKey({
      name: "message_parts_message_fk",
      columns: [t.messageId, t.businessId],
      foreignColumns: [messages.id, messages.businessId],
    }).onDelete("cascade"),
    uniqueIndex("message_parts_external_key").on(t.channelConnectionId, t.externalMessageId),
    uniqueIndex("message_parts_message_part_key").on(t.messageId, t.partIndex),
    index("message_parts_business_idx").on(t.businessId),
    check("message_parts_status_check", oneOf(t.status, DELIVERY_STATUSES)),
    check("message_parts_part_index_check", sql`${t.partIndex} >= 0`),
    ...businessPolicies("message_parts"),
  ],
);

/**
 * A delivery status the pipeline could not apply yet: for a provider id no message part
 * holds (yet), or for a message whose send run is still going. The send step applies what
 * is waiting here when it records its parts; the sweeper drops what nobody claimed after
 * two days (statuses of messages sent by other tools on the same account).
 */
export const pendingDeliveryStatuses = pgTable(
  "pending_delivery_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    channelConnectionId: uuid("channel_connection_id").$type<ChannelConnectionId>().notNull(),
    externalMessageId: text("external_message_id").notNull(),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("pending_delivery_statuses", t),
    channelConnectionFk("pending_delivery_statuses", t).onDelete("cascade"),
    uniqueIndex("pending_delivery_statuses_key").on(
      t.channelConnectionId,
      t.externalMessageId,
      t.status,
    ),
    index("pending_delivery_statuses_created_idx").on(t.createdAt),
    index("pending_delivery_statuses_business_idx").on(t.businessId),
    check("pending_delivery_statuses_status_check", oneOf(t.status, DELIVERY_STATUSES)),
    ...businessPolicies("pending_delivery_statuses"),
  ],
);
