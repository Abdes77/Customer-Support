import { type SQL, sql } from "drizzle-orm";
import {
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

import { type AgencyId, type BusinessId, KNOWLEDGE_CATEGORIES, type UserId } from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, tenantColumns, timestamptz, tsvector, updatedAt } from "./columns";
import { businessPolicies, sharedPolicies } from "./policies";
import { agencies, users } from "./tenancy";
import { IMPORT_RUN_KINDS, IMPORT_RUN_STATUSES, KNOWLEDGE_ITEM_STATUSES } from "./vocab";

/**
 * One run of a lead-generation data import (CSV upload, API call or website crawl). A null
 * `business_id` is an agency-wide import that touches several businesses.
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").$type<BusinessId>(),
    kind: text("kind", { enum: IMPORT_RUN_KINDS }).notNull(),
    status: text("status", { enum: IMPORT_RUN_STATUSES }).notNull().default("pending"),
    fileName: text("file_name"),
    /** Column-to-field mapping chosen for this run. */
    mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull().default({}),
    /** Counters: rows read, imported, skipped, failed. */
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    /** Row-level validation errors, safe to show in the admin panel. */
    errors: jsonb("errors").$type<unknown[]>().notNull().default([]),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("import_runs", t),
    unique("import_runs_id_agency_key").on(t.id, t.agencyId),
    index("import_runs_agency_created_idx").on(t.agencyId, t.createdAt),
    index("import_runs_business_idx").on(t.businessId),
    check("import_runs_kind_check", oneOf(t.kind, IMPORT_RUN_KINDS)),
    check("import_runs_status_check", oneOf(t.status, IMPORT_RUN_STATUSES)),
    ...sharedPolicies("import_runs", { insert: "staff", update: "staff" }),
  ],
);

/**
 * One fact about a business (services, service area, hours, licenses, ...), editable in the
 * admin panel. `search` backs the retrieval function of C6 (PostgreSQL full-text search).
 */
export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    category: text("category", { enum: KNOWLEDGE_CATEGORIES }).notNull(),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    /** "csv_import", "api", "website", "manual" or a URL. */
    source: text("source"),
    importRunId: uuid("import_run_id"),
    /** Core facts go into every prompt (the cached part); the rest is retrieved per turn. */
    isCore: boolean("is_core").notNull().default(false),
    status: text("status", { enum: KNOWLEDGE_ITEM_STATUSES }).notNull().default("active"),
    position: integer("position").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    search: tsvector("search").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${knowledgeItems.title}, '') || ' ' || coalesce(${knowledgeItems.content}, ''))`,
    ),
    updatedBy: uuid("updated_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("knowledge_items", t),
    foreignKey({
      name: "knowledge_items_import_run_fk",
      columns: [t.importRunId, t.agencyId],
      foreignColumns: [importRuns.id, importRuns.agencyId],
    }),
    index("knowledge_items_business_category_idx").on(t.businessId, t.category, t.position),
    index("knowledge_items_search_idx").using("gin", t.search),
    check("knowledge_items_category_check", oneOf(t.category, KNOWLEDGE_CATEGORIES)),
    check("knowledge_items_status_check", oneOf(t.status, KNOWLEDGE_ITEM_STATUSES)),
    ...businessPolicies("knowledge_items", {
      clientRead: true,
      insert: "staff",
      update: "staff",
      delete: "staff",
    }),
  ],
);

/**
 * A business's replacement for one section of its segment playbook (for example its own
 * "objections"). The engine sees the segment playbook with these sections swapped in.
 */
export const businessPlaybookOverrides = pgTable(
  "business_playbook_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    /** A key of `PlaybookDocument`, for example "objections". */
    section: text("section").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    /** The playbook version the override was written against. */
    baseVersion: integer("base_version"),
    updatedBy: uuid("updated_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("business_playbook_overrides", t),
    uniqueIndex("business_playbook_overrides_section_key").on(t.businessId, t.section),
    ...businessPolicies("business_playbook_overrides", {
      insert: "staff",
      update: "staff",
      delete: "staff",
    }),
  ],
);
