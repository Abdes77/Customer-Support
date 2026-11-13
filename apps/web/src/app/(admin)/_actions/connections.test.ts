import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeGraph,
  type FakeGraph,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
} from "@repo/channel-whatsapp/testing";
import { type ChannelConnectionId, createLogger } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  auditLog,
  channelConnections,
  channelConnectionSecrets,
  eq,
  loadUserAccess,
  type UserIdentity,
} from "@repo/db";
import {
  createTestDatabase,
  createWorld,
  TEST_ENCRYPTION_KEY,
  type TestDatabase,
  type World,
} from "@repo/db/testing";
import { createFakeCrms, type FakeCrms } from "@repo/integrations/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import { applySettingChanges } from "@repo/settings/server";

import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

/*
 * The connection pages' server actions (C16) as the signed-in person, against a real database
 * and the fakes C9 to C14 ship (Meta's Graph API, the CRMs): agency staff act on their own
 * business; client users, staff of another agency, signed-out and cross-site requests are
 * refused; a connection id of another business is not found; nothing returned holds a token;
 * a signing secret reaches agency admins only.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_URL = "http://localhost:3000";

let t: TestDatabase;
let world: World;
let runner: LocalJobRunner;
let server: ServerPipeline;
let graph: FakeGraph;
let crms: FakeCrms;
let currentUser: UserIdentity | null = null;
const SAME_ORIGIN = { origin: APP_URL, host: "localhost:3000", "sec-fetch-site": "same-origin" };
let requestHeaders = new Headers(SAME_ORIGIN);

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, getAll: () => [], set() {}, delete() {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => {
  const userDatabase = (user: UserIdentity) => t.db.asUser({ id: user.id, email: user.email });
  const getAccess = async () =>
    currentUser === null
      ? null
      : {
          user: { id: currentUser.id, email: currentUser.email ?? null },
          access: await userDatabase(currentUser).run((ctx) => loadUserAccess(ctx)),
        };
  return {
    getAccess,
    requireAccess: async () => {
      const session = await getAccess();
      if (session === null) throw new Error("signed out");
      return session;
    },
    userDatabase,
  };
});
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => t.db,
}));
vi.mock("@/server/whatsapp", () => ({ getWhatsApp: () => server.whatsapp }));
vi.mock("@/server/meta-pages", () => ({ getMetaPages: () => server.metaPages }));
vi.mock("@/server/email", () => ({ getEmail: () => server.email.connections }));
vi.mock("@/server/scheduling", () => ({ getScheduling: () => server.scheduling.connections }));
vi.mock("@/server/integrations", () => ({ getIntegrations: () => server.integrations }));

const actions = () => import("./connections");

beforeAll(async () => {
  t = await createTestDatabase();
  world = await createWorld(t);
  graph = createFakeGraph({ accessToken: "EAAG-signup-token" });
  crms = createFakeCrms();
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      APP_URL,
      CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      META_APP_ID: "1234567890",
      META_APP_SECRET: "meta-app-secret-for-tests",
      META_WEBHOOK_VERIFY_TOKEN: "verify-token-for-tests",
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789abcdef",
    metaFetch: graph.fetch,
    integrationsFetch: crms.fetch,
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

function as(user: UserIdentity | null): void {
  currentUser = user;
  requestHeaders = new Headers(SAME_ORIGIN);
}

const a1 = () => world.businesses.a1.tenant;

describe("website chat", () => {
  it("is set up, re-keyed and switched by agency staff only", async () => {
    const { widgetSetUpAction, widgetRotateAction, widgetEnableAction } = await actions();
    as(world.users.a1Owner);
    expect(await widgetSetUpAction({ businessId: a1().businessId })).toMatchObject({
      ok: false,
      error: "Only agency staff can do that.",
    });
    as(world.users.bAdmin);
    expect(await widgetSetUpAction({ businessId: a1().businessId })).toMatchObject({
      ok: false,
      error: "That business was not found.",
    });
    as(world.users.aMember);
    requestHeaders = new Headers({
      origin: "https://evil.example",
      host: "localhost:3000",
      "sec-fetch-site": "cross-site",
    });
    expect(await widgetSetUpAction({ businessId: a1().businessId })).toMatchObject({ ok: false });
    as(world.users.aMember);
    expect((await widgetSetUpAction({ businessId: a1().businessId })).ok).toBe(true);
    const widgetRow = async () =>
      (
        await t.admin
          .select()
          .from(channelConnections)
          .where(eq(channelConnections.businessId, a1().businessId))
      ).find((row) => row.channel === "widget");
    const before = await widgetRow();
    expect(before?.status).toBe("active");
    expect((await widgetRotateAction({ businessId: a1().businessId })).ok).toBe(true);
    expect((await widgetRow())?.externalAccountId).not.toBe(before?.externalAccountId);
    expect(await widgetEnableAction({ businessId: a1().businessId, enabled: false })).toEqual({
      ok: true,
      value: "The website chat is off.",
    });
    expect((await widgetRow())?.status).toBe("disabled");
  });
});

describe("WhatsApp", () => {
  let connectionId: ChannelConnectionId;

  beforeAll(async () => {
    const [row] = await t.admin
      .insert(channelConnections)
      .values({
        ...a1(),
        channel: "whatsapp",
        externalAccountId: FIXTURE_PHONE_NUMBER_ID,
        status: "active",
        config: { businessAccountId: FIXTURE_WABA_ID, phoneNumberId: FIXTURE_PHONE_NUMBER_ID },
      })
      .returning({ id: channelConnections.id });
    connectionId = row!.id;
    await t.db.forBusiness(a1().businessId).run((ctx) =>
      t.db.secrets.channel.write(ctx, connectionId, {
        accessToken: "EAAG-number-token",
        pin: "123456",
      }),
    );
  });

  it("lists the number without its token, syncs templates and disconnects", async () => {
    const list = await server.whatsapp!.list(a1());
    expect(list.map((item) => item.connectionId)).toContain(connectionId);
    expect(JSON.stringify(list)).not.toContain("EAAG");
    const {
      whatsappSyncTemplatesAction,
      whatsappDisconnectAction,
      whatsappAddSuggestedTemplateAction,
    } = await actions();
    as(world.users.aMember);
    expect(
      (await whatsappSyncTemplatesAction({ businessId: a1().businessId, connectionId })).ok,
    ).toBe(true);
    // A template that is not one of the suggestions is refused before Meta is asked.
    expect(
      await whatsappAddSuggestedTemplateAction({
        businessId: a1().businessId,
        connectionId,
        name: "anything_else",
      }),
    ).toMatchObject({ ok: false });
    // Another business's id with this connection: not found in that business's scope.
    expect(
      (
        await whatsappDisconnectAction({
          businessId: world.businesses.a2.tenant.businessId,
          connectionId,
        })
      ).ok,
    ).toBe(false);
    as(world.users.a1Owner);
    expect((await whatsappDisconnectAction({ businessId: a1().businessId, connectionId })).ok).toBe(
      false,
    );
    as(world.users.aMember);
    expect((await whatsappDisconnectAction({ businessId: a1().businessId, connectionId })).ok).toBe(
      true,
    );
    const [row] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connectionId));
    expect(row?.status).toBe("disabled");
    const secrets = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, connectionId));
    expect(secrets).toEqual([]);
  });
});

describe("CRMs and webhooks", () => {
  it("tests a CRM, previews the mapping for this business's leads only", async () => {
    const connection = await server.integrations.connectWithKey(
      a1(),
      world.users.aAdmin.id,
      "housecall_pro",
      { fields: { apiKey: "hcp-key-0123456789" } },
    );
    const { crmTestAction, mappingPreviewAction, crmDisconnectAction } = await actions();
    as(world.users.aMember);
    const tested = await crmTestAction({
      businessId: a1().businessId,
      connectionId: connection.id,
    });
    expect(tested.ok).toBe(true);
    expect(JSON.stringify(tested)).not.toContain("hcp-key");
    const leadId = world.businesses.a1.rows.get("leads")!.fixture!;
    const preview = await mappingPreviewAction({
      businessId: a1().businessId,
      provider: "housecall_pro",
      leadId,
    });
    expect(preview.ok).toBe(true);
    // Another business's lead is not found in this business's scope.
    const other = await mappingPreviewAction({
      businessId: a1().businessId,
      provider: "housecall_pro",
      leadId: world.businesses.b1.rows.get("leads")!.fixture!,
    });
    expect(other.ok).toBe(false);
    as(world.users.a1Owner);
    expect(
      (await crmTestAction({ businessId: a1().businessId, connectionId: connection.id })).ok,
    ).toBe(false);
    as(world.users.bAdmin);
    expect(
      (await crmDisconnectAction({ businessId: a1().businessId, connectionId: connection.id })).ok,
    ).toBe(false);
    as(world.users.aMember);
    expect(
      (await crmDisconnectAction({ businessId: a1().businessId, connectionId: connection.id })).ok,
    ).toBe(true);
  });

  it("shows a webhook's signing secret to agency admins only, and audits it", async () => {
    await t.db.forBusiness(a1().businessId).run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "business", ...a1() },
        changes: [
          {
            key: "integrations.webhooks",
            value: [
              {
                name: "zapier",
                url: "https://hooks.example.com/abc",
                events: ["lead_qualified"],
                active: true,
              },
            ],
          },
        ],
        actor: { type: "system", label: "test" },
      }),
    );
    const { webhookRevealAction, webhookRotateAction } = await actions();
    const ref = { businessId: a1().businessId, scope: "business", name: "zapier" };
    for (const user of [world.users.aMember, world.users.a1Owner, world.users.bAdmin]) {
      as(user);
      const result = await webhookRevealAction(ref);
      expect(result.ok, `${user.email}`).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/whsec_/);
    }
    as(world.users.aAdmin);
    const shown = await webhookRevealAction(ref);
    expect(shown).toMatchObject({ ok: true });
    const rotated = await webhookRotateAction(ref);
    expect(rotated.ok && shown.ok && rotated.value !== shown.value).toBe(true);
    const audit = await t.admin
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.businessId, a1().businessId));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "integrations.webhook_secret_revealed",
        "integrations.webhook_secret_rotated",
      ]),
    );
  });
});
