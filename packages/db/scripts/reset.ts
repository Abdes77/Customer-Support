/**
 * pnpm db:reset
 *
 * LOCAL DEVELOPMENT ONLY. Drops everything this system created in the database in
 * DATABASE_URL_DIRECT (or DATABASE_URL) and migrates it from scratch. It refuses to touch a
 * Supabase database or to run in production.
 */
import { sql } from "drizzle-orm";

import { ConfigError } from "@repo/core";
import { deploymentInfo, getEnv, isProduction } from "@repo/core/env";

import { connect } from "../src/internal/client";
import { detectDatabaseFlavor, migrateDatabase } from "../src/migrate";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  if (isProduction() || deploymentInfo().environment !== "local") {
    throw new ConfigError("db:reset only runs on a developer machine.");
  }
  const env = getEnv();
  const url = env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;
  if (url === undefined) throw new ConfigError("Set DATABASE_URL_DIRECT (or DATABASE_URL).");

  const connection = connect(url, { max: 1, applicationName: "hsrb-reset" });
  try {
    const flavor = await detectDatabaseFlavor(connection.db);
    if (flavor === "supabase") {
      throw new ConfigError(
        "This is a Supabase database. db:reset only resets a local PostgreSQL database.",
      );
    }
    await connection.db.execute(
      sql.raw(`
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS app CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      CREATE SCHEMA public;
      -- What a stock database has; the migrations do not depend on it.
      GRANT USAGE ON SCHEMA public TO PUBLIC;
    `),
    );
  } finally {
    await connection.client.end({ timeout: 5 });
  }
  console.log("Dropped schemas public, drizzle, app and auth.");
  await migrateDatabase({ url, log: (message) => console.log(`  ${message}`) });
  console.log("Done. Run `pnpm db:seed` for demo data.");
}

main().catch(fail);
