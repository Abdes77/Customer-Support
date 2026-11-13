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
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { localCertificate } from "@repo/channel-email/testing";
import { ensureWidgetConnection } from "@repo/channel-widget/server";
import {
  type BusinessTenant,
  businesses,
  channelConnections,
  eq,
  integrationConnections,
} from "@repo/db";
import { seedDemoData } from "@repo/db/seed";
import { createTestDatabase, type TestDatabase, TEST_ENCRYPTION_KEY } from "@repo/db/testing";
import { applySettingChanges } from "@repo/settings/server";

import {
  APP_PORT,
  APP_URL,
  type E2eState,
  FAKES_PORT,
  FAKES_URL,
  META_APP_SECRET,
  SITE_URL,
  STATE_FILE,
} from "./config";
import { type RunningFakes, startFakes } from "./fakes";

const ALL_DAY = [{ open: "00:00", close: "23:59" }];
const APP_DIR = path.resolve(import.meta.dirname, "../..");

/**
 * The environment of the build and the server: in-process jobs, no Supabase, no Claude API,
 * explicitly in development mode (`DEVELOPMENT_MODE=1`).
 */
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
    // A production build is production unless asked otherwise (C17): this one is a developer
    // machine on 127.0.0.1, with in-process jobs, the offline model and local sign-in.
    DEVELOPMENT_MODE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    // Meta's webhook secrets, so the WhatsApp and Messenger connection pages list what is
    // stored (C16). No Embedded Signup or Facebook Login configuration: those flows need a
    // real Meta app, and the pages must say so.
    META_APP_ID: "100000000000000",
    META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: "e2e-meta-verify-token",
  };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "META_WHATSAPP_SIGNUP_CONFIG_ID",
    "META_LOGIN_CONFIG_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "CALENDLY_CLIENT_ID",
    "CALENDLY_CLIENT_SECRET",
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

/**
 * Connections as the connect flows of C9 to C14 leave them, for the connection pages' tests
 * (C16): a WhatsApp number connected, a Facebook Page whose access Meta removed, an IMAP inbox
 * whose login failed, a Google calendar connected, a Housecall Pro key that was refused, and a
 * paused webhook target. Rows only; no credentials, and no job acts on them (the inbox is not
 * active, the webhook is paused).
 */
async function storeConnectionStates(t: TestDatabase, tenant: BusinessTenant): Promise<void> {
  const connectedAt = new Date();
  await t.admin.insert(channelConnections).values([
    {
      ...tenant,
      channel: "whatsapp",
      externalAccountId: "100000000000001",
      displayName: "+1 303-555-0100",
      status: "active",
      config: {
        businessAccountId: "100000000000002",
        phoneNumberId: "100000000000001",
        displayPhoneNumber: "+1 303-555-0100",
        verifiedName: "Summit Roofing Co.",
      },
      connectedAt,
    },
    {
      ...tenant,
      channel: "messenger",
      externalAccountId: "200000000000001",
      displayName: "Summit Roofing Co. Page",
      status: "error",
      lastError: "Meta removed the app's access to this Page: connect it again.",
      lastErrorAt: connectedAt,
      config: { pageId: "200000000000001", pageName: "Summit Roofing Co. Page" },
      connectedAt,
    },
    {
      ...tenant,
      channel: "email",
      externalAccountId: "office@summitroofing.example.com",
      displayName: "Summit Roofing Co.",
      status: "error",
      lastError: "The IMAP login failed: authentication failed.",
      lastErrorAt: connectedAt,
      config: { provider: "imap", address: "office@summitroofing.example.com" },
      connectedAt,
    },
  ]);
  await t.admin.insert(integrationConnections).values([
    {
      ...tenant,
      provider: "google_calendar",
      externalAccountId: "office@summitroofing.example.com",
      displayName: "office@summitroofing.example.com",
      status: "active",
      connectedAt,
    },
    {
      ...tenant,
      provider: "housecall_pro",
      externalAccountId: "e2e-company",
      displayName: "Summit Roofing (Housecall Pro)",
      status: "error",
      lastError: "Housecall Pro answered with an error (500); the next lead tries again.",
      lastErrorAt: connectedAt,
      connectedAt,
    },
  ]);
  await t.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: [
        {
          key: "integrations.webhooks",
          value: [
            {
              name: "e2e-zapier",
              url: "https://hooks.example.com/e2e",
              events: ["lead_qualified"],
              active: false,
            },
          ],
        },
      ],
      actor: { type: "system", label: "e2e setup" },
    }),
  );
}

const CHANNEL_IDS = {
  whatsappPhoneNumberId: "300000000000001",
  whatsappBusinessAccountId: "300000000000002",
  pageId: "400000000000001",
  instagramAccountId: "400000000000002",
} as const;

/**
 * The business of the channel journeys (C18), with WhatsApp, Messenger and Instagram connected
 * as the connect flows of C9 and C10 leave them (tokens encrypted), every channel answering
 * without a wait, open around the clock. Its email inbox is connected by the journey itself,
 * through the admin panel.
 */
async function createChannelBusiness(
  t: TestDatabase,
  summit: { readonly agencyId: string; readonly segmentId: string | null },
): Promise<{ readonly businessId: string; readonly businessName: string }> {
  const businessName = "Northside Roofing & Gutters";
  const [row] = await t.admin
    .insert(businesses)
    .values({
      agencyId: summit.agencyId as never,
      segmentId: summit.segmentId as never,
      name: businessName,
      slug: "northside-roofing",
      status: "active",
    })
    .returning({ id: businesses.id });
  const businessId = row!.id;
  const tenant = { agencyId: summit.agencyId, businessId } as BusinessTenant;
  await t.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
    const connectedAt = new Date();
    const pageConfig = {
      pageId: CHANNEL_IDS.pageId,
      pageName: `${businessName} Page`,
      instagramAccountId: CHANNEL_IDS.instagramAccountId,
      instagramUsername: "northsideroofing",
    };
    const rows = await ctx.tx
      .insert(channelConnections)
      .values([
        {
          ...ctx.tenant,
          channel: "whatsapp",
          externalAccountId: CHANNEL_IDS.whatsappPhoneNumberId,
          displayName: "+1 612-555-0100",
          status: "active",
          config: {
            businessAccountId: CHANNEL_IDS.whatsappBusinessAccountId,
            phoneNumberId: CHANNEL_IDS.whatsappPhoneNumberId,
            displayPhoneNumber: "+1 612-555-0100",
            verifiedName: businessName,
          },
          connectedAt,
        },
        {
          ...ctx.tenant,
          channel: "messenger",
          externalAccountId: CHANNEL_IDS.pageId,
          displayName: pageConfig.pageName,
          status: "active",
          config: pageConfig,
          connectedAt,
        },
        {
          ...ctx.tenant,
          channel: "instagram",
          externalAccountId: CHANNEL_IDS.instagramAccountId,
          displayName: "@northsideroofing",
          status: "active",
          config: pageConfig,
          connectedAt,
        },
      ])
      .returning({ id: channelConnections.id, channel: channelConnections.channel });
    for (const connection of rows) {
      await t.db.secrets.channel.write(
        ctx,
        connection.id,
        connection.channel === "whatsapp"
          ? { accessToken: "EAAG-e2e-whatsapp-token" }
          : { pageAccessToken: "EAAPage-e2e-token" },
      );
    }
    await applySettingChanges(ctx, {
      target: { scope: "business", ...ctx.tenant },
      changes: [
        { key: "persona.bot_name", value: "Jo" },
        { key: "conversation.reply_wait_seconds.whatsapp", value: 0 },
        { key: "conversation.reply_wait_seconds.messenger", value: 0 },
        { key: "conversation.reply_wait_seconds.instagram", value: 0 },
        { key: "conversation.reply_wait_seconds.email", value: 0 },
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
  });
  return { businessId, businessName };
}

/** The running child (the build, then the server), stopped with this script. */
let child: ChildProcess | undefined;
let dispose: (() => Promise<void>) | undefined;
let fakes: RunningFakes | undefined;
let stopping = false;

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    child?.kill("SIGTERM");
    await dispose?.().catch(() => undefined);
    await fakes?.stop().catch(() => undefined);
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
    .select({
      id: businesses.id,
      agencyId: businesses.agencyId,
      name: businesses.name,
      segmentId: businesses.segmentId,
    })
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
  await storeConnectionStates(t, { agencyId: business.agencyId, businessId: business.id });
  const channelBusiness = await createChannelBusiness(t, {
    agencyId: business.agencyId,
    segmentId: business.segmentId,
  });
  const mailAddress = "office@northside-roofing.example.com";
  const mailPassword = randomBytes(12).toString("base64url");
  fakes = await startFakes({
    port: FAKES_PORT,
    whatsappPhoneNumberIds: [CHANNEL_IDS.whatsappPhoneNumberId],
    mailAddress,
    mailPassword,
  });
  const caFile = path.join(path.dirname(STATE_FILE), "mail-ca.crt");
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(caFile, localCertificate());

  const state: E2eState = {
    databaseUrl: t.url,
    agencyId: business.agencyId,
    businessId: business.id,
    businessName: business.name,
    widgetKey,
    channels: {
      ...channelBusiness,
      whatsappPhoneNumberId: CHANNEL_IDS.whatsappPhoneNumberId,
      pageId: CHANNEL_IDS.pageId,
      instagramAccountId: CHANNEL_IDS.instagramAccountId,
      mail: {
        address: mailAddress,
        password: mailPassword,
        imapPort: fakes.mail.imap.port,
        smtpPort: fakes.mail.smtp.port,
      },
    },
  };
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  const next = run(["start", "--port", String(APP_PORT), "--hostname", "127.0.0.1"], {
    ...env,
    DATABASE_URL: t.url,
    // Development only (ignored on a deployment): Meta and the mail server are on this machine.
    DEV_META_GRAPH_URL: FAKES_URL,
    DEV_LOCAL_MAIL_PORTS: `${fakes.mail.imap.port},${fakes.mail.smtp.port}`,
    DEV_LOCAL_MAIL_CA_FILE: caFile,
  });
  next.on("exit", (code) => void stop(code ?? 0));
}

main().catch((error: unknown) => {
  console.error(error);
  void stop(1);
});
