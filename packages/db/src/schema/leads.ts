import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  type ContactId,
  type ConversationId,
  LEAD_EVENT_NAMES,
  LEAD_STATUSES,
  type LeadId,
  ROUTING_OUTCOMES,
  type TraceId,
} from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import { contactFk, conversationFk } from "./conversations";
import { businessPolicies } from "./policies";

/*
 * Lead tables are written by scoring and routing (C5) through the system scope and are
 * read-only for signed-in users, like the conversation tables.
 */

/**
 * The lead of one conversation. `score`, `band` and `routing_outcome` mirror the newest row
 * of `routing_decisions`, so lists and filters need no join.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").$type<LeadId>().primaryKey().defaultRandom(),
    ...tenantColumns(),
    contactId: uuid("contact_id").$type<ContactId>().notNull(),
    conversationId: uuid("conversation_id").$type<ConversationId>().notNull(),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("new"),
    /** 0 to 100. Every lead always has a score. */
    score: real("score").notNull().default(0),
    band: text("band"),
    routingOutcome: text("routing_outcome", { enum: ROUTING_OUTCOMES }),
    routingDecidedAt: timestamptz("routing_decided_at"),
    /** `ResolvedSettings.version` the current score and routing were computed under. */
    settingsVersion: text("settings_version"),
    qualifiedAt: timestamptz("qualified_at"),
    disqualifiedAt: timestamptz("disqualified_at"),
    disqualifyReason: text("disqualify_reason"),
    handedOffAt: timestamptz("handed_off_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("leads", t),
    contactFk("leads", t),
    conversationFk("leads", t),
    unique("leads_id_business_key").on(t.id, t.businessId),
    uniqueIndex("leads_conversation_key").on(t.conversationId),
    index("leads_business_status_idx").on(t.businessId, t.status),
    index("leads_business_created_idx").on(t.businessId, t.createdAt),
    index("leads_contact_idx").on(t.contactId),
    check("leads_status_check", oneOf(t.status, LEAD_STATUSES)),
    check("leads_score_check", sql`${t.score} >= 0 and ${t.score} <= 100`),
    check(
      "leads_routing_outcome_check",
      sql`${t.routingOutcome} is null or ${oneOf(t.routingOutcome, ROUTING_OUTCOMES)}`,
    ),
    ...businessPolicies("leads", { clientRead: true }),
  ],
);

/** A child row's `(lead_id, business_id)` must be a lead of that business. */
export function leadFk(
  table: string,
  t: { readonly leadId: AnyPgColumn; readonly businessId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_lead_fk`,
    columns: [t.leadId, t.businessId],
    foreignColumns: [leads.id, leads.businessId],
  }).onDelete("cascade");
}

/** One qualification criterion as currently known: value, confidence and evidence. */
export const leadFields = pgTable(
  "lead_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    leadId: uuid("lead_id").$type<LeadId>().notNull(),
    /** Criterion key from the settings registry, for example "timeline". */
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>(),
    /** 0 = guess, 1 = stated outright by the customer. */
    confidence: real("confidence").notNull(),
    /** Short quote or paraphrase from the conversation that supports the value. */
    evidence: text("evidence"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("lead_fields", t),
    leadFk("lead_fields", t),
    uniqueIndex("lead_fields_lead_key").on(t.leadId, t.key),
    index("lead_fields_business_idx").on(t.businessId),
    check("lead_fields_confidence_check", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    ...businessPolicies("lead_fields", { clientRead: true }),
  ],
);

/** The written report for the business. Each rewrite is a new version; the newest counts. */
export const leadReports = pgTable(
  "lead_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    leadId: uuid("lead_id").$type<LeadId>().notNull(),
    version: integer("version").notNull(),
    summary: text("summary").notNull(),
    markdown: text("markdown").notNull(),
    /** Who, what job, where, urgency, budget signals, fit, red flags, next step. */
    sections: jsonb("sections").$type<Record<string, unknown>>().notNull().default({}),
    score: real("score"),
    band: text("band"),
    settingsVersion: text("settings_version"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("lead_reports", t),
    leadFk("lead_reports", t),
    uniqueIndex("lead_reports_lead_version_key").on(t.leadId, t.version),
    index("lead_reports_business_idx").on(t.businessId),
    ...businessPolicies("lead_reports", { clientRead: true }),
  ],
);

/** History of routing decisions (`RoutingDecision` in @repo/core), newest last. */
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    leadId: uuid("lead_id").$type<LeadId>().notNull(),
    /**
     * Order of the decisions of one lead (1, 2, ...): the newest counts. Two decisions made
     * in one transaction share `created_at` and may share `decided_at` (C5, migration 0007).
     */
    sequence: integer("sequence").notNull().default(1),
    outcome: text("outcome", { enum: ROUTING_OUTCOMES }).notNull(),
    score: real("score").notNull(),
    band: text("band").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    settingsVersion: text("settings_version").notNull(),
    traceId: uuid("trace_id").$type<TraceId>(),
    decidedAt: timestamptz("decided_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("routing_decisions", t),
    leadFk("routing_decisions", t),
    index("routing_decisions_lead_idx").on(t.leadId, t.decidedAt),
    index("routing_decisions_lead_sequence_idx").on(t.leadId, t.sequence),
    index("routing_decisions_business_idx").on(t.businessId),
    check("routing_decisions_outcome_check", oneOf(t.outcome, ROUTING_OUTCOMES)),
    ...businessPolicies("routing_decisions", { clientRead: true }),
  ],
);

/**
 * The outbox of `lead.*` events (C5). A row is written in the transaction that records the
 * fact (a routing decision, an emergency, a handoff), with a `dedupe_key` that makes the
 * same fact one event per lead; it is sent after the turn commits, or by the `leads-outbox`
 * cron when the turn did not get that far. The row id is the event's `eventId`. `payload`
 * is the event payload: ids and classifications only, never customer text.
 */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    leadId: uuid("lead_id").$type<LeadId>().notNull(),
    name: text("name", { enum: LEAD_EVENT_NAMES }).notNull(),
    /** One event per lead and key, for example "qualified" or "emergency:gas_leak:<turn>". */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    /** Set once the event was handed to the job platform. */
    emittedAt: timestamptz("emitted_at"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("lead_events", t),
    leadFk("lead_events", t),
    uniqueIndex("lead_events_lead_dedupe_key").on(t.leadId, t.dedupeKey),
    index("lead_events_business_pending_idx")
      .on(t.businessId, t.createdAt)
      .where(sql`${t.emittedAt} is null`),
    check("lead_events_name_check", oneOf(t.name, LEAD_EVENT_NAMES)),
    ...businessPolicies("lead_events"),
  ],
);
