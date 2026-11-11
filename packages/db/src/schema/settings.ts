import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  type AgencyId,
  type BusinessId,
  type SegmentId,
  SETTING_SCOPES,
  type UserId,
} from "@repo/core";

import { tenantFk } from "./businesses";
import { createdAt, oneOf, updatedAt } from "./columns";
import {
  ADMIN_OF_AGENCY,
  CURRENT_USER,
  IN_SHARED_SCOPE,
  IN_SHARED_SCOPE_WITH_AGENCY_ROWS,
  STAFF_OF_AGENCY,
  systemPolicies,
  userPolicies,
} from "./policies";
import { segments } from "./playbooks";
import { agencies, users } from "./tenancy";
import { SETTING_OPERATIONS } from "./vocab";

/**
 * Settings storage for C2. The registry (keys, types, defaults) lives in `@repo/settings`;
 * these tables hold only the overrides.
 *
 * A row belongs to exactly one scope:
 *   global   - the whole agency            (segment_id and business_id are null)
 *   segment  - every business of a segment (segment_id set)
 *   business - one business                (business_id set)
 *
 * Signed-in agency staff may change business-scope rows; global and segment rows need an
 * agency admin. A history row written as a user must name that user in `changed_by`. Client
 * users never touch these tables: the server resolves settings for them and applies the
 * registry's "client may edit" flag.
 */
const SCOPE_TARGET_CHECK = sql`(scope = 'global' and segment_id is null and business_id is null) or (scope = 'segment' and segment_id is not null and business_id is null) or (scope = 'business' and segment_id is null and business_id is not null)`;

const USER_WRITE = `((scope = 'business' and ${STAFF_OF_AGENCY}) or ${ADMIN_OF_AGENCY})`;

/** The override currently in force for one key in one scope. Deleting the row resets it. */
export const settingValues = pgTable(
  "setting_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: SETTING_SCOPES }).notNull(),
    segmentId: uuid("segment_id").$type<SegmentId>(),
    businessId: uuid("business_id").$type<BusinessId>(),
    key: text("key").notNull(),
    /** SQL NULL stores an explicit JSON null override. */
    value: jsonb("value").$type<unknown>(),
    /** Version of this key in this scope; matches the newest row in `setting_versions`. */
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("setting_values", t),
    foreignKey({
      name: "setting_values_segment_fk",
      columns: [t.segmentId, t.agencyId],
      foreignColumns: [segments.id, segments.agencyId],
    }).onDelete("cascade"),
    check("setting_values_scope_check", oneOf(t.scope, SETTING_SCOPES)),
    check("setting_values_scope_target_check", SCOPE_TARGET_CHECK),
    uniqueIndex("setting_values_global_key")
      .on(t.agencyId, t.key)
      .where(sql`scope = 'global'`),
    uniqueIndex("setting_values_segment_key")
      .on(t.segmentId, t.key)
      .where(sql`scope = 'segment'`),
    uniqueIndex("setting_values_business_key")
      .on(t.businessId, t.key)
      .where(sql`scope = 'business'`),
    ...userPolicies("setting_values", {
      select: STAFF_OF_AGENCY,
      insert: USER_WRITE,
      update: USER_WRITE,
      delete: USER_WRITE,
    }),
    // A business scope reads the agency-level rows too: the resolver needs global and
    // segment values to resolve one business. It can still only write its own rows.
    ...systemPolicies("setting_values", {
      read: IN_SHARED_SCOPE_WITH_AGENCY_ROWS,
      write: IN_SHARED_SCOPE,
    }),
  ],
);

/** Append-only history of every change to a setting, including resets. */
export const settingVersions = pgTable(
  "setting_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: SETTING_SCOPES }).notNull(),
    segmentId: uuid("segment_id").$type<SegmentId>(),
    businessId: uuid("business_id").$type<BusinessId>(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    operation: text("operation", { enum: SETTING_OPERATIONS }).notNull(),
    /** The value set; null for a reset (and for an explicit JSON null). */
    value: jsonb("value").$type<unknown>(),
    previousValue: jsonb("previous_value").$type<unknown>(),
    changedBy: uuid("changed_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    changeNote: text("change_note"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("setting_versions", t),
    foreignKey({
      name: "setting_versions_segment_fk",
      columns: [t.segmentId, t.agencyId],
      foreignColumns: [segments.id, segments.agencyId],
    }).onDelete("cascade"),
    check("setting_versions_scope_check", oneOf(t.scope, SETTING_SCOPES)),
    check("setting_versions_scope_target_check", SCOPE_TARGET_CHECK),
    check("setting_versions_operation_check", oneOf(t.operation, SETTING_OPERATIONS)),
    uniqueIndex("setting_versions_global_key")
      .on(t.agencyId, t.key, t.version)
      .where(sql`scope = 'global'`),
    uniqueIndex("setting_versions_segment_key")
      .on(t.segmentId, t.key, t.version)
      .where(sql`scope = 'segment'`),
    uniqueIndex("setting_versions_business_key")
      .on(t.businessId, t.key, t.version)
      .where(sql`scope = 'business'`),
    index("setting_versions_agency_created_idx").on(t.agencyId, t.createdAt),
    // No update and no delete policy for anyone; a trigger refuses updates as well. A
    // signed-in user records history only under their own name (as in the audit log).
    ...userPolicies("setting_versions", {
      select: STAFF_OF_AGENCY,
      insert: `(${USER_WRITE} and changed_by = ${CURRENT_USER})`,
    }),
    ...systemPolicies(
      "setting_versions",
      { read: IN_SHARED_SCOPE_WITH_AGENCY_ROWS, write: IN_SHARED_SCOPE },
      "append_only",
    ),
  ],
);
