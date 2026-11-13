/**
 * pnpm db:migrate
 *
 * Applies every pending migration to the database in DATABASE_URL_DIRECT (or DATABASE_URL),
 * after the Supabase compatibility bootstrap on plain PostgreSQL, and then synchronises
 * table privileges with the policies. Safe to run repeatedly.
 */
import { ConfigError } from "@repo/core";
import { getEnv } from "@repo/core/env";

import { migrateDatabase } from "../src/migrate";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  const env = getEnv();
  const url = env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;
  if (url === undefined) {
    throw new ConfigError(
      "Set DATABASE_URL_DIRECT (or DATABASE_URL). Copy .env.example to .env.local for local development.",
    );
  }
  const target = new URL(url);
  console.log(`Migrating ${target.hostname}${target.pathname} ...`);
  const result = await migrateDatabase({ url, log: (message) => console.log(`  ${message}`) });
  console.log(`Done. Database kind: ${result.flavor}.`);
}

main().catch(fail);
