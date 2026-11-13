import { sql } from "drizzle-orm";
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

import type { AgencyId, PlaybookDocument, SegmentId, TraceId, UserId } from "@repo/core";

import { createdAt, oneOf, timestamptz, updatedAt } from "./columns";
import { agencyPolicies } from "./policies";
import { agencies, users } from "./tenancy";
import {
  PLAYBOOK_GENERATION_REASONS,
  PLAYBOOK_GENERATION_STATUSES,
  PLAYBOOK_ORIGINS,
} from "./vocab";

/**
 * An industry segment served by the agency ("roofing", "hvac"). Segments belong to one
 * agency, so its playbooks and segment-level settings are invisible to any other agency.
 */
export const segments = pgTable(
  "segments",
  {
    id: uuid("id").$type<SegmentId>().primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of the composite foreign keys that keep a segment and its agency together.
    unique("segments_id_agency_key").on(t.id, t.agencyId),
    uniqueIndex("segments_agency_slug_key").on(t.agencyId, t.slug),
    ...agencyPolicies("segments", { insert: "staff", update: "staff", delete: "admin" }),
  ],
);

/**
 * One version of a segment's industry playbook. Versions are immutable documents: a trigger
 * (migration 0006) refuses every update except the `is_active` flag, on every connection,
 * so an edit, a generation and a rollback each insert a new version. At most one version
 * per segment is active. Nobody deletes a version as a signed-in user; versions go when
 * their segment goes. `@repo/knowledge` (C6) is the code that writes this table.
 */
export const playbookVersions = pgTable(
  "playbook_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id").$type<AgencyId>().notNull(),
    segmentId: uuid("segment_id").$type<SegmentId>().notNull(),
    version: integer("version").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    origin: text("origin", { enum: PLAYBOOK_ORIGINS }).notNull().default("manual"),
    document: jsonb("document").$type<PlaybookDocument>().notNull(),
    changeNote: text("change_note"),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "playbook_versions_segment_fk",
      columns: [t.segmentId, t.agencyId],
      foreignColumns: [segments.id, segments.agencyId],
    }).onDelete("cascade"),
    uniqueIndex("playbook_versions_segment_version_key").on(t.segmentId, t.version),
    uniqueIndex("playbook_versions_active_key")
      .on(t.segmentId)
      .where(sql`${t.isActive}`),
    check("playbook_versions_version_check", sql`${t.version} > 0`),
    check("playbook_versions_origin_check", oneOf(t.origin, PLAYBOOK_ORIGINS)),
    ...agencyPolicies("playbook_versions", { insert: "staff", update: "staff" }),
  ],
);

/**
 * One run of playbook generation for a segment: asked for when a business is onboarded in a
 * segment without a playbook, or by an admin. The row is the progress the admin panel shows
 * and the lock that keeps a segment to one run at a time (`playbook_generations_open_key`).
 * Written only through the system scope; agency staff read it.
 */
export const playbookGenerations = pgTable(
  "playbook_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id").$type<AgencyId>().notNull(),
    segmentId: uuid("segment_id").$type<SegmentId>().notNull(),
    status: text("status", { enum: PLAYBOOK_GENERATION_STATUSES }).notNull().default("pending"),
    reason: text("reason", { enum: PLAYBOOK_GENERATION_REASONS }).notNull(),
    requestedBy: uuid("requested_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    traceId: uuid("trace_id").$type<TraceId>().notNull(),
    /** The playbook version the run produced. */
    version: integer("version"),
    /** Progress and totals: step, searches, sources, model calls, tokens. Never content. */
    stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
    errorCode: text("error_code"),
    /** Safe to show in the admin panel. */
    errorMessage: text("error_message"),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "playbook_generations_segment_fk",
      columns: [t.segmentId, t.agencyId],
      foreignColumns: [segments.id, segments.agencyId],
    }).onDelete("cascade"),
    index("playbook_generations_segment_idx").on(t.segmentId, t.createdAt),
    uniqueIndex("playbook_generations_open_key")
      .on(t.segmentId)
      .where(sql`${t.status} in ('pending', 'running')`),
    check("playbook_generations_status_check", oneOf(t.status, PLAYBOOK_GENERATION_STATUSES)),
    check("playbook_generations_reason_check", oneOf(t.reason, PLAYBOOK_GENERATION_REASONS)),
    ...agencyPolicies("playbook_generations"),
  ],
);
