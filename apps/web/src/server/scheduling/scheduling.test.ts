import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ActionHandler,
  type AgencyId,
  type BusinessId,
  CHANNEL_CAPABILITIES,
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
  leadFields,
  leads,
  segments,
} from "@repo/db";
import { createTestDatabase, TEST_ENCRYPTION_KEY, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import {
  calendlyInviteeDelivery,
  calendlySignatureHeader,
  createFakeCalendarApis,
  type FakeCalendarApis,
} from "@repo/scheduling/testing";
import { settingsWith } from "@repo/settings";

import type { SessionAccess } from "@/server/auth";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

import {
  createCalendarOAuthCallbackHandler,
  createCalendarOAuthStartHandler,
  createCalendlyTokenHandler,
  handleCalendlyWebhook,
} from "./routes";

/*
 * Scheduling through the app (C12), without Google, Microsoft or Calendly: their fakes sit
 * behind the server pipeline's `schedulingFetch`. The connect routes, the Calendly webhook
 * route, the jobs and the action handlers of the pipeline's composition are the real ones.
 * The live checks are in HUMAN_TODO 32.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_URL = "https://app.example.com";
const SIGNING_KEY = "calendly-app-signing-key-for-tests";

let t: TestDatabase;
let fake: FakeCalendarApis;
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
  getScheduling: () => server.scheduling.connections,
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
  fake = createFakeCalendarApis();
  runner = createLocalJobRunner({ logger: quiet, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      APP_URL,
      CREDENTIALS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      MICROSOFT_CLIENT_ID: "ms-client",
      MICROSOFT_CLIENT_SECRET: "ms-secret",
      CALENDLY_CLIENT_ID: "calendly-client",
      CALENDLY_CLIENT_SECRET: "calendly-secret",
      CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789",
    schedulingFetch: fake.fetch,
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
  it("registers the scheduling jobs and the three action handlers", () => {
    const ids = server.jobs.map((job) => job.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "scheduling-reminders",
        "scheduling-meeting-requested",
        "scheduling-reminder-sweep",
      ]),
    );
    expect(server.pipeline.context.actions.types()).toEqual(
      expect.arrayContaining(["offer_times", "book_meeting", "cancel_meeting"]),
    );
  });
});

describe("connecting Google Calendar through the routes", () => {
  it("refuses another site, a signed-out person and a client user; connects for agency staff", async () => {
    const start = createCalendarOAuthStartHandler(routeDeps());
    const body = { businessId: tenant.businessId, returnTo: "/businesses/acme/integrations" };
    expect(
      (
        await start(
          post("/api/oauth/calendar/google", body, { origin: "https://evil.example" }),
          "google",
        )
      ).status,
    ).toBe(403);
    signedIn = null;
    expect((await start(post("/api/oauth/calendar/google", body), "google")).status).toBe(401);
    signedIn = {
      user: { id: adminId, email: null },
      access: {
        userId: adminId,
        agencies: [],
        businesses: [{ ...tenant, role: "client_owner", enabled: true }],
      },
    };
    expect((await start(post("/api/oauth/calendar/google", body), "google")).status).toBe(403);
    signedIn = admin();
    expect((await start(post("/api/oauth/calendar/other", body), "other")).status).toBe(404);

    const started = await start(post("/api/oauth/calendar/google", body), "google");
    expect(started.status).toBe(200);
    const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
    const cookie = started.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/oauth/calendar");
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const callback = createCalendarOAuthCallbackHandler(routeDeps());
    const back = (query: string, withCookie = true) =>
      callback(
        new Request(`${APP_URL}/api/oauth/calendar/google/callback?${query}`, {
          headers: withCookie ? { cookie: cookie.split(";")[0]! } : {},
        }),
        "google",
      );
    // Without the browser's cookie, or on the wrong provider's route, nothing is connected.
    expect(
      (await back(`state=${encodeURIComponent(state)}&code=c`, false)).headers.get("location"),
    ).toBe("/?calendar=invalid_state");
    const wrong = await callback(
      new Request(
        `${APP_URL}/api/oauth/calendar/microsoft/callback?state=${encodeURIComponent(state)}&code=c`,
        {
          headers: { cookie: cookie.split(";")[0]! },
        },
      ),
      "microsoft",
    );
    expect(wrong.headers.get("location")).toBe(
      "/businesses/acme/integrations?calendar=invalid_state",
    );
    const done = await back(`state=${encodeURIComponent(state)}&code=c`);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/businesses/acme/integrations?calendar=connected");
    const list = await server.scheduling.connections.list(tenant);
    expect(list).toMatchObject([
      { provider: "google_calendar", account: fake.google.address, status: "active" },
    ]);
    expect(JSON.stringify(list)).not.toContain("access-");
  });
});

describe("Calendly through the routes", () => {
  it("connects a personal token and records a booking from the webhook route", async () => {
    fake.calendly.tokens.add("calendly-pat-0123456789abcdef");
    const connect = createCalendlyTokenHandler(routeDeps());
    const response = await connect(
      post("/api/integrations/calendly/token", {
        businessId: tenant.businessId,
        token: "calendly-pat-0123456789abcdef",
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("calendly-pat");
    const [row] = await t.admin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, "calendly"));
    const key = row!.config["webhookKey"] as string;
    const signingKey = ([...fake.calendly.webhooks.values()][0] as { signing_key: string })
      .signing_key;

    // A conversation whose lead is to be booked gets a single-use link from the real handler.
    const [channel] = await t.admin
      .insert(channelConnections)
      .values({ ...tenant, channel: "test", externalAccountId: "acme-test", status: "active" })
      .returning({ id: channelConnections.id });
    const [contact] = await t.admin
      .insert(contacts)
      .values({ ...tenant, displayName: "Pat", phone: "+15125550199" })
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
        status: "meeting_requested",
        routingOutcome: "book_meeting",
      })
      .returning({ id: leads.id });
    await t.admin.insert(leadFields).values({
      ...tenant,
      leadId: lead!.id,
      key: "contact_name",
      value: "Pat",
      confidence: 1,
      evidence: null,
    });
    const handler = server.pipeline.context.actions.find(
      "offer_times",
    ) as ActionHandler<"offer_times">;
    const outcome = await handler.handle(
      { type: "offer_times", preference: null, count: 3 },
      {
        trace: {
          traceId: crypto.randomUUID() as TraceId,
          ...tenant,
          conversationId: conversation!.id,
        },
        mode: "live",
        toolCallId: "toolu_1",
        now: new Date().toISOString(),
        settings: settingsWith({
          "scheduling.provider": "calendly",
          "scheduling.calendly_event_type": "https://calendly.com/summit-roofing/estimate",
        }),
        channel: {
          id: "test",
          capabilities: CHANNEL_CAPABILITIES.test,
          window: { open: true, closesAt: null },
        },
        business: {
          id: tenant.businessId,
          agencyId: tenant.agencyId,
          name: "Acme Roofing",
          segment: { id: crypto.randomUUID() as never, slug: "roofing", name: "Roofing" },
          timezone: "America/Chicago",
        },
      },
    );
    expect(outcome.status).toBe("applied");
    const link = new URL((outcome.data as { link: string }).link);

    // Soon enough that no reminder is due, so the reminders run ends at once.
    const start = new Date(Date.now() + 20 * 60_000);
    const body = calendlyInviteeDelivery({
      event: "invitee.created",
      inviteeUuid: "INVWEB",
      eventUuid: "EVTWEB",
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
      token: link.searchParams.get("utm_content"),
    });
    const deliver = (signature: string) =>
      handleCalendlyWebhook(
        new Request(`${APP_URL}/api/webhooks/calendly/${key}`, {
          method: "POST",
          headers: { "content-type": "application/json", "calendly-webhook-signature": signature },
          body,
        }),
        key,
        server.scheduling.calendlyWebhook,
        quiet,
      );
    expect((await deliver(calendlySignatureHeader(SIGNING_KEY, body, new Date()))).status).toBe(
      401,
    );
    expect((await deliver(calendlySignatureHeader(signingKey, body, new Date()))).status).toBe(200);
    await runner.idle();
    const [stored] = await t.admin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, row!.id));
    expect(stored!.status).toBe("active");
    const [lead2] = await t.admin.select().from(leads).where(eq(leads.id, lead!.id));
    expect(lead2!.status).toBe("meeting_booked");
    // The webhook's event started the reminders job for the booking.
    const runs = runner.history.filter((run) => run.functionId === "scheduling-reminders");
    expect(runs.map((run) => run.status)).toEqual(["completed"]);
  });
});
