import { sql } from "drizzle-orm";
import { check, index, pgPolicy, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { AGENCY_ROLES, type AgencyId, type UserId } from "@repo/core";

import { createdAt, oneOf, updatedAt } from "./columns";
import { agencyPolicies, authenticatedRole, systemRole, userPolicies } from "./policies";

/** The agency that operates the system for its client businesses. Top of the tenancy tree. */
export const agencies = pgTable(
  "agencies",
  {
    id: uuid("id").$type<AgencyId>().primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agencies_slug_key").on(t.slug),
    // Agencies are created and deleted by the platform operator (scripts), never by a user.
    ...userPolicies("agencies", {
      select: "id in (select app.staff_agency_ids())",
      update: "id in (select app.admin_agency_ids())",
    }),
    pgPolicy("agencies_select_system", {
      for: "select",
      to: systemRole,
      using: sql`id = (select app.scope_agency_id())`,
    }),
    pgPolicy("agencies_update_system", {
      for: "update",
      to: systemRole,
      using: sql`id = (select app.scope_agency_wide_id())`,
      withCheck: sql`id = (select app.scope_agency_wide_id())`,
    }),
  ],
);

/**
 * Profile of a person who can sign in. `id` is the Supabase Auth user id: migration 0002 adds
 * the foreign key to `auth.users` and the trigger that keeps this row in step with it.
 * What a user may do comes from the two membership tables, never from this row.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").$type<UserId>().primaryKey(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("users_email_idx").on(sql`lower(${t.email})`),
    // A user sees their own profile and the people they work with (same agency, or members
    // of a business of that agency). Profiles are written by the auth trigger only.
    pgPolicy("users_select_user", {
      for: "select",
      to: authenticatedRole,
      using: sql`id in (select app.visible_user_ids())`,
    }),
    pgPolicy("users_select_system", {
      for: "select",
      to: systemRole,
      using: sql`id in (select app.scope_user_ids())`,
    }),
  ],
);

/** Agency staff: agency_admin or agency_member. Staff see every business of the agency. */
export const agencyMemberships = pgTable(
  "agency_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyId: uuid("agency_id")
      .$type<AgencyId>()
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: AGENCY_ROLES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agency_memberships_agency_user_key").on(t.agencyId, t.userId),
    index("agency_memberships_user_idx").on(t.userId),
    check("agency_memberships_role_check", oneOf(t.role, AGENCY_ROLES)),
    // Staff see who else is on the team; only admins change it.
    ...agencyPolicies("agency_memberships", {
      insert: "admin",
      update: "admin",
      delete: "admin",
    }),
  ],
);
