import path from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { connect } from "./internal/client";
import { SUPABASE_COMPAT_MARKER, SUPABASE_COMPAT_SQL } from "./supabase-compat";

/** Folder with the SQL migrations and drizzle-kit's journal. */
export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../drizzle");

export type DatabaseFlavor = "supabase" | "supabase_compat" | "plain";

export interface MigrateOptions {
  /** A direct connection (not a transaction pooler). */
  readonly url: string;
  /**
   * "auto" (default): apply the Supabase compatibility bootstrap unless the database is a
   * real Supabase one. "never": fail on a plain database instead of changing it.
   */
  readonly supabaseCompat?: "auto" | "never";
  readonly log?: (message: string) => void;
}

export interface MigrateResult {
  /** What the database was found to be before migrating. */
  readonly flavor: DatabaseFlavor;
  readonly compatApplied: boolean;
  /** Tags of every migration recorded as applied after the run. */
  readonly appliedCount: number;
}

type Rows = readonly Record<string, unknown>[];

/** Tells a Supabase database, a bootstrapped plain one and an untouched plain one apart. */
export async function detectDatabaseFlavor(
  db: ReturnType<typeof connect>["db"],
): Promise<DatabaseFlavor> {
  const rows = (await db.execute(sql`
    select to_regprocedure('auth.uid()') is not null as has_auth_uid,
           (select d.description
              from pg_catalog.pg_namespace n
              join pg_catalog.pg_description d
                on d.objoid = n.oid and d.classoid = 'pg_catalog.pg_namespace'::regclass
             where n.nspname = 'auth') as auth_comment`)) as unknown as Rows;
  const row = rows[0];
  if (row?.["auth_comment"] === SUPABASE_COMPAT_MARKER) return "supabase_compat";
  return row?.["has_auth_uid"] === true ? "supabase" : "plain";
}

/**
 * Brings a database up to date: the compatibility bootstrap where needed, every pending
 * migration, then `app.sync_table_privileges()` so row-level security is enabled and forced
 * on every table and the grants match the policies.
 *
 * This is the only supported way to apply migrations (`pnpm db:migrate`); do not use
 * `drizzle-kit migrate` or `push`, which skip the first and the last step.
 */
export async function migrateDatabase(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const connection = connect(options.url, { max: 1, applicationName: "hsrb-migrate" });
  try {
    const flavor = await detectDatabaseFlavor(connection.db);
    let compatApplied = false;
    if (flavor !== "supabase") {
      if (options.supabaseCompat === "never") {
        if (flavor === "plain") {
          throw new Error(
            "This database has no Supabase roles or auth schema, and the compatibility bootstrap is switched off.",
          );
        }
      } else {
        await connection.db.execute(sql.raw(SUPABASE_COMPAT_SQL));
        compatApplied = true;
        log(
          flavor === "plain"
            ? "Applied the Supabase compatibility bootstrap (plain PostgreSQL)."
            : "Refreshed the Supabase compatibility bootstrap.",
        );
      }
    } else {
      log("Supabase database detected: compatibility bootstrap skipped.");
    }

    await migrate(connection.db, { migrationsFolder: MIGRATIONS_FOLDER });
    await connection.db.execute(sql`select app.sync_table_privileges()`);

    const applied = (await connection.db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    )) as unknown as Rows;
    const appliedCount = Number(applied[0]?.["n"] ?? 0);
    log(`Migrations applied: ${appliedCount}. Privileges synchronised with policies.`);
    return { flavor, compatApplied, appliedCount };
  } finally {
    await connection.client.end({ timeout: 5 });
  }
}
