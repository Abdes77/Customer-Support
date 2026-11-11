import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  type AgencyId,
  type BusinessId,
  CLIENT_ROLES,
  type SegmentId,
  type UserId,
} from "@repo/core";

import { createdAt, oneOf, tenantColumns, timestamptz, updatedAt } from "./columns";
import {
  ADMIN_OF_AGENCY,
  CURRENT_USER,
  IN_AGENCY_WIDE_SCOPE,
  IN_BUSINESS_SCOPE,
  STAFF_OF_AGENCY,
  sharedPolicies,
  systemPolicies,
  systemRole,
  userPolicies,
} from "./policies";
import { segments } from "./playbooks";
import { agencies, users } from "./tenancy";
import { BUSINESS_STATUSES } from "./vocab";

/**
 * A client business of the agency: the tenant every conversation, lead and setting belongs
 * to. `client_portal_enabled` is the master switch for client logins: row-level security
 * reads it, so it is a column and not a setting (finer client permissions are settings,
 * enforced in server code).
 */
export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").$type<BusinessId>().primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    /** Null only while the business is being onboarded. */
    segmentId: uuid("segment_id").$type<SegmentId>(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", { enum: BUSINESS_STATUSES }).notNull().default("onboarding"),
    /** IANA time zone, for example "America/Chicago". */
    timezone: text("timezone").notNull().default("America/New_York"),
    clientPortalEnabled: boolean("client_portal_enabled").notNull().default(false),
    websiteUrl: text("website_url"),
    phone: text("phone"),
    email: text("email"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("US"),
    /** The business's id in the agency's lead-generation data, for imports (C6). */
    externalRef: text("external_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of every tenant foreign key: a row's business and agency always belong together.
    unique("businesses_id_agency_key").on(t.id, t.agencyId),
    uniqueIndex("businesses_agency_slug_key").on(t.agencyId, t.slug),
    uniqueIndex("businesses_agency_external_ref_key").on(t.agencyId, t.externalRef),
    foreignKey({
      name: "businesses_segment_fk",
      columns: [t.segmentId, t.agencyId],
      foreignColumns: [segments.id, segments.agencyId],
    }),
    check("businesses_status_check", oneOf(t.status, BUSINESS_STATUSES)),
    check(
      "businesses_active_segment_check",
      sql`${t.status} <> 'active' or ${t.segmentId} is not null`,
    ),
    ...userPolicies("businesses", {
      select: `(${STAFF_OF_AGENCY} or id in (select app.client_business_ids()))`,
      insert: STAFF_OF_AGENCY,
      update: STAFF_OF_AGENCY,
      delete: ADMIN_OF_AGENCY,
    }),
    pgPolicy("businesses_select_system", {
      for: "select",
      to: systemRole,
      using: sql`(id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))`,
    }),
    pgPolicy("businesses_insert_system", {
      for: "insert",
      to: systemRole,
      withCheck: sql.raw(IN_AGENCY_WIDE_SCOPE),
    }),
    pgPolicy("businesses_update_system", {
      for: "update",
      to: systemRole,
      using: sql`(id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))`,
      withCheck: sql`(id = (select app.scope_business_id()) or agency_id = (select app.scope_agency_wide_id()))`,
    }),
    pgPolicy("businesses_delete_system", {
      for: "delete",
      to: systemRole,
      using: sql.raw(IN_AGENCY_WIDE_SCOPE),
    }),
  ],
);

/**
 * The tenant foreign key every table with business data declares:
 * `(business_id, agency_id)` must be a real business of that agency, and the rows go when
 * the business goes.
 */
export function tenantFk(
  table: string,
  t: { readonly businessId: AnyPgColumn; readonly agencyId: AnyPgColumn },
) {
  return foreignKey({
    name: `${table}_tenant_fk`,
    columns: [t.businessId, t.agencyId],
    foreignColumns: [businesses.id, businesses.agencyId],
  }).onDelete("cascade");
}

/** Client logins: client_owner or client_staff of one business. */
export const businessMemberships = pgTable(
  "business_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...tenantColumns(),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: CLIENT_ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantFk("business_memberships", t),
    uniqueIndex("business_memberships_business_user_key").on(t.businessId, t.userId),
    index("business_memberships_user_idx").on(t.userId),
    check("business_memberships_role_check", oneOf(t.role, CLIENT_ROLES)),
    // A user always sees their own membership (so the app can explain "client logins are
    // switched off for your business"); an owner sees the team; staff see everything.
    ...userPolicies("business_memberships", {
      select: `(${STAFF_OF_AGENCY} or user_id = ${CURRENT_USER} or business_id in (select app.client_owner_business_ids()))`,
      insert: ADMIN_OF_AGENCY,
      update: ADMIN_OF_AGENCY,
      delete: ADMIN_OF_AGENCY,
    }),
    ...systemPolicies("business_memberships", {
      read: IN_BUSINESS_SCOPE,
      write: IN_BUSINESS_SCOPE,
    }),
  ],
);

/**
 * Keys for the import API (C6). Only a SHA-256 hash of the key is stored; the key itself is
 * shown once, when it is created. A null `business_id` is an agency-wide key.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").$type<BusinessId>(),
    name: text("name").notNull(),
    /** First characters of the key, shown in the admin panel to tell keys apart. */
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamptz("last_used_at"),
    expiresAt: timestamptz("expires_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    tenantFk("api_keys", t),
    uniqueIndex("api_keys_key_hash_key").on(t.keyHash),
    uniqueIndex("api_keys_key_prefix_key").on(t.keyPrefix),
    index("api_keys_agency_idx").on(t.agencyId),
    ...sharedPolicies("api_keys", {
      read: "admin",
      insert: "admin",
      update: "admin",
      delete: "admin",
    }),
  ],
);
