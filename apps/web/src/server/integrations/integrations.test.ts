import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AgencyId,
  type BusinessId,
  createLogger,
  type TraceId,
  type UserId,
} from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  businesses,
  channelConnections,
  contacts,
  conversations,
  eq,
  integrationConnections,
  integrationEvents,
  leadReports,
  leads,
  segments,
} from "@repo/db";
import { createTestDatabase, TEST_ENCRYPTION_KEY, type TestDatabase } from "@repo/db/testing";
import { createFakeCrms, type FakeCrms } from "@repo/integrations/testing";
import { createLocalJobRunner, jobEvent, type LocalJobRunner } from "@repo/jobs";

import type { SessionAccess } from "@/server/auth";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

import {
  createCrmKeyConnectHandler,
  createCrmOAuthCallbackHandler,
  createCrmOAuthStartHandler,
} from "./routes";

/*
 * CRMs through the app (C14), without any vendor account: the fakes of the five CRMs sit
 * behind the server pipeline's `integrationsFetch`. The connect routes, the jobs (lead events
 * to deliveries) and the service are the real ones. The live checks are in HUMAN_TODO 17.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_URL = "https://app.example.com";

let t: TestDatabase;
let fake: FakeCrms;
let runner: LocalJobRunner;
let server: ServerPipeline;
let tenant: { agencyId: AgencyId; businessId: BusinessId };
let adminId: UserId;
let signedIn: SessionAccess | null;

const admin = (): SessionAccess => ({
  user: { id: adminId, email: null },
  access: {
    userId: adminId,
    agencies: [{ agencyId: tenant.agencyId, role: "agency_admin" }],
    businesses: [],
  },
});

const routeDeps = () => ({
  getAccess: async () => signedIn,
  getIntegrations: () => server.integrations,
  directory: t.db.directory,
  appUrl: APP_URL,
  logger: quiet,
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  t = await createTestDatabase();
  fake = createFakeCrms();
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      APP_URL,
      CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      HUBSPOT_CLIENT_ID: "hs-client",
      HUBSPOT_CLIENT_SECRET: "hs-secret",
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789",
    integrationsFetch: fake.fetch,
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Acme Roofing",
      slug: "acme",
      status: "active",
      timezone: "America/Chicago",
    })
    .returning({ id: businesses.id });
  tenant = { agencyId, businessId: business!.id };
  adminId = (await t.db.localAuth.upsertUser({ email: "admin@agency.test", fullName: "Admin" })).id;
  signedIn = admin();
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

describe("wiring", () => {
  it("registers the integration jobs", () => {
    expect(server.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "integrations-lead-qualified",
        "integrations-lead-meeting-requested",
        "integrations-lead-handoff",
        "integrations-lead-disqualified",
        "integrations-lead-emergency",
        "integrations-booking-changed",
        "integrations-deliver",
        "integrations-sweep",
      ]),
    );
  });
});

describe("connecting a CRM through the routes", () => {
  it("connects HubSpot by OAuth for agency staff only, bound to the browser and the person", async () => {
    const start = createCrmOAuthStartHandler(routeDeps());
    const body = { businessId: tenant.businessId, returnTo: "/businesses/acme/integrations" };
    expect(
      (
        await start(
          post("/api/oauth/crm/hubspot", body, { origin: "https://evil.example" }),
          "hubspot",
        )
      ).status,
    ).toBe(403);
    signedIn = null;
    expect((await start(post("/api/oauth/crm/hubspot", body), "hubspot")).status).toBe(401);
    signedIn = {
      user: { id: adminId, email: null },
      access: {
        userId: adminId,
        agencies: [],
        businesses: [{ ...tenant, role: "client_owner", enabled: true }],
      },
    };
    expect((await start(post("/api/oauth/crm/hubspot", body), "hubspot")).status).toBe(403);
    signedIn = admin();
    expect((await start(post("/api/oauth/crm/salesforce", body), "salesforce")).status).toBe(404);
    // Jobber has no app on this deployment.
    expect((await start(post("/api/oauth/crm/jobber", body), "jobber")).status).toBe(503);

    const started = await start(post("/api/oauth/crm/hubspot", body), "hubspot");
    expect(started.status).toBe(200);
    const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
    const cookie = started.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/oauth/crm");
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const callback = createCrmOAuthCallbackHandler(routeDeps());
    const back = (query: string, provider = "hubspot", withCookie = true) =>
      callback(
        new Request(`${APP_URL}/api/oauth/crm/${provider}/callback?${query}`, {
          headers: withCookie ? { cookie: cookie.split(";")[0]! } : {},
        }),
        provider,
      );
    expect(
      (await back(`state=${encodeURIComponent(state)}&code=c`, "hubspot", false)).headers.get(
        "location",
      ),
    ).toBe("/?crm=invalid_state");
    expect(
      (await back(`state=${encodeURIComponent(state)}&code=c`, "gohighlevel")).headers.get(
        "location",
      ),
    ).toBe("/businesses/acme/integrations?crm=invalid_state");
    expect(
      (await back(`state=${encodeURIComponent(state)}&error=access_denied`)).headers.get(
        "location",
      ),
    ).toBe("/businesses/acme/integrations?crm=cancelled");
    // Another person finishing the flow connects nothing.
    signedIn = { ...admin(), user: { id: randomUUID() as UserId, email: null } };
    expect((await back(`state=${encodeURIComponent(state)}&code=c`)).headers.get("location")).toBe(
      "/businesses/acme/integrations?crm=signed_out",
    );
    signedIn = admin();
    const done = await back(`state=${encodeURIComponent(state)}&code=c`);
    expect(done.headers.get("location")).toBe("/businesses/acme/integrations?crm=connected");
    const list = await server.integrations.list(tenant);
    expect(list).toEqual([
      expect.objectContaining({ provider: "hubspot", status: "active", account: "4242" }),
    ]);
    expect(JSON.stringify(list)).not.toContain("hs-access");
  });

  it("connects Housecall Pro with a key, answering the connection and never the key", async () => {
    const connect = createCrmKeyConnectHandler(routeDeps());
    const response = await connect(
      post("/api/integrations/crm/housecall_pro", {
        businessId: tenant.businessId,
        fields: { apiKey: "hcp-key-0123456789" },
      }),
      "housecall_pro",
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"provider":"housecall_pro"');
    expect(text).not.toContain("hcp-key");
    fake.failNext("api.housecallpro.com", /company/, {
      status: 401,
      body: { error: { message: "bad key" } },
    });
    const refused = await connect(
      post("/api/integrations/crm/housecall_pro", {
        businessId: tenant.businessId,
        fields: { apiKey: "wrong-key-0123456789" },
      }),
      "housecall_pro",
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("wrong-key");
  });
});

describe("a lead event reaches the connected CRMs", () => {
  it("pushes the lead to HubSpot and Housecall Pro through the jobs", async () => {
    const [channel] = await t.admin
      .insert(channelConnections)
      .values({ ...tenant, channel: "test", externalAccountId: "test-crm", status: "active" })
      .returning({ id: channelConnections.id });
    const [contact] = await t.admin
      .insert(contacts)
      .values({
        ...tenant,
        displayName: "Pat Lee",
        phone: "+15125550199",
        email: "pat@example.com",
      })
      .returning({ id: contacts.id });
    const [conversation] = await t.admin
      .insert(conversations)
      .values({
        ...tenant,
        contactId: contact!.id,
        channelConnectionId: channel!.id,
        channel: "test",
      })
      .returning({ id: conversations.id });
    const [lead] = await t.admin
      .insert(leads)
      .values({
        ...tenant,
        contactId: contact!.id,
        conversationId: conversation!.id,
        status: "qualified",
        score: 80,
        band: "hot",
        routingOutcome: "contact_later",
      })
      .returning({ id: leads.id });
    await t.admin.insert(leadReports).values({
      ...tenant,
      leadId: lead!.id,
      version: 1,
      summary: "Hot lead",
      markdown: "## Who\nPat Lee",
      sections: {},
      score: 80,
      band: "hot",
    });
    const eventId = randomUUID();
    await server.events.send([
      jobEvent("lead.qualified", `lead-${eventId}`, {
        eventId,
        occurredAt: new Date().toISOString(),
        traceId: randomUUID() as TraceId,
        ...tenant,
        conversationId: conversation!.id,
        contactId: contact!.id,
        leadId: lead!.id,
        channel: "test",
        score: 80,
        band: "hot",
        routing: "contact_later",
      }),
    ]);
    await runner.idle();
    const rows = await t.admin
      .select({ status: integrationEvents.status, provider: integrationConnections.provider })
      .from(integrationEvents)
      .innerJoin(
        integrationConnections,
        eq(integrationConnections.id, integrationEvents.integrationConnectionId),
      )
      .where(eq(integrationEvents.leadId, lead!.id));
    expect(rows.map((row) => `${row.provider}:${row.status}`).sort()).toEqual([
      "housecall_pro:succeeded",
      "hubspot:succeeded",
    ]);
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)).toHaveLength(1);
    expect(fake.requestsTo("api.housecallpro.com", /^\/leads$/)).toHaveLength(1);
  });
});
