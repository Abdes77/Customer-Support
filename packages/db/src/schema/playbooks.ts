import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { AgencyId, PlaybookDocument, SegmentId, UserId } from "@repo/core";

import { createdAt, oneOf, updatedAt } from "./columns";
import { agencyPolicies } from "./policies";
import { agencies, users } from "./tenancy";
import { PLAYBOOK_ORIGINS } from "./vocab";

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
 * One version of a segment's industry playbook. Versions are immutable documents; exactly
 * one per segment is active. C6 generates, edits, diffs and rolls them back.
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
    ...agencyPolicies("playbook_versions", {
      insert: "staff",
      update: "staff",
      delete: "admin",
    }),
  ],
);
