import type { AgencyId, BusinessId, UserId } from "@repo/core";

import type { Transaction } from "./internal/client";

/*
 * The three kinds of database context. A context is what the callback of `run()` receives:
 * a transaction that PostgreSQL has already confined, plus who or what it is confined to.
 * Repository functions take a context as their first argument, so they compose inside one
 * transaction and their signature says which access path they are for.
 */

export interface UserIdentity {
  readonly id: UserId;
  readonly email?: string | null;
}

export interface AgencyTenant {
  readonly agencyId: AgencyId;
}

/** Spread it into inserts: `tx.insert(leads).values({ ...ctx.tenant, ... })`. */
export interface BusinessTenant {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
}

/** Runs as `authenticated` with the user's claims: row-level security decides. */
export interface UserContext {
  readonly kind: "user";
  readonly tx: Transaction;
  readonly user: UserIdentity;
}

/** Runs as `app_system`, confined to one business. */
export interface BusinessContext {
  readonly kind: "business";
  readonly tx: Transaction;
  readonly tenant: BusinessTenant;
}

/** Runs as `app_system`, confined to one agency (all of its businesses). */
export interface AgencyContext {
  readonly kind: "agency";
  readonly tx: Transaction;
  readonly tenant: AgencyTenant;
}

export type SystemContext = BusinessContext | AgencyContext;
export type DbContext = UserContext | SystemContext;

export interface RunOptions {
  /** Default: read committed. */
  readonly isolationLevel?: "read committed" | "repeatable read" | "serializable";
  /** A read-only transaction: any write fails. */
  readonly readOnly?: boolean;
}

export interface UserScope {
  readonly user: UserIdentity;
  /** One transaction as the signed-in user. Commits when `fn` resolves, rolls back if it throws. */
  run<T>(fn: (ctx: UserContext) => Promise<T>, options?: RunOptions): Promise<T>;
}

export interface BusinessScope {
  readonly businessId: BusinessId;
  /**
   * One transaction confined to the business. Throws `NotFoundError` when the business does
   * not exist and `TenantAccessError` when it is not in the expected agency, or when a
   * statement reaches for another tenant.
   */
  run<T>(fn: (ctx: BusinessContext) => Promise<T>, options?: RunOptions): Promise<T>;
}

export interface AgencyScope {
  readonly agencyId: AgencyId;
  /** One transaction confined to the agency. Throws `NotFoundError` when it does not exist. */
  run<T>(fn: (ctx: AgencyContext) => Promise<T>, options?: RunOptions): Promise<T>;
}
