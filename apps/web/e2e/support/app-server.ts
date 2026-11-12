/**
 * The app server for `pnpm e2e`: a fresh database (migrated, the demo data, a website chat
 * for Summit Roofing that allows the sample site), then `next dev` on it. Started by the
 * Playwright config; stopping it drops the database.
 *
 * Needs local PostgreSQL (`pnpm services:up`). No vendor account: jobs run in-process and
 * the offline model answers (AI_MODEL_MODE=offline).
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureWidgetConnection } from "@repo/channel-widget/server";
import { businesses, eq } from "@repo/db";
import { seedDemoData } from "@repo/db/seed";
import { createTestDatabase, TEST_ENCRYPTION_KEY } from "@repo/db/testing";
import { applySettingChanges } from "@repo/settings/server";

import { APP_PORT, APP_URL, type E2eState, SITE_URL, STATE_FILE } from "./config";

const ALL_DAY = [{ open: "00:00", close: "23:59" }];

async function main(): Promise<void> {
  const t = await createTestDatabase();
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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: t.url,
    APP_URL,
    NEXT_PUBLIC_APP_URL: APP_URL,
    CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    CREDENTIALS_ENCRYPTION_KEY_ID: "test",
    LOCAL_AUTH_SECRET: "e2e-local-auth-secret-0123456789-abcdefgh",
    WIDGET_SESSION_SECRET: "e2e-widget-session-secret-0123456789-abcdefgh",
    AI_MODEL_MODE: "offline",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // In-process jobs, no Supabase, no Claude API: the run needs no account.
  for (const name of [
    "ANTHROPIC_API_KEY",
    "INNGEST_DEV",
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    delete env[name];
  }

  const next = spawn(
    "pnpm",
    ["exec", "next", "dev", "--port", String(APP_PORT), "--hostname", "127.0.0.1"],
    { cwd: path.resolve(import.meta.dirname, "../.."), env, stdio: "inherit" },
  );
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    next.kill("SIGTERM");
    await t.dispose().catch(() => undefined);
    process.exit(code);
  };
  next.on("exit", (code) => void stop(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void stop(0));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
