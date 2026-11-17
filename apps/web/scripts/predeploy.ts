/**
 * Runs before `next build` on a hosted project (`pnpm build:deploy`, the build command in
 * vercel.json). It does nothing unless the project asks for it with DEPLOY_MIGRATE=1; then,
 * once a database is connected, every build:
 *
 * - applies pending database migrations (`pnpm db:migrate`);
 * - makes sure the private Storage bucket for chat photos exists (with Supabase configured);
 * - with DEPLOY_DEMO_AGENCY="Agency name": stores the sample businesses of the public demo
 *   site in that agency (`pnpm demo:setup`), creating the agency when it is new;
 * - with DEPLOY_ADMIN_EMAIL as well: makes that person an admin of the agency
 *   (`pnpm db:create-admin`), creating their login with DEPLOY_ADMIN_PASSWORD when they have
 *   none.
 *
 * So a deployment that sets them needs no command typed anywhere: connect the database, set
 * the variables, deploy. Every step is safe to repeat, and a failure fails the build before
 * anything is published. Without DEPLOY_MIGRATE, migrations stay a manual step
 * (docs/RUNBOOK.md).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { type Env, getEnv } from "@repo/core/env";
import { businessSlug } from "@repo/db";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function run(label: string, args: readonly string[]): void {
  console.warn(`predeploy: ${label}`);
  const result = spawnSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit code ${result.status ?? "none"}).`);
  }
}

/**
 * The private bucket chat photos are stored in. Created through Supabase's Storage API with
 * the server-side key; a bucket that exists already is left as it is. A failure is reported
 * and does not stop the deployment: only photo uploads depend on it.
 */
async function ensureStorageBucket(env: Env): Promise<void> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url === undefined || key === undefined) return;
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  console.warn(`predeploy: making sure the storage bucket "${bucket}" exists`);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/storage/v1/bucket`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    if (response.ok) return;
    const text = (await response.text()).slice(0, 300);
    // "The resource already exists" (HTTP 400 or 409, depending on the Storage version).
    if (/already exists|duplicate/i.test(text)) return;
    console.error(
      `predeploy: the bucket could not be created (HTTP ${response.status}). Create a private bucket named "${bucket}" in Supabase, Storage; until then photos cannot be sent in the chat.`,
    );
  } catch {
    console.error(
      `predeploy: Supabase Storage could not be reached. Create a private bucket named "${bucket}" in Supabase, Storage; until then photos cannot be sent in the chat.`,
    );
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  if (env.DEPLOY_MIGRATE !== true) {
    console.warn("predeploy: nothing to do (DEPLOY_MIGRATE is not 1).");
    return;
  }
  if (env.DATABASE_URL === undefined && env.DATABASE_URL_DIRECT === undefined) {
    // Nothing can run without a database anyway: let the build finish, so the project exists
    // and the database can be connected to it, and say what is missing.
    console.warn(
      "predeploy: no database is connected yet (DATABASE_URL, or POSTGRES_URL from Supabase's integration). Nothing was migrated. Connect the database and deploy again.",
    );
    return;
  }
  run("applying database migrations", ["--filter", "@repo/db", "run", "migrate"]);
  await ensureStorageBucket(env);

  const agency = env.DEPLOY_DEMO_AGENCY;
  if (agency === undefined) {
    if (env.DEPLOY_ADMIN_EMAIL !== undefined) {
      throw new Error("DEPLOY_ADMIN_EMAIL needs DEPLOY_DEMO_AGENCY, the name of the agency.");
    }
    return;
  }
  const slug = businessSlug(agency);
  run("storing the demo's sample businesses", [
    "--filter",
    "@repo/web",
    "run",
    "demo:setup",
    "--slug",
    slug,
    "--agency",
    agency,
  ]);

  const email = env.DEPLOY_ADMIN_EMAIL;
  if (email === undefined) return;
  if (env.DEPLOY_ADMIN_PASSWORD !== undefined && env.DEPLOY_ADMIN_PASSWORD.length < 8) {
    throw new Error("DEPLOY_ADMIN_PASSWORD needs at least 8 characters.");
  }
  // The password reaches the script through the environment, never the command line.
  run("giving the agency its first admin", [
    "--filter",
    "@repo/db",
    "run",
    "create-admin",
    "--slug",
    slug,
    "--email",
    email,
  ]);
}

main().catch((error: unknown) => {
  console.error(`\npredeploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
