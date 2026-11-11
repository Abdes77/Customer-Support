import { sql } from "drizzle-orm";
import { type PgPolicy, pgPolicy, pgRole } from "drizzle-orm/pg-core";

/**
 * Row-level security, declared next to the tables.
 *
 * Two restricted roles reach the tables; the connection role itself is only used by the few
 * audited cross-tenant functions inside this package.
 *
 * - `authenticated`: a signed-in user (`Database.asUser`, and Supabase's REST and Realtime
 *   APIs). Rows are matched against the user's memberships through the SECURITY DEFINER
 *   helpers in schema `app` (migration 0000): agency staff reach their agency, client users
 *   reach their own business when it has client logins enabled, and only on tables that are
 *   marked `clientRead`. Tables written by the message pipeline are read-only for users.
 * - `app_system`: jobs and webhooks (`Database.forBusiness` / `forAgency`). Rows are matched
 *   against the tenant the scope entered, held in transaction-local settings. A job that
 *   forgets a `business_id` predicate still cannot read or write another tenant.
 *
 * A table without a policy for a role is invisible to that role, and
 * `app.sync_table_privileges()` grants each role only the commands its policies cover.
 *
 * To add a table: spread `businessPolicies(...)`, `sharedPolicies(...)` or
 * `agencyPolicies(...)` into the table's extra config, then add the table to the isolation
 * matrix in `src/testing/isolation-matrix.ts` (the isolation suite fails until you do).
 */

/** Supabase's role for signed-in users. Created by the compatibility bootstrap locally. */
export const authenticatedRole = pgRole("authenticated").existing();

/** The tenant-scoped role of jobs and webhooks. Created by migration 0000. */
export const systemRole = pgRole("app_system").existing();

export type StaffLevel = "staff" | "admin";

export interface UserAccess {
  /** Agency role that may read. Default "staff" (agency_admin and agency_member). */
  readonly read?: StaffLevel;
  /** Client users of the row's business may read it. Default false. */
  readonly clientRead?: boolean;
  /** Agency role that may insert, update or delete as a signed-in user. Default: nobody. */
  readonly insert?: StaffLevel;
  readonly update?: StaffLevel;
  readonly delete?: StaffLevel;
}

export interface PolicyOptions extends UserAccess {
  /**
   * What the system scope may do. "read_write" (default), "append_only" (select and insert)
   * or "read_only".
   */
  readonly system?: "read_write" | "append_only" | "read_only";
}

export const STAFF_OF_AGENCY = "agency_id in (select app.staff_agency_ids())";
export const ADMIN_OF_AGENCY = "agency_id in (select app.admin_agency_ids())";
export const CLIENT_OF_BUSINESS = "business_id in (select app.client_business_ids())";
export const CURRENT_USER = "(select auth.uid())";

const SCOPE_AGENCY = "(select app.scope_agency_id())";
const SCOPE_AGENCY_WIDE = "(select app.scope_agency_wide_id())";
const SCOPE_BUSINESS = "(select app.scope_business_id())";

/** Rows of the entered business, or of the whole agency when the scope is agency-wide. */
export const IN_BUSINESS_SCOPE = `(business_id = ${SCOPE_BUSINESS} or agency_id = ${SCOPE_AGENCY_WIDE})`;
/** Any scope inside the row's agency (a business scope may read agency-level rows). */
export const IN_AGENCY_SCOPE = `agency_id = ${SCOPE_AGENCY}`;
/** Only a scope that covers the whole agency. */
export const IN_AGENCY_WIDE_SCOPE = `agency_id = ${SCOPE_AGENCY_WIDE}`;
/** Tables whose `business_id` may be null: a business scope writes only its own rows. */
export const IN_SHARED_SCOPE = `(agency_id = ${SCOPE_AGENCY} and (${SCOPE_BUSINESS} is null or business_id = ${SCOPE_BUSINESS}))`;
/** As above, and a business scope also reads the agency-level rows (business_id is null). */
export const IN_SHARED_SCOPE_WITH_AGENCY_ROWS = `(agency_id = ${SCOPE_AGENCY} and (${SCOPE_BUSINESS} is null or business_id is null or business_id = ${SCOPE_BUSINESS}))`;

function staff(level: StaffLevel): string {
  return level === "admin" ? ADMIN_OF_AGENCY : STAFF_OF_AGENCY;
}

/** Policies for `authenticated`, from predicates written as SQL text. */
export function userPolicies(
  table: string,
  predicates: {
    readonly select?: string;
    readonly insert?: string;
    readonly update?: string;
    readonly delete?: string;
  },
): PgPolicy[] {
  const policies: PgPolicy[] = [];
  if (predicates.select !== undefined) {
    policies.push(
      pgPolicy(`${table}_select_user`, {
        for: "select",
        to: authenticatedRole,
        using: sql.raw(predicates.select),
      }),
    );
  }
  if (predicates.insert !== undefined) {
    policies.push(
      pgPolicy(`${table}_insert_user`, {
        for: "insert",
        to: authenticatedRole,
        withCheck: sql.raw(predicates.insert),
      }),
    );
  }
  if (predicates.update !== undefined) {
    policies.push(
      pgPolicy(`${table}_update_user`, {
        for: "update",
        to: authenticatedRole,
        using: sql.raw(predicates.update),
        withCheck: sql.raw(predicates.update),
      }),
    );
  }
  if (predicates.delete !== undefined) {
    policies.push(
      pgPolicy(`${table}_delete_user`, {
        for: "delete",
        to: authenticatedRole,
        using: sql.raw(predicates.delete),
      }),
    );
  }
  return policies;
}

/** Policies for `app_system`, from a read predicate and a write predicate. */
export function systemPolicies(
  table: string,
  predicates: { readonly read: string; readonly write: string },
  mode: NonNullable<PolicyOptions["system"]> = "read_write",
): PgPolicy[] {
  const policies: PgPolicy[] = [
    pgPolicy(`${table}_select_system`, {
      for: "select",
      to: systemRole,
      using: sql.raw(predicates.read),
    }),
  ];
  if (mode === "read_only") return policies;
  policies.push(
    pgPolicy(`${table}_insert_system`, {
      for: "insert",
      to: systemRole,
      withCheck: sql.raw(predicates.write),
    }),
  );
  if (mode === "append_only") return policies;
  policies.push(
    pgPolicy(`${table}_update_system`, {
      for: "update",
      to: systemRole,
      using: sql.raw(predicates.write),
      withCheck: sql.raw(predicates.write),
    }),
    pgPolicy(`${table}_delete_system`, {
      for: "delete",
      to: systemRole,
      using: sql.raw(predicates.write),
    }),
  );
  return policies;
}

function userPredicates(options: UserAccess, clientColumn: boolean) {
  const read = staff(options.read ?? "staff");
  return {
    select: options.clientRead && clientColumn ? `(${read} or ${CLIENT_OF_BUSINESS})` : read,
    insert: options.insert === undefined ? undefined : staff(options.insert),
    update: options.update === undefined ? undefined : staff(options.update),
    delete: options.delete === undefined ? undefined : staff(options.delete),
  };
}

/** For a table with `agency_id` and `business_id`, both NOT NULL. The usual case. */
export function businessPolicies(table: string, options: PolicyOptions = {}): PgPolicy[] {
  return [
    ...userPolicies(table, userPredicates(options, true)),
    ...systemPolicies(table, { read: IN_BUSINESS_SCOPE, write: IN_BUSINESS_SCOPE }, options.system),
  ];
}

/**
 * For a table with `agency_id` NOT NULL and a nullable `business_id`, where a null
 * `business_id` marks an agency-level row. Client users never see agency-level rows.
 */
export function sharedPolicies(
  table: string,
  options: PolicyOptions & {
    /** A business scope may also read the agency-level rows. Default false. */
    readonly businessScopeReadsAgencyRows?: boolean;
  } = {},
): PgPolicy[] {
  return [
    ...userPolicies(table, userPredicates(options, true)),
    ...systemPolicies(
      table,
      {
        read: options.businessScopeReadsAgencyRows
          ? IN_SHARED_SCOPE_WITH_AGENCY_ROWS
          : IN_SHARED_SCOPE,
        write: IN_SHARED_SCOPE,
      },
      options.system,
    ),
  ];
}

/**
 * For an agency-level table (`agency_id`, no `business_id`). Every scope inside the agency
 * may read; only an agency-wide scope may write. Client users have no access.
 */
export function agencyPolicies(table: string, options: PolicyOptions = {}): PgPolicy[] {
  return [
    ...userPolicies(table, userPredicates(options, false)),
    ...systemPolicies(
      table,
      { read: IN_AGENCY_SCOPE, write: IN_AGENCY_WIDE_SCOPE },
      options.system,
    ),
  ];
}
