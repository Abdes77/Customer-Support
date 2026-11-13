/**
 * The app server for `pnpm e2e`: a production build of the app (`next build`), a fresh
 * database (migrated, the demo data, a website chat for Summit Roofing that allows the sample
 * site), then `next start` on it. Started by the Playwright config; stopping it drops the
 * database.
 *
 * A production build, not `next dev`: the dev server compiles each route on its first request
 * and keeps a Turbopack cache in `.next/dev/cache` across runs, so the browser tests depended
 * on what ran before them. After `pnpm verify` the dev server could answer every page's
 * hot-reload subscription with "restart", which reloads the page forever (sign-in never
 * finished), or take longer than a test's wait to compile a page (DECISIONS 257). A build
 * compiles every route before the first test and has no hot reload.
 *
 * Needs local PostgreSQL (`pnpm services:up`). No vendor account: jobs run in-process and
 * the offline model answers (AI_MODEL_MODE=offline).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureWidgetConnection } from "@repo/channel-widget/server";
import { businesses, eq } from "@repo/db";
import { seedDemoData } from "@repo/db/seed";
import { createTestDatabase, TEST_ENCRYPTION_KEY } from "@repo/db/testing";
import { applySettingChanges } from "@repo/settings/server";

import { APP_PORT, APP_URL, type E2eState, SITE_URL, STATE_FILE } from "./config";

const ALL_DAY = [{ open: "00:00", close: "23:59" }];
const APP_DIR = path.resolve(import.meta.dirname, "../..");

/** The environment of the build and the server: in-process jobs, no Supabase, no Claude API. */
function appEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_URL,
    NEXT_PUBLIC_APP_URL: APP_URL,
    CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    CREDENTIALS_ENCRYPTION_KEY_ID: "test",
    LOCAL_AUTH_SECRET: "e2e-local-auth-secret-0123456789-abcdefgh",
    WIDGET_SESSION_SECRET: "e2e-widget-session-secret-0123456789-abcdefgh",
    AI_MODEL_MODE: "offline",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "INNGEST_DEV",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    // `next build` and `next start` set it themselves.
    "NODE_ENV",
  ]) {
    delete env[name];
  }
  return env;
}

/** The running child (the build, then the server), stopped with this script. */
let child: ChildProcess | undefined;
let dispose: (() => Promise<void>) | undefined;
let stopping = false;

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    child?.kill("SIGTERM");
    await dispose?.().catch(() => undefined);
  }
  process.exit(code);
}

function run(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  child = spawn("pnpm", ["exec", "next", ...args], { cwd: APP_DIR, env, stdio: "inherit" });
  return child;
}

/**
 * `next build` into `apps/web/.next` (it empties the folder first, apart from the build cache
 * and `.next/dev`, the dev server's own folder). NEXT_PUBLIC_* values are fixed at build time,
 * so the build gets the same environment as the server.
 */
async function build(env: NodeJS.ProcessEnv): Promise<void> {
  const code = await new Promise<number>((resolve) => {
    run(["build"], env).on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`next build failed (exit code ${code}).`);
}

async function main(): Promise<void> {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void stop(0));
  }
  const env = appEnv();
  await build(env);
  if (stopping) return;

  const t = await createTestDatabase();
  dispose = () => t.dispose();
  await seedDemoData(t.db, {});
  const [business] = await t.admin
    .select({ id: businesses.id, agencyId: businesses.agencyId, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.slug, "summit-roofing"));
  if (business === undefined) throw new Error("The demo data has no Summit Roofing.");

  const widgetKey = await t.db.forBusiness(business.id).run(async (ctx) => {
    const connection = await ensureWidgetConnection(ctx, {
      actor: { type: "system", label: "e2e setup" },
    });
    await applySettingChanges(ctx, {
      target: { scope: "business", agencyId: business.agencyId, businessId: business.id },
      changes: [
        { key: "channels.widget.allowed_origins", value: [SITE_URL] },
        { key: "channels.widget.pre_chat_fields", value: ["name", "phone", "email"] },
        { key: "channels.widget.subtitle", value: "Roof questions? Ask {{bot_name}}." },
        { key: "persona.bot_name", value: "Riley" },
        { key: "conversation.reply_wait_seconds.widget", value: 0 },
        // Open around the clock, so the run does not depend on the time of day.
        {
          key: "hours.weekly",
          value: {
            monday: ALL_DAY,
            tuesday: ALL_DAY,
            wednesday: ALL_DAY,
            thursday: ALL_DAY,
            friday: ALL_DAY,
            saturday: ALL_DAY,
            sunday: ALL_DAY,
          },
        },
        { key: "hours.us_federal_holidays", value: false },
      ],
      actor: { type: "system", label: "e2e setup" },
    });
    return connection.publicKey;
  });

  const state: E2eState = {
    databaseUrl: t.url,
    agencyId: business.agencyId,
    businessId: business.id,
    businessName: business.name,
    widgetKey,
  };
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  const next = run(["start", "--port", String(APP_PORT), "--hostname", "127.0.0.1"], {
    ...env,
    DATABASE_URL: t.url,
  });
  next.on("exit", (code) => void stop(code ?? 0));
}

main().catch((error: unknown) => {
  console.error(error);
  void stop(1);
});
