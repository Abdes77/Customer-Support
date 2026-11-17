/**
 * Runs before `next build` on a hosted project (`pnpm build:deploy`, the build command in
 * vercel.json). It does nothing unless the project asks for it:
 *
 * - DEPLOY_MIGRATE=1 applies pending database migrations (`pnpm db:migrate`);
 * - DEPLOY_DEMO_AGENCY="Agency name" then also stores the sample businesses of the public
 *   demo site in that agency (`pnpm demo:setup`), creating the agency when it is new.
 *
 * So a deployment that sets them needs no command typed anywhere: configure the variables,
 * deploy. Both steps are safe to repeat, and a failure fails the build before anything is
 * published. Without the variables, migrations stay a manual step (docs/RUNBOOK.md).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { getEnv } from "@repo/core/env";
import { businessSlug } from "@repo/db";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function run(label: string, args: readonly string[]): void {
  console.warn(`predeploy: ${label}`);
  const result = spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit code ${result.status ?? "none"}).`);
  }
}

function main(): void {
  const env = getEnv();
  if (env.DEPLOY_MIGRATE !== true) {
    console.warn("predeploy: nothing to do (DEPLOY_MIGRATE is not 1).");
    return;
  }
  run("applying database migrations", ["--filter", "@repo/db", "run", "migrate"]);
  const agency = env.DEPLOY_DEMO_AGENCY;
  if (agency === undefined) return;
  run("storing the demo's sample businesses", [
    "--filter",
    "@repo/web",
    "run",
    "demo:setup",
    "--slug",
    businessSlug(agency),
    "--agency",
    agency,
  ]);
}

try {
  main();
} catch (error) {
  console.error(`\npredeploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
