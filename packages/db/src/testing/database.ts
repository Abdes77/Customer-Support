import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { getEnv, nodeEnv } from "@repo/core/env";

import { createKeyring, type Keyring } from "../crypto/secrets";
import { createDatabase, type Database } from "../database";
import { connect, type RawDatabase } from "../internal/client";
import { migrateDatabase, MIGRATIONS_FOLDER } from "../migrate";
import { SUPABASE_COMPAT_SQL } from "../supabase-compat";

/*
 * Test databases.
 *
 * Every test file gets its own database, cloned from a template that already has every
 * migration applied. The template is built once per set of migrations (its name carries a
 * hash of them), so a test file pays about a tenth of a second instead of a full migration,
 * and files, packages and Turborepo tasks can run in parallel without seeing each other.
 *
 * The server is the one in TEST_DATABASE_URL (default: the local PostgreSQL that
 * `pnpm services:up` starts). When it is not reachable the local server is started; when
 * that fails too, tests fail with the reason. They never skip.
 */

export const DEFAULT_TEST_DATABASE_URL = "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_test";

/** A fixed key for tests only. Never use it for real credentials. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export function createTestKeyring(): Keyring {
  return createKeyring({ id: "test", key: TEST_ENCRYPTION_KEY });
}

export interface TestDatabase {
  /** Connection string of this test's own database. */
  readonly url: string;
  /** The product API, exactly as the application uses it. */
  readonly db: Database;
  /**
   * An unrestricted Drizzle handle for arranging and inspecting data. It bypasses row-level
   * security: use it to build fixtures and to check results, never as the thing under test.
   */
  readonly admin: RawDatabase;
  /** Closes the connections and drops the database. */
  dispose(): Promise<void>;
}

const LOCK_KEY = 4_815_162_342; // any constant: serialises template builds on one server
const STALE_AFTER_SECONDS = 60 * 60;

function testDatabaseUrl(): string {
  if (nodeEnv() === "production") {
    throw new Error("Test databases cannot be created when NODE_ENV is production.");
  }
  return getEnv().TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Changes whenever a migration, the bootstrap or the journal changes. */
function migrationsHash(): string {
  const hash = createHash("sha256").update(SUPABASE_COMPAT_SQL);
  const metaFolder = path.join(MIGRATIONS_FOLDER, "meta");
  const files = [
    ...readdirSync(MIGRATIONS_FOLDER)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => path.join(MIGRATIONS_FOLDER, file)),
    path.join(metaFolder, "_journal.json"),
  ].sort();
  for (const file of files) {
    hash.update(path.basename(file)).update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 12);
}

function isConnectionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "CONNECT_TIMEOUT" ||
    code === "57P03" // the server is starting up
  );
}

function startLocalPostgres(): void {
  const script = path.resolve(import.meta.dirname, "../../../../scripts/dev-services.sh");
  execFileSync("bash", [script, "up"], { stdio: "pipe", timeout: 60_000 });
}

/** A short-lived connection to the maintenance database, for CREATE and DROP DATABASE. */
async function withMaintenance<T>(
  url: string,
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    connect_timeout: 5,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureReachable(url: string): Promise<void> {
  const probe = () => withMaintenance(url, (sql) => sql`select 1`);
  try {
    await probe();
    return;
  } catch (error) {
    if (!isConnectionFailure(error)) {
      throw new Error(
        `The test database refused the connection (TEST_DATABASE_URL, database "${databaseName(url)}"): ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  // Nothing is listening. Start the local server if that is what the URL points at.
  const host = new URL(url).hostname;
  if (host === "127.0.0.1" || host === "localhost") {
    try {
      startLocalPostgres();
      await probe();
      return;
    } catch (error) {
      throw new Error(
        "Database tests need PostgreSQL and could not start it. Run `pnpm services:up` and " +
          `read its output, or point TEST_DATABASE_URL at a server you run. (${(error as Error).message})`,
        { cause: error },
      );
    }
  }
  throw new Error(
    `Database tests need PostgreSQL, and nothing answers at ${host}. Check TEST_DATABASE_URL.`,
  );
}

const sqlState = (error: unknown) => (error as { code?: unknown } | null)?.code;

/**
 * Drops a test database. WITH (FORCE) ends connections that a test left open, but it refuses
 * ("permission denied to terminate process", 42501) when an autovacuum worker happens to be
 * in the database: the worker is not this role's process. A plain DROP asks autovacuum
 * workers to stop and waits for them, so that is the fallback; a few rounds cover a session
 * that appears in between.
 */
async function dropDatabase(sql: ReturnType<typeof postgres>, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sql.unsafe(`drop database if exists "${name}" with (force)`);
      return;
    } catch (error) {
      if (sqlState(error) !== "42501" || attempt >= 4) throw error;
    }
    try {
      await sql.unsafe(`drop database if exists "${name}"`);
      return;
    } catch (error) {
      // 55006: still in use by another session; try again with FORCE.
      if (sqlState(error) !== "55006") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
}

async function ensureTemplate(baseUrl: string, templateName: string): Promise<void> {
  const base = databaseName(baseUrl);
  await withMaintenance(baseUrl, async (sql) => {
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      const existing = await sql`select 1 from pg_database where datname = ${templateName}`;
      if (existing.length > 0) return;

      // Leftovers: templates of older migration sets, and test databases that a crashed
      // run did not drop (their name carries the time they were created).
      const others = await sql<{ datname: string }[]>`
        select datname from pg_database
         where datname like ${`${base}\\_tpl\\_%`} or datname like ${`${base}\\_t\\_%`}`;
      const now = Math.floor(Date.now() / 1000);
      for (const { datname } of others) {
        const created = /_t_(\d+)_/.exec(datname)?.[1];
        const stale = created === undefined || now - Number(created) > STALE_AFTER_SECONDS;
        if (stale) await dropDatabase(sql, datname);
      }

      const building = `${templateName}_building`;
      await dropDatabase(sql, building);
      await sql.unsafe(`create database "${building}"`);
      await migrateDatabase({ url: withDatabaseName(baseUrl, building) });
      await sql.unsafe(`alter database "${building}" rename to "${templateName}"`);
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  });
}

async function cloneTemplate(baseUrl: string, templateName: string): Promise<string> {
  const name = `${databaseName(baseUrl)}_t_${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString("hex")}`;
  await withMaintenance(baseUrl, async (sql) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await sql.unsafe(`create database "${name}" template "${templateName}"`);
        return;
      } catch (error) {
        // "source database is being accessed by other users": another clone is in flight.
        if ((error as { code?: unknown }).code !== "55006") throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50 + attempt * 25));
      }
    }
    throw lastError;
  });
  return withDatabaseName(baseUrl, name);
}

/**
 * Creates a database for one test file: migrated, empty and private. Call `dispose()` in
 * `afterAll`. Typical use:
 *
 *   let t: TestDatabase;
 *   beforeAll(async () => { t = await createTestDatabase(); });
 *   afterAll(async () => { await t.dispose(); });
 */
export async function createTestDatabase(
  options: { readonly keyring?: Keyring } = {},
): Promise<TestDatabase> {
  const baseUrl = testDatabaseUrl();
  await ensureReachable(baseUrl);
  const templateName = `${databaseName(baseUrl)}_tpl_${migrationsHash()}`;
  await ensureTemplate(baseUrl, templateName);
  const url = await cloneTemplate(baseUrl, templateName);

  const db = createDatabase({
    url,
    max: 4,
    keyring: options.keyring ?? createTestKeyring(),
    applicationName: "hsrb-test",
  });
  const adminConnection = connect(url, { max: 2, applicationName: "hsrb-test-admin" });

  return {
    url,
    db,
    admin: adminConnection.db,
    async dispose() {
      await db.close();
      await adminConnection.client.end({ timeout: 5 });
      await withMaintenance(baseUrl, (sql) => dropDatabase(sql, databaseName(url)));
    },
  };
}

/**
 * Creates an empty database with no migrations applied, for tests of the migrations
 * themselves. Returns its URL and a function that drops it.
 */
export async function createEmptyTestDatabase(): Promise<{
  readonly url: string;
  dispose(): Promise<void>;
}> {
  const baseUrl = testDatabaseUrl();
  await ensureReachable(baseUrl);
  const name = `${databaseName(baseUrl)}_t_${Math.floor(Date.now() / 1000)}_${randomBytes(5).toString("hex")}`;
  await withMaintenance(baseUrl, (sql) => sql.unsafe(`create database "${name}"`));
  return {
    url: withDatabaseName(baseUrl, name),
    dispose: () => withMaintenance(baseUrl, (sql) => dropDatabase(sql, name)),
  };
}
