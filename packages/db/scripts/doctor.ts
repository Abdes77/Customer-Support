/**
 * pnpm db:doctor
 *
 * Checks the database in DATABASE_URL: connection, roles, migrations, row-level security,
 * privileges and the credential encryption key. Reads only. Exits 1 when a check fails.
 */
import { ConfigError } from "@repo/core";
import { getEnv } from "@repo/core/env";

import { runDoctor } from "../src/doctor";
import { fail, loadRootEnv } from "./env";

async function main(): Promise<void> {
  loadRootEnv();
  const env = getEnv();
  if (env.DATABASE_URL === undefined) throw new ConfigError("Set DATABASE_URL.");
  const checks = await runDoctor({ url: env.DATABASE_URL });
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch(fail);
