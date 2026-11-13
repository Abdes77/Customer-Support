import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as tables from "../schema/tables";

/*
 * INTERNAL. The unrestricted connection: it runs as the connection role, which bypasses
 * row-level security. Nothing in this folder is exported from the package. Product code
 * reaches the database through `Database.asUser`, `forBusiness` and `forAgency`; the only
 * code that may use this handle directly lives in this package (`src/directory.ts` and the
 * scripts) and is reviewed as cross-tenant code.
 */

export type Schema = typeof tables;
export type RawDatabase = PostgresJsDatabase<Schema>;

/** A Drizzle transaction. The handle that callbacks of `run()` receive as `ctx.tx`. */
export type Transaction = Parameters<Parameters<RawDatabase["transaction"]>[0]>[0];

export type SqlClient = ReturnType<typeof postgres>;

export interface ConnectOptions {
  /** Size of the connection pool. Keep it small on serverless. */
  readonly max?: number;
  /** Shown in pg_stat_activity. */
  readonly applicationName?: string;
  /** Seconds an idle connection is kept. */
  readonly idleTimeoutSeconds?: number;
}

export interface Connection {
  readonly client: SqlClient;
  readonly db: RawDatabase;
}

const JSON_OID = 114;
const JSONB_OID = 3802;

export function connect(url: string, options: ConnectOptions = {}): Connection {
  const client = postgres(url, {
    max: options.max ?? 5,
    // The Supabase pooler in transaction mode cannot keep prepared statements.
    prepare: false,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: options.applicationName ?? "hsrb" },
  });
  const db = drizzle(client, { schema: tables });
  // json and jsonb are parsed exactly once, by Drizzle's column. postgres.js parses them by
  // default and Drizzle's `json`/`jsonb` columns then call JSON.parse on any string they get,
  // so a stored JSON string that looks like JSON ("55408", "true", "[1,2]") came back as a
  // number, boolean or array. Consequence: raw `execute(sql...)` returns json/jsonb as text.
  // Drizzle sets its own parsers in `drizzle()`, so this must come after it. ARCHITECTURE §8.
  const asText = (value: string): string => value;
  client.options.parsers[JSON_OID] = asText;
  client.options.parsers[JSONB_OID] = asText;
  return { client, db };
}
