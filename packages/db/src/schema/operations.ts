import { sql } from "drizzle-orm";
import {
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

import type {
  AgencyId,
  BusinessId,
  ConversationId,
  LeadId,
  MessageId,
  TraceId,
  UserId,
} from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { conversationFk } from "./conversations";
import { leadFk } from "./leads";
import {
  ADMIN_OF_AGENCY,
  businessPolicies,
  CURRENT_USER,
  IN_SHARED_SCOPE,
  sharedPolicies,
  STAFF_OF_AGENCY,
  systemPolicies,
  userPolicies,
} from "./policies";
import { agencies, users } from "./tenancy";
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  AUDIT_ACTOR_TYPES,
  DEAD_LETTER_STATUSES,
  ESCALATION_ACK_CHANNELS,
  ESCALATION_STATUSES,
  SCHEDULED_JOB_STATUSES,
} from "./vocab";

/*
 * Operational tables. Written by jobs through the system scope; agency staff read them,
 * client users do not.
 */

/**
 * Work scheduled for later (follow-up nudges, reminders, takeover releases). Inngest does
 * the waiting; this row makes the job visible in the admin panel and cancellable.
 * `(business_id, dedupe_key)` is unique, so scheduling the same thing twice is harmless.
 */
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    leadId: uuid("lead_id").$type<LeadId>(),
    /** "follow_up", "booking_reminder", "takeover_release", ... The owning chunk validates. */
    kind: text("kind").notNull(),
    status: text("status", { enum: SCHEDULED_JOB_STATUSES }).notNull().default("scheduled"),
    runAt: timestamptz("run_at").notNull(),
    /** Ids and classifications only, like every job payload. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** The Inngest event or run id, for cancelling and for support. */
    externalJobId: text("external_job_id"),
    completedAt: timestamptz("completed_at"),
    cancelledAt: timestamptz("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("scheduled_jobs", t),
    conversationFk("scheduled_jobs", t),
    leadFk("scheduled_jobs", t),
    uniqueIndex("scheduled_jobs_dedupe_key").on(t.businessId, t.dedupeKey),
    index("scheduled_jobs_due_idx").on(t.status, t.runAt),
    index("scheduled_jobs_conversation_idx").on(t.conversationId),
    check("scheduled_jobs_status_check", oneOf(t.status, SCHEDULED_JOB_STATUSES)),
    ...businessPolicies("scheduled_jobs"),
  ],
);

/**
 * The state of one emergency escalation chain (C13): who was tried and who acknowledged.
 * At most one chain is active per conversation. `chain` is the snapshot of the contacts (the
 * business's escalation chain, then the agency's fallback contacts) and `policy` the timing
 * from the settings when the chain started, so a settings change never reshuffles a running
 * chain. `next_action_at` is when the chain job means to act next (the service's clock): the
 * sweeper resumes a chain that went quiet past it. An acknowledgement is recorded once, with
 * who (`acknowledged_by`, `acknowledged_user_id`), how (`acknowledged_via`) and when.
 */
export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    leadId: uuid("lead_id").$type<LeadId>(),
    /** Emergency class key from the emergency settings, for example "gas_leak". */
    emergencyClass: text("emergency_class").notNull(),
    summary: text("summary"),
    status: text("status", { enum: ESCALATION_STATUSES }).notNull().default("active"),
    currentStep: integer("current_step").notNull().default(0),
    /** Snapshot of the escalation contacts from settings when the chain started. */
    chain: jsonb("chain").$type<unknown[]>().notNull().default([]),
    /** Timing of the chain from settings when it started (acknowledge minutes, calls, rounds). */
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
    traceId: uuid("trace_id").$type<TraceId>(),
    nextActionAt: timestamptz("next_action_at"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    acknowledgedAt: timestamptz("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedVia: text("acknowledged_via", { enum: ESCALATION_ACK_CHANNELS }),
    acknowledgedUserId: uuid("acknowledged_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    endedAt: timestamptz("ended_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("escalations", t),
    conversationFk("escalations", t),
    leadFk("escalations", t),
    unique("escalations_id_business_key").on(t.id, t.businessId),
    uniqueIndex("escalations_active_conversation_key")
      .on(t.conversationId)
      .where(sql`${t.status} = 'active'`),
    index("escalations_business_status_idx").on(t.businessId, t.status),
    index("escalations_conversation_idx").on(t.conversationId),
    index("escalations_next_action_idx")
      .on(t.nextActionAt)
      .where(sql`${t.status} = 'active'`),
    check("escalations_status_check", oneOf(t.status, ESCALATION_STATUSES)),
    check(
      "escalations_acknowledged_via_check",
      sql`${t.acknowledgedVia} is null or ${oneOf(t.acknowledgedVia, ESCALATION_ACK_CHANNELS)}`,
    ),
    ...businessPolicies("escalations"),
  ],
);

/** One alert sent (or to be sent) to a person at the business or the agency (C13, C17). */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    leadId: uuid("lead_id").$type<LeadId>(),
    /** "lead_qualified", "handoff", "emergency", "send_failed", "job_stuck", ... */
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ALERT_SEVERITIES }).notNull().default("info"),
    /** "email", "sms", "whatsapp", "voice" or "in_app". */
    channel: text("channel").notNull(),
    /** Email address or phone number of the recipient. */
    recipient: text("recipient").notNull(),
    status: text("status", { enum: ALERT_STATUSES }).notNull().default("pending"),
    subject: text("subject"),
    body: text("body"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    dedupeKey: text("dedupe_key"),
    sentAt: timestamptz("sent_at"),
    acknowledgedAt: timestamptz("acknowledged_at"),
    /** Who acknowledged: a user id, a phone number or a name. */
    acknowledgedBy: text("acknowledged_by"),
    /** The emergency escalation this alert belongs to (C13), if any. */
    escalationId: uuid("escalation_id"),
    /**
     * SHA-256 of the secret in this alert's acknowledgement link (C13). The link carries the
     * alert id and the secret; the secret itself is never stored.
     */
    ackTokenHash: text("ack_token_hash"),
    /** SHA-256 of the alert id and the code a text-message alert asks to reply with (C13). */
    ackCodeHash: text("ack_code_hash"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("alerts", t),
    conversationFk("alerts", t),
    leadFk("alerts", t),
    foreignKey({
      name: "alerts_escalation_fk",
      columns: [t.escalationId, t.businessId],
      foreignColumns: [escalations.id, escalations.businessId],
    }).onDelete("cascade"),
    uniqueIndex("alerts_dedupe_key").on(t.businessId, t.dedupeKey),
    index("alerts_escalation_idx").on(t.escalationId),
    // Replies to an emergency text message are matched by the sender's number (C13).
    index("alerts_ack_recipient_idx")
      .on(t.recipient)
      .where(sql`${t.ackCodeHash} is not null`),
    index("alerts_business_created_idx").on(t.businessId, t.createdAt),
    index("alerts_status_idx").on(t.status, t.createdAt),
    check("alerts_severity_check", oneOf(t.severity, ALERT_SEVERITIES)),
    check("alerts_status_check", oneOf(t.status, ALERT_STATUSES)),
    ...businessPolicies("alerts"),
  ],
);

/**
 * Where a job lands after its last retry failed (ARCHITECTURE §4). The tenant columns are
 * nullable because a failure can happen before the tenant is known; such rows are visible
 * to the platform operator only. `conversation_id` and `message_id` are plain values, not
 * foreign keys, so the record survives the rows it points at.
 */
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .references(() => agencies.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").$type<BusinessId>(),
    /** Function id, for example "pipeline-reply". */
    source: text("source").notNull(),
    eventName: text("event_name"),
    eventId: text("event_id"),
    traceId: uuid("trace_id").$type<TraceId>(),
    conversationId: uuid("conversation_id").$type<ConversationId>(),
    messageId: uuid("message_id").$type<MessageId>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message").notNull(),
    retryable: boolean("retryable"),
    attempts: integer("attempts").notNull().default(1),
    /** The job payload: ids and classifications only. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: DEAD_LETTER_STATUSES }).notNull().default("open"),
    resolvedAt: timestamptz("resolved_at"),
    resolvedBy: uuid("resolved_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("dead_letters", t),
    index("dead_letters_agency_created_idx").on(t.agencyId, t.createdAt),
    index("dead_letters_business_idx").on(t.businessId),
    index("dead_letters_status_idx").on(t.status, t.createdAt),
    check("dead_letters_status_check", oneOf(t.status, DEAD_LETTER_STATUSES)),
    // The tenant foreign key only bites when both columns are set.
    check("dead_letters_tenant_check", sql`${t.businessId} is null or ${t.agencyId} is not null`),
    ...sharedPolicies("dead_letters"),
  ],
);

/**
 * Fixed-window counters for rate limits and spend caps (C17), kept in PostgreSQL.
 * Count with one statement:
 * `insert ... on conflict (...) do update set value = usage_counters.value + excluded.value returning value`.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    /** "inbound_messages", "model_calls", "model_spend_micro_usd", ... */
    metric: text("metric").notNull(),
    /** What is being counted for: "business", "contact:<id>", "widget_session:<id>". */
    subject: text("subject").notNull().default("business"),
    windowStart: timestamptz("window_start").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("usage_counters", t),
    uniqueIndex("usage_counters_window_key").on(
      t.businessId,
      t.metric,
      t.subject,
      t.windowStart,
      t.windowSeconds,
    ),
    index("usage_counters_window_idx").on(t.windowStart),
    ...businessPolicies("usage_counters"),
  ],
);

/**
 * Who did what. Append-only: there is no update or delete policy for any role, and a
 * trigger refuses updates even on the unrestricted connection. A signed-in staff member can
 * add entries only under their own name; the system scope adds the rest. A null
 * `business_id` is an agency-level entry. Never put a secret in `before`, `after` or
 * `metadata`.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").$type<BusinessId>(),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    /** The actor as text (email, key name, job id), kept when the user row is gone. */
    actorLabel: text("actor_label"),
    /** `area.verb`, for example "settings.update" or "business.create". */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    summary: text("summary"),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    traceId: uuid("trace_id").$type<TraceId>(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("audit_log", t),
    index("audit_log_agency_created_idx").on(t.agencyId, t.createdAt),
    index("audit_log_business_created_idx").on(t.businessId, t.createdAt),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    check("audit_log_actor_type_check", oneOf(t.actorType, AUDIT_ACTOR_TYPES)),
    ...userPolicies("audit_log", {
      select: ADMIN_OF_AGENCY,
      insert: `(${STAFF_OF_AGENCY} and actor_type = 'user' and actor_user_id = ${CURRENT_USER})`,
    }),
    ...systemPolicies(
      "audit_log",
      { read: IN_SHARED_SCOPE, write: IN_SHARED_SCOPE },
      "append_only",
    ),
  ],
);
