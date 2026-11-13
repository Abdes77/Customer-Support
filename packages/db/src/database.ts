import { sql } from "drizzle-orm";

import {
  type AgencyId,
  type BusinessId,
  ConfigError,
  NotFoundError,
  scrubQueryError,
  TenantAccessError,
} from "@repo/core";
import { getEnv } from "@repo/core/env";

import type {
  AgencyContext,
  AgencyScope,
  BusinessContext,
  BusinessScope,
  RunOptions,
  UserContext,
  UserIdentity,
  UserScope,
} from "./context";
import { type Keyring, keyringFromEnv } from "./crypto/secrets";
import { createDirectory, type Directory } from "./directory";
import { translateDbError } from "./errors";
import { connect, type Connection, type ConnectOptions, type Transaction } from "./internal/client";
import { createLocalAuthStore, type LocalAuthStore } from "./local-auth";
import { createPlatform, type Platform } from "./platform";
import { createSecretStores, type SecretStores } from "./repositories/secrets";

/**
 * The only way into the database (ARCHITECTURE §3).
 *
 * | Access path    | Call                         | PostgreSQL role  | Confined by                    |
 * | -------------- | ---------------------------- | ---------------- | ------------------------------ |
 * | User context   | `asUser(user).run(...)`      | `authenticated`  | the user's memberships         |
 * | System context | `forBusiness(id).run(...)`   | `app_system`     | that business                  |
 * |                | `forAgency(id).run(...)`     | `app_system`     | that agency                    |
 * | Cross-tenant   | `directory.*`, `platform.*`  | connection role  | the few functions written here |
 *
 * `run()` opens one transaction, switches to the restricted role and hands the callback a
 * context whose `tx` is a full Drizzle transaction: any query is allowed, and row-level
 * security guarantees it cannot leave the tenant. There is no unrestricted handle to export.
 *
 * Do not nest `run()` calls (each takes its own connection); pass the context down instead.
 */
export interface Database {
  /** Acts for a signed-in user. The caller must have verified the session first. */
  asUser(user: UserIdentity): UserScope;
  /**
   * Acts for the system inside one business. Pass `expected.agencyId` when it is known (for
   * example from a job payload): a business of another agency is then refused.
   */
  forBusiness(businessId: BusinessId, expected?: { readonly agencyId: AgencyId }): BusinessScope;
  /** Acts for the system across one agency: onboarding, playbooks, agency-wide settings. */
  forAgency(agencyId: AgencyId): AgencyScope;
  /** Audited lookups that map an unauthenticated request or a cron run to tenants. */
  readonly directory: Directory;
  /** Platform-operator actions that exist above any tenant (create an agency). */
  readonly platform: Platform;
  /** Encrypted credentials of channel and integration connections. */
  readonly secrets: SecretStores;
  /** Sign-in store for local development and CI, where there is no Supabase Auth. */
  readonly localAuth: LocalAuthStore;
  /** Resolves when the database answers a trivial query. For health checks. */
  ping(): Promise<void>;
  /** Closes the pool. Call it in scripts and tests; a server keeps its pool. */
  close(): Promise<void>;
}

export interface DatabaseOptions extends ConnectOptions {
  /** PostgreSQL connection string. */
  readonly url: string;
  /** Key ring for stored credentials. Default: read from the environment on first use. */
  readonly keyring?: Keyring;
}

type DrizzleTransactionConfig = NonNullable<Parameters<Connection["db"]["transaction"]>[1]>;

function transactionConfig(options: RunOptions | undefined): DrizzleTransactionConfig | undefined {
  if (options === undefined) return undefined;
  const config: DrizzleTransactionConfig = {};
  if (options.isolationLevel !== undefined) config.isolationLevel = options.isolationLevel;
  if (options.readOnly === true) config.accessMode = "read only";
  return config;
}

async function inTransaction<T>(
  connection: Connection,
  options: RunOptions | undefined,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await connection.db.transaction(fn, transactionConfig(options));
  } catch (error) {
    // A failed statement's error names the statement's values (customer text, contact
    // details): they are removed before the error leaves this package, so they reach no log,
    // error report, job history or stored error message.
    throw translateDbError(scrubQueryError(error));
  }
}

/**
 * The cross-tenant helpers run on the connection itself, not inside `run()`: their errors
 * lose the statement's values the same way.
 */
function withScrubbedErrors<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        try {
          const result: unknown = (value as (...inner: unknown[]) => unknown).apply(object, args);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                throw scrubQueryError(error);
              })
            : result;
        } catch (error) {
          throw scrubQueryError(error);
        }
      };
    },
  });
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  return (result as readonly Record<string, unknown>[])[0];
}

class UserScopeImpl implements UserScope {
  constructor(
    private readonly connection: Connection,
    readonly user: UserIdentity,
  ) {}

  run<T>(fn: (ctx: UserContext) => Promise<T>, options?: RunOptions): Promise<T> {
    const { user } = this;
    // The same claims Supabase puts in a session token, so `auth.uid()` and `auth.jwt()`
    // answer here exactly as they do behind Supabase's own APIs.
    const claims = JSON.stringify({
      sub: user.id,
      role: "authenticated",
      email: user.email ?? null,
    });
    return inTransaction(this.connection, options, async (tx) => {
      await tx.execute(sql`
        select set_config('request.jwt.claims', ${claims}, true),
               set_config('request.jwt.claim.sub', ${user.id}, true),
               set_config('app.agency_id', '', true),
               set_config('app.business_id', '', true),
               set_config('role', 'authenticated', true)`);
      return fn({ kind: "user", tx, user });
    });
  }
}

class BusinessScopeImpl implements BusinessScope {
  constructor(
    private readonly connection: Connection,
    readonly businessId: BusinessId,
    private readonly expectedAgencyId: AgencyId | undefined,
  ) {}

  run<T>(fn: (ctx: BusinessContext) => Promise<T>, options?: RunOptions): Promise<T> {
    const { businessId, expectedAgencyId } = this;
    return inTransaction(this.connection, options, async (tx) => {
      // One statement, still as the connection role: find the business's agency and confine
      // the rest of the transaction to it. No row means no such business, and no switch.
      const row = firstRow(
        await tx.execute(sql`
          select b.agency_id as agency_id,
                 set_config('app.agency_id', b.agency_id::text, true),
                 set_config('app.business_id', b.id::text, true),
                 set_config('request.jwt.claims', '', true),
                 set_config('request.jwt.claim.sub', '', true),
                 set_config('role', 'app_system', true)
            from public.businesses b
           where b.id = ${businessId}::uuid`),
      );
      if (row === undefined) {
        throw new NotFoundError("Business not found.", { details: { businessId } });
      }
      const agencyId = row["agency_id"] as AgencyId;
      if (expectedAgencyId !== undefined && expectedAgencyId !== agencyId) {
        throw new TenantAccessError("The business does not belong to the expected agency.", {
          details: { businessId, expectedAgencyId },
        });
      }
      return fn({ kind: "business", tx, tenant: { agencyId, businessId } });
    });
  }
}

class AgencyScopeImpl implements AgencyScope {
  constructor(
    private readonly connection: Connection,
    readonly agencyId: AgencyId,
  ) {}

  run<T>(fn: (ctx: AgencyContext) => Promise<T>, options?: RunOptions): Promise<T> {
    const { agencyId } = this;
    return inTransaction(this.connection, options, async (tx) => {
      const row = firstRow(
        await tx.execute(sql`
          select a.id as agency_id,
                 set_config('app.agency_id', a.id::text, true),
                 set_config('app.business_id', '', true),
                 set_config('request.jwt.claims', '', true),
                 set_config('request.jwt.claim.sub', '', true),
                 set_config('role', 'app_system', true)
            from public.agencies a
           where a.id = ${agencyId}::uuid`),
      );
      if (row === undefined) {
        throw new NotFoundError("Agency not found.", { details: { agencyId } });
      }
      return fn({ kind: "agency", tx, tenant: { agencyId } });
    });
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TenantAccessError(`${what} is not a valid id.`);
  }
}

export function createDatabase(options: DatabaseOptions): Database {
  const connection = connect(options.url, options);
  let keyring = options.keyring;
  const getKeyring = (): Keyring => (keyring ??= keyringFromEnv());

  return {
    asUser(user) {
      assertUuid(user.id, "The user id");
      return new UserScopeImpl(connection, user);
    },
    forBusiness(businessId, expected) {
      assertUuid(businessId, "The business id");
      return new BusinessScopeImpl(connection, businessId, expected?.agencyId);
    },
    forAgency(agencyId) {
      assertUuid(agencyId, "The agency id");
      return new AgencyScopeImpl(connection, agencyId);
    },
    directory: withScrubbedErrors(createDirectory(connection)),
    platform: withScrubbedErrors(createPlatform(connection)),
    secrets: createSecretStores(getKeyring),
    localAuth: withScrubbedErrors(createLocalAuthStore(connection)),
    async ping() {
      await connection.client`select 1`;
    },
    async close() {
      await connection.client.end({ timeout: 5 });
    },
  };
}

// Kept on globalThis so a hot reload of the Next.js dev server reuses the pool instead of
// opening a new one on every change.
const SHARED_KEY = Symbol.for("@repo/db/shared-database");
const sharedHolder = globalThis as { [SHARED_KEY]?: Database };

/**
 * The process-wide database, connected to DATABASE_URL on first use. Server code only.
 * Throws a ConfigError when DATABASE_URL is not set.
 */
export function getDatabase(): Database {
  let shared = sharedHolder[SHARED_KEY];
  if (shared === undefined) {
    const env = getEnv();
    if (env.DATABASE_URL === undefined) {
      throw new ConfigError(
        "Missing environment variable: DATABASE_URL. See docs/HUMAN_TODO.md for where to get each value.",
        { details: { variables: ["DATABASE_URL"] } },
      );
    }
    shared = createDatabase({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
    sharedHolder[SHARED_KEY] = shared;
  }
  return shared;
}

/** Closes and forgets the process-wide database. For tests and scripts. */
export async function closeDatabase(): Promise<void> {
  const current = sharedHolder[SHARED_KEY];
  sharedHolder[SHARED_KEY] = undefined;
  await current?.close();
}
