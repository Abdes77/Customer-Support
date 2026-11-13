import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AgencyId,
  type BusinessId,
  createLogger,
  type IntegrationConnectionId,
  type LeadId,
  TenantAccessError,
  type TraceId,
  type UserId,
} from "@repo/core";
import {
  auditLog,
  bookings,
  businesses,
  channelConnections,
  contacts,
  conversations,
  eq,
  integrationConnections,
  integrationEvents,
  integrationRecords,
  leadFields,
  leadReports,
  leads,
  messages,
  segments,
  settingValues,
  type UserAccess,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { type AnyJobEvent, type EventJobDefinition, type StepTools } from "@repo/jobs";

import { createHousecallProConnector } from "../connectors/housecall-pro";
import { createHubSpotConnector } from "../connectors/hubspot";
import { isPublicAddress } from "../net/address";
import { createSafePoster } from "../net/safe-post";
import { CRM_OAUTH_COOKIE } from "../oauth";
import {
  createFakeCrms,
  type FakeCrms,
  startWebhookReceiver,
  type WebhookReceiver,
} from "../testing";
import { verifyWebhookSignature } from "../webhook/sign";
import { deliverOnce, MAX_ATTEMPTS } from "./deliver";
import type { IntegrationDeps } from "./deps";
import { createIntegrationJobs, INTEGRATION_FUNCTION_IDS } from "./jobs";
import { planDeliveries } from "./plan";
import { createIntegrationService } from "./service";

const TRACE = "0e000000-0000-4000-8000-0000000000c4" as TraceId;
let now = new Date("2026-11-12T15:00:00.000Z");
const logLines: string[] = [];
const logger = createLogger({
  level: "debug",
  sink: (line) => logLines.push(JSON.stringify(line)),
});

let t: TestDatabase;
let fake: FakeCrms;
let receiver: WebhookReceiver;
const sent: AnyJobEvent[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  receiver = await startWebhookReceiver({ now: () => now });
});
afterAll(async () => {
  await receiver?.close();
  await t?.dispose();
});

/** A webhook address as a person would type it; the test poster sends it to the receiver. */
function hookUrl(path = "/hooks/lead"): string {
  return `https://hooks.receiver.example:${receiver.port}${path}`;
}

function deps(overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return {
    db: t.db,
    logger,
    events: {
      async send(events) {
        sent.push(...events);
      },
    },
    clock: () => now,
    appUrl: "https://app.example",
    fetch: fake.fetch,
    // Webhook addresses in settings must be https; in tests the name resolves to the local
    // receiver, the rules are widened to reach the loopback interface, and the transport
    // speaks plain HTTP to the pinned address.
    poster: createSafePoster({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isAllowedAddress: (address) => address === "127.0.0.1" || isPublicAddress(address),
      extraPorts: [receiver.port],
      transport: async ({ url, address, headers, body, signal }) => {
        const response = await fetch(`http://${address.address}:${url.port}${url.pathname}`, {
          method: "POST",
          headers,
          body,
          signal,
          redirect: "manual",
        });
        await response.arrayBuffer();
        return { status: response.status, headers: {} };
      },
    }),
    apps: {
      hubspot: { clientId: "hs-client", clientSecret: "hs-secret" },
      gohighlevel: { clientId: "ghl-client", clientSecret: "ghl-secret" },
      jobber: null,
      servicetitan: { appKey: "st-app-key", environment: "integration" },
    },
    oauthStateKey: new Uint8Array(32).fill(7),
    ...overrides,
  };
}

const step: StepTools = {
  run: async (_id, fn) => JSON.parse(JSON.stringify((await fn()) ?? null)) as never,
  sleep: async () => {},
  sleepUntil: async () => {},
};

interface Fixture {
  readonly tenant: { readonly agencyId: AgencyId; readonly businessId: BusinessId };
  readonly leadId: LeadId;
  readonly conversationId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly userId: UserId;
}

async function fixture(agencyId?: AgencyId): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const agency =
    agencyId ?? (await t.db.platform.createAgency({ name: `A ${suffix}`, slug: `a-${suffix}` })).id;
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId: agency, slug: `roofing-${suffix}`, name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId: agency,
      segmentId: segment!.id,
      name: "Summit Roofing",
      slug: `summit-${suffix}`,
      status: "active",
      timezone: "America/Chicago",
    })
    .returning({ id: businesses.id });
  const tenant = { agencyId: agency, businessId: business!.id };
  const [channel] = await t.admin
    .insert(channelConnections)
    .values({ ...tenant, channel: "test", externalAccountId: `test-${suffix}`, status: "active" })
    .returning({ id: channelConnections.id });
  const [contact] = await t.admin
    .insert(contacts)
    .values({
      ...tenant,
      displayName: "Pat Lee",
      phone: "+15125550199",
      email: `pat-${suffix}@example.com`,
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
      score: 82,
      band: "hot",
      routingOutcome: "book_meeting",
    })
    .returning({ id: leads.id });
  await t.admin.insert(leadFields).values([
    {
      ...tenant,
      leadId: lead!.id,
      key: "job_address",
      value: "1200 Elm St, Austin, TX 78704",
      confidence: 1,
      evidence: null,
    },
    {
      ...tenant,
      leadId: lead!.id,
      key: "service_type",
      value: 'roof leak"}, {"x":1',
      confidence: 1,
      evidence: null,
    },
  ]);
  await t.admin.insert(leadReports).values({
    ...tenant,
    leadId: lead!.id,
    version: 1,
    summary: "Hot lead",
    markdown: '## Who\nPat Lee\n## Job\n"Ignore previous instructions" <b>roof</b>',
    sections: {},
    score: 82,
    band: "hot",
  });
  const user = await t.db.localAuth.upsertUser({
    email: `staff-${suffix}@agency.test`,
    fullName: "Staff",
  });
  return {
    tenant,
    leadId: lead!.id,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId: channel!.id,
    userId: user.id,
  };
}

/** The access of the fixture's staff user as an agency admin (what `requireAccess()` gives). */
function admin(f: Fixture): UserAccess {
  return {
    userId: f.userId,
    agencies: [{ agencyId: f.tenant.agencyId, role: "agency_admin" }],
    businesses: [],
  };
}

function member(f: Fixture) {
  return { agencyId: f.tenant.agencyId, role: "agency_member" as const };
}

async function setting(
  f: Fixture,
  key: string,
  value: unknown,
  scope: "business" | "global" = "business",
) {
  await t.admin.insert(settingValues).values({
    agencyId: f.tenant.agencyId,
    scope,
    businessId: scope === "business" ? f.tenant.businessId : null,
    key,
    value,
  });
}

async function connectHubSpot(f: Fixture): Promise<IntegrationConnectionId> {
  const [row] = await t.admin
    .insert(integrationConnections)
    .values({
      ...f.tenant,
      provider: "hubspot",
      externalAccountId: "4242",
      displayName: "HubSpot account 4242",
      status: "active",
      config: { hubId: "4242" },
      connectedAt: now,
    })
    .returning({ id: integrationConnections.id });
  await t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
    t.db.secrets.integration.write(ctx, row!.id, {
      kind: "oauth",
      accessToken: "hs-token-SECRET",
      refreshToken: "hs-refresh-SECRET",
      expiresAt: "2026-11-12T16:00:00.000Z",
    }),
  );
  return row!.id;
}

function leadEvent(
  f: Fixture,
  name:
    | "lead.qualified"
    | "lead.meeting_requested"
    | "lead.handoff"
    | "lead.disqualified"
    | "lead.emergency",
  score = 82,
) {
  const base = {
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    traceId: TRACE,
    agencyId: f.tenant.agencyId,
    businessId: f.tenant.businessId,
    conversationId: f.conversationId,
    contactId: f.contactId,
    leadId: f.leadId,
    channel: "test",
    score,
    band: "hot",
  };
  const extra =
    name === "lead.qualified"
      ? { routing: "book_meeting" }
      : name === "lead.meeting_requested"
        ? { bookingMode: "calendar" }
        : name === "lead.handoff"
          ? { routing: "contact_later", trigger: "routing", urgency: "normal" }
          : name === "lead.disqualified"
            ? { reasonCode: "out_of_area" }
            : { emergencyClass: "gas_leak" };
  return { name, id: base.eventId, data: { ...base, ...extra } };
}

function job(id: string): EventJobDefinition {
  const found = createIntegrationJobs(deps()).find((definition) => definition.id === id);
  return found as unknown as EventJobDefinition;
}

async function runEvent(
  event: ReturnType<typeof leadEvent> | { name: string; id: string; data: unknown },
  jobId: string,
) {
  const before = sent.length;
  await job(jobId).handler({
    event: event as never,
    step,
    runId: randomUUID(),
    attempt: 0,
    logger,
  });
  return sent.slice(before);
}

async function runDeliveries(
  events: readonly AnyJobEvent[],
  overrides: Partial<IntegrationDeps> = {},
) {
  const definition = createIntegrationJobs(deps(overrides)).find(
    (d) => d.id === INTEGRATION_FUNCTION_IDS.deliver,
  ) as unknown as EventJobDefinition<"integrations.delivery_requested">;
  const outcomes: unknown[] = [];
  for (const event of events) {
    if (event.name !== "integrations.delivery_requested") continue;
    outcomes.push(
      await definition.handler({
        event: { name: event.name, id: event.id, data: event.data },
        step,
        runId: randomUUID(),
        attempt: 0,
        logger,
      }),
    );
  }
  return outcomes;
}

async function deliveries(f: Fixture) {
  return t.admin
    .select()
    .from(integrationEvents)
    .where(eq(integrationEvents.businessId, f.tenant.businessId));
}

describe("lead events to a CRM", () => {
  it("plans one delivery per connection, pushes once, and a replayed event pushes nothing again", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const connectionId = await connectHubSpot(f);
    const event = leadEvent(f, "lead.qualified");
    const emitted = await runEvent(event, INTEGRATION_FUNCTION_IDS.leadQualified);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      name: "integrations.delivery_requested",
      data: { connectionId, businessId: f.tenant.businessId },
    });
    // Payloads carry ids only.
    expect(JSON.stringify(emitted)).not.toContain("Pat");

    expect(await runDeliveries(emitted)).toEqual([{ status: "succeeded" }]);
    const creates = fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/);
    expect(creates).toHaveLength(1);
    expect((creates[0]!.body as { properties: Record<string, string> }).properties).toMatchObject({
      firstname: "Pat",
      lastname: "Lee",
      phone: "+15125550199",
      zip: "78704",
    });
    const [record] = await t.admin
      .select()
      .from(integrationRecords)
      .where(eq(integrationRecords.leadId, f.leadId));
    expect(record).toMatchObject({
      externalUrl: expect.stringContaining("/contacts/4242/record/0-1/"),
    });
    expect(record!.externalId).not.toBeNull();

    // The same event again (at-least-once delivery) plans nothing new and sends nothing.
    const again = await runEvent(event, INTEGRATION_FUNCTION_IDS.leadQualified);
    expect(again).toHaveLength(0);
    // A re-run of the delivery job finds the journal and sends nothing.
    expect(await runDeliveries(emitted)).toEqual([{ status: "succeeded" }]);
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)).toHaveLength(1);

    const [row] = await deliveries(f);
    expect(row).toMatchObject({
      status: "succeeded",
      attempts: 1,
      eventType: "lead.qualified",
      errorMessage: null,
    });
    expect(JSON.stringify(row)).not.toContain("hs-token");
    expect(logLines.join("\n")).not.toContain("hs-token-SECRET");
    expect(logLines.join("\n")).not.toContain("Pat Lee");
  });

  it("updates the same record on a later event, and skips an update that changes nothing", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    await runDeliveries(
      await runEvent(leadEvent(f, "lead.qualified"), INTEGRATION_FUNCTION_IDS.leadQualified),
    );
    // The same lead, unchanged, then a booking: one skipped update, one real update.
    expect(
      await runDeliveries(
        await runEvent(
          leadEvent(f, "lead.meeting_requested"),
          INTEGRATION_FUNCTION_IDS.leadMeetingRequested,
        ),
      ),
    ).toEqual([{ status: "skipped" }]);
    await t.admin.update(leads).set({ status: "meeting_booked" }).where(eq(leads.id, f.leadId));
    expect(
      await runDeliveries(
        await runEvent(leadEvent(f, "lead.handoff"), INTEGRATION_FUNCTION_IDS.leadHandoff),
      ),
    ).toEqual([{ status: "succeeded" }]);
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)).toHaveLength(1);
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts\/\d+$/)).toHaveLength(
      1,
    );
    const rows = await deliveries(f);
    expect(rows.map((row) => row.status).sort()).toEqual(["skipped", "succeeded", "succeeded"]);
    expect(rows.find((row) => row.status === "skipped")!.errorCode).toBe("unchanged");
  });

  it("follows the settings: events, minimum score (not for handoffs), updates switched off", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    await setting(f, "integrations.minimum_score", 90);
    expect(
      await runEvent(leadEvent(f, "lead.qualified", 82), INTEGRATION_FUNCTION_IDS.leadQualified),
    ).toHaveLength(0);
    // Disqualified is not in the default events.
    expect(
      await runEvent(
        leadEvent(f, "lead.disqualified", 95),
        INTEGRATION_FUNCTION_IDS.leadDisqualified,
      ),
    ).toHaveLength(0);
    const handoff = await runEvent(
      leadEvent(f, "lead.handoff", 10),
      INTEGRATION_FUNCTION_IDS.leadHandoff,
    );
    expect(handoff).toHaveLength(1);
    expect(await runDeliveries(handoff)).toEqual([{ status: "succeeded" }]);
    await setting(f, "integrations.update_on_change", false);
    await t.admin.update(leads).set({ score: 99 }).where(eq(leads.id, f.leadId));
    const later = await runEvent(
      leadEvent(f, "lead.qualified", 99),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    expect(await runDeliveries(later)).toEqual([{ status: "skipped" }]);
    expect(fake.requestsTo("api.hubapi.com", /contacts\/\d+$/)).toHaveLength(0);
  });

  it("uses the business's field mapping instead of the default when it has entries", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    await setting(f, "integrations.field_mapping.hubspot", [
      { source: "contact.email", target: "email", transform: null },
      { source: "lead.score", target: "ai_score", transform: "number" },
    ]);
    await runDeliveries(
      await runEvent(leadEvent(f, "lead.qualified"), INTEGRATION_FUNCTION_IDS.leadQualified),
    );
    const create = fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)[0]!;
    expect((create.body as { properties: Record<string, string> }).properties).toEqual({
      email: expect.stringMatching(/@example\.com$/),
      ai_score: "82",
    });
  });

  it("refreshes an expiring token under the lock and stores the new one", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const connectionId = await connectHubSpot(f);
    now = new Date("2026-11-12T15:59:00.000Z");
    try {
      await runDeliveries(
        await runEvent(leadEvent(f, "lead.qualified"), INTEGRATION_FUNCTION_IDS.leadQualified),
      );
      const stored = await t.db
        .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
        .run((ctx) =>
          t.db.secrets.integration.read<{ accessToken: string; refreshToken: string }>(
            ctx,
            connectionId,
          ),
        );
      expect(stored!.accessToken).toMatch(/^hs-access-/);
      expect(stored!.refreshToken).toBe("hs-refresh-rotated");
      const contactCall = fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)[0]!;
      expect(contactCall.headers["authorization"]).toBe(`Bearer ${stored!.accessToken}`);
    } finally {
      now = new Date("2026-11-12T15:00:00.000Z");
    }
  });

  it("retries with backoff, then fails for good; an auth failure asks for a reconnect at once", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const connectionId = await connectHubSpot(f);
    const [planned] = await planDeliveries(deps(), {
      agencyId: f.tenant.agencyId,
      businessId: f.tenant.businessId,
      traceId: TRACE,
      eventType: "lead.qualified",
      option: "lead_qualified",
      eventKey: randomUUID(),
      leadId: f.leadId,
      score: 82,
      updatesOnly: false,
    });
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      fake.failNext("api.hubapi.com", /search/, {
        status: 503,
        body: { message: "Service Unavailable" },
      });
    }
    const outcomes = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      outcomes.push(await deliverOnce(deps(), f.tenant, planned!.deliveryId));
    }
    expect(outcomes.slice(0, -1).map((o) => o.status === "retry" && o.waitMs / 60_000)).toEqual([
      1, 5, 15, 60, 240,
    ]);
    expect(outcomes.at(-1)).toEqual({ status: "failed" });
    const [row] = await t.admin
      .select()
      .from(integrationEvents)
      .where(eq(integrationEvents.id, planned!.deliveryId));
    expect(row).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorCode: "unavailable",
      retryable: true,
    });
    // A finished delivery is never attempted again.
    expect(await deliverOnce(deps(), f.tenant, planned!.deliveryId)).toEqual({ status: "failed" });

    fake.failNext("api.hubapi.com", /search/, {
      status: 401,
      body: { message: "Authentication credentials not found." },
    });
    const [second] = await planDeliveries(deps(), {
      agencyId: f.tenant.agencyId,
      businessId: f.tenant.businessId,
      traceId: TRACE,
      eventType: "lead.handoff",
      option: "handoff",
      eventKey: randomUUID(),
      leadId: f.leadId,
      score: 82,
      updatesOnly: false,
    });
    expect(await deliverOnce(deps(), f.tenant, second!.deliveryId)).toEqual({ status: "failed" });
    const [connection] = await t.admin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(connection).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("connect it again"),
    });

    // The admin panel sees the failure and retries it once connected again.
    const service = createIntegrationService(deps());
    const log = await service.deliveries(f.tenant, { connectionId });
    expect(log.map((d) => d.status)).toEqual(["failed", "failed"]);
    expect(JSON.stringify(log)).not.toContain("hs-token");
    await t.admin
      .update(integrationConnections)
      .set({ status: "active" })
      .where(eq(integrationConnections.id, connectionId));
    const before = sent.length;
    const retried = await service.retry(f.tenant, f.userId, second!.deliveryId);
    expect(retried).toMatchObject({ status: "pending", attempts: 0 });
    const retryEvents = sent.slice(before);
    expect(retryEvents).toHaveLength(1);
    expect(await runDeliveries(retryEvents)).toEqual([{ status: "succeeded" }]);
    await expect(service.retry(f.tenant, f.userId, second!.deliveryId)).rejects.toThrow(
      /Only a failed/,
    );
  });

  it("a connection switched off skips its pending deliveries", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const connectionId = await connectHubSpot(f);
    const emitted = await runEvent(
      leadEvent(f, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    await createIntegrationService(deps()).disconnect(f.tenant, f.userId, connectionId);
    expect(await runDeliveries(emitted)).toEqual([{ status: "skipped" }]);
    expect(fake.requests).toHaveLength(0);
    const secret = await t.db
      .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
      .run((ctx) => t.db.secrets.integration.read(ctx, connectionId));
    expect(secret).toBeNull();
  });

  it("updates a pushed lead after a booking change, and leaves leads no CRM has alone", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    const [booking] = await t.admin
      .insert(bookings)
      .values({
        ...f.tenant,
        contactId: f.contactId as never,
        conversationId: f.conversationId as never,
        leadId: f.leadId,
        provider: "manual",
        status: "confirmed",
        startsAt: new Date("2026-11-13T16:00:00Z"),
        endsAt: new Date("2026-11-13T17:00:00Z"),
        timezone: "America/Chicago",
      })
      .returning({ id: bookings.id });
    const bookingEvent = {
      name: "scheduling.booking_changed",
      id: `booking-${booking!.id}-1`,
      data: {
        traceId: TRACE,
        agencyId: f.tenant.agencyId,
        businessId: f.tenant.businessId,
        bookingId: booking!.id,
        version: 1,
        change: "confirmed",
      },
    };
    // Not pushed yet: a booking alone creates nothing.
    expect(await runEvent(bookingEvent, INTEGRATION_FUNCTION_IDS.bookingChanged)).toHaveLength(0);
    await runDeliveries(
      await runEvent(leadEvent(f, "lead.qualified"), INTEGRATION_FUNCTION_IDS.leadQualified),
    );
    const moved = {
      ...bookingEvent,
      id: `booking-${booking!.id}-2`,
      data: { ...bookingEvent.data, version: 2, change: "moved" },
    };
    await t.admin
      .update(bookings)
      .set({ startsAt: new Date("2026-11-14T16:00:00Z") })
      .where(eq(bookings.id, booking!.id));
    const emitted = await runEvent(moved, INTEGRATION_FUNCTION_IDS.bookingChanged);
    expect(emitted).toHaveLength(1);
    expect(await runDeliveries(emitted)).toEqual([{ status: "succeeded" }]);
    const rows = await deliveries(f);
    expect(rows.map((row) => row.eventType).sort()).toEqual(["booking.moved", "lead.qualified"]);
  });
});

describe("lost answers, reconnects and refreshed tokens", () => {
  /** Housecall Pro whose push reaches the vendor, then fails on our side (once). */
  function flakyHousecallPro() {
    const real = createHousecallProConnector();
    let fail = true;
    const connector: typeof real = {
      ...real,
      async pushLead(context, payload, options) {
        const result = await real.pushLead(context, payload, options);
        if (fail) {
          fail = false;
          throw new Error("the database went away after the vendor answered");
        }
        return result;
      },
    };
    return connector;
  }

  it("a push the vendor accepted but we never stored is found again, not created twice", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const service = createIntegrationService(deps());
    await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-0123456789" },
    });
    // "Always create": without recovery, the retry would create a second customer and lead.
    await setting(f, "integrations.duplicates", "always_create");
    const [planned] = await planDeliveries(deps(), {
      agencyId: f.tenant.agencyId,
      businessId: f.tenant.businessId,
      traceId: TRACE,
      eventType: "lead.qualified",
      option: "lead_qualified",
      eventKey: randomUUID(),
      leadId: f.leadId,
      score: 82,
      updatesOnly: false,
    });
    const flaky = deps({ connectors: { housecall_pro: flakyHousecallPro() } });
    expect(await deliverOnce(flaky, f.tenant, planned!.deliveryId)).toMatchObject({
      status: "retry",
    });
    expect(fake.requestsTo("api.housecallpro.com", /^\/leads$/)).toHaveLength(1);
    expect(await deliverOnce(flaky, f.tenant, planned!.deliveryId)).toEqual({
      status: "succeeded",
    });
    const creates = fake
      .requestsTo("api.housecallpro.com")
      .filter((r) => r.method === "POST")
      .map((r) => r.url.pathname);
    expect(creates).toEqual(["/customers", "/leads"]);
    const [record] = await t.admin
      .select()
      .from(integrationRecords)
      .where(eq(integrationRecords.leadId, f.leadId));
    expect(record!.externalId).toMatch(/^lea_/);
    // The marker is gone once the answer is stored.
    expect(record!.externalState).toEqual({ customerId: expect.stringMatching(/^cus_/) });
  });

  it("deliveries that failed for a reconnect go out once the CRM is connected again", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const service = createIntegrationService(deps());
    const connection = await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-0123456789" },
    });
    fake.failNext("api.housecallpro.com", /customers/, {
      status: 401,
      body: { error: { message: "Invalid API key" } },
    });
    const first = await runEvent(
      leadEvent(f, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    expect(await runDeliveries(first)).toEqual([{ status: "failed" }]);
    // Planned while the connection waits for a reconnect: also kept for it.
    const second = await runEvent(
      leadEvent(f, "lead.handoff"),
      INTEGRATION_FUNCTION_IDS.leadHandoff,
    );
    expect(await runDeliveries(second)).toEqual([{ status: "failed" }]);
    const waiting = await service.deliveries(f.tenant, { connectionId: connection.id });
    expect(waiting.map((d) => [d.status, d.errorCode])).toEqual([
      ["failed", "auth_expired"],
      ["failed", "auth_expired"],
    ]);
    expect(fake.requestsTo("api.housecallpro.com", /^\/leads$/)).toHaveLength(0);

    const before = sent.length;
    const again = await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-new-0123456789" },
    });
    expect(again).toMatchObject({ id: connection.id, status: "active" });
    const requeued = sent.slice(before);
    expect(requeued).toHaveLength(2);
    expect(await runDeliveries(requeued)).toEqual([
      expect.objectContaining({ status: expect.stringMatching(/succeeded|skipped/) }),
      expect.objectContaining({ status: expect.stringMatching(/succeeded|skipped/) }),
    ]);
    expect(fake.requestsTo("api.housecallpro.com", /^\/leads$/)).toHaveLength(1);
    const after = await service.deliveries(f.tenant, { connectionId: connection.id });
    expect(after.every((d) => d.status === "succeeded" || d.status === "skipped")).toBe(true);
  });

  it("connecting another account of the CRM forgets the records of the old one", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const service = createIntegrationService(deps());
    await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-0123456789" },
    });
    const emitted = await runEvent(
      leadEvent(f, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    expect(await runDeliveries(emitted)).toEqual([{ status: "succeeded" }]);
    const records = () =>
      t.admin.select().from(integrationRecords).where(eq(integrationRecords.leadId, f.leadId));
    expect(await records()).toHaveLength(1);
    // The same account again keeps them.
    await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-0123456789" },
    });
    expect(await records()).toHaveLength(1);
    fake.failNext("api.housecallpro.com", /company/, {
      status: 200,
      body: { id: "cmp_2", name: "Another Company" },
    });
    await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-other-0123456789" },
    });
    expect(await records()).toHaveLength(0);
  });

  it("a refreshed token is kept even when the delivery then fails", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const connectionId = await connectHubSpot(f);
    now = new Date("2026-11-12T15:59:00.000Z");
    try {
      const real = createHubSpotConnector({
        app: { clientId: "hs-client", clientSecret: "hs-secret" },
      });
      const broken: typeof real = {
        ...real,
        pushLead: async () => {
          throw new Error("a bug after the refresh");
        },
      };
      const [planned] = await planDeliveries(deps(), {
        agencyId: f.tenant.agencyId,
        businessId: f.tenant.businessId,
        traceId: TRACE,
        eventType: "lead.qualified",
        option: "lead_qualified",
        eventKey: randomUUID(),
        leadId: f.leadId,
        score: 82,
        updatesOnly: false,
      });
      expect(
        await deliverOnce(deps({ connectors: { hubspot: broken } }), f.tenant, planned!.deliveryId),
      ).toMatchObject({ status: "retry" });
      const stored = await t.db
        .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
        .run((ctx) => t.db.secrets.integration.read<{ refreshToken: string }>(ctx, connectionId));
      // HubSpot's answer rotated the refresh token: losing it would end the connection.
      expect(stored!.refreshToken).toBe("hs-refresh-rotated");
    } finally {
      now = new Date("2026-11-12T15:00:00.000Z");
    }
  });
});

describe("outgoing webhooks", () => {
  it("signs each delivery with the target's secret and sends customer text as JSON data", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    await setting(f, "integrations.webhooks", [
      { name: "Zapier", url: hookUrl(), events: ["lead_qualified"], active: true },
      { name: "Off", url: hookUrl(), events: ["lead_qualified"], active: false },
      { name: "Handoffs only", url: hookUrl(), events: ["handoff"], active: true },
    ]);
    const emitted = await runEvent(
      leadEvent(f, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    expect(emitted).toHaveLength(2);
    const service = createIntegrationService(deps());
    // Only an agency admin sees a signing secret: a member or a client user is refused.
    for (const access of [
      { userId: f.userId, agencies: [member(f)], businesses: [] },
      {
        userId: f.userId,
        agencies: [],
        businesses: [{ ...f.tenant, role: "client_owner" as const, enabled: true }],
      },
    ]) {
      await expect(service.revealWebhookSecret(f.tenant, access, "Zapier")).rejects.toThrow(
        TenantAccessError,
      );
      await expect(service.rotateWebhookSecret(f.tenant, access, "Zapier")).rejects.toThrow(
        TenantAccessError,
      );
      await expect(
        service.revealAgencyWebhookSecret(f.tenant.agencyId, access, "Zapier"),
      ).rejects.toThrow(TenantAccessError);
    }
    const zapierSecret = await service.revealWebhookSecret(f.tenant, admin(f), "Zapier");
    expect(zapierSecret).toMatch(/^whsec_/);
    receiver.received.length = 0;
    expect(await runDeliveries(emitted)).toEqual([
      { status: "succeeded" },
      { status: "succeeded" },
    ]);
    expect(receiver.received).toHaveLength(1);
    const zapier = receiver.received[0]!;
    expect(
      verifyWebhookSignature(
        zapierSecret,
        zapier.headers["x-hsrb-signature"] ?? null,
        zapier.body,
        now,
      ).ok,
    ).toBe(true);
    expect(zapier.headers["x-hsrb-event"]).toBe("lead.qualified");
    const body = zapier.json as {
      lead: { fields: Record<string, unknown> };
      report: { markdown: string };
    };
    expect(body.lead.fields["service_type"]).toBe('roof leak"}, {"x":1');
    expect(body.report.markdown).toContain("<b>roof</b>");
    expect(zapier.body).not.toContain("transcript");
    expect(zapier.body).not.toContain("hs-token");
    const audits = await t.admin
      .select()
      .from(auditLog)
      .where(eq(auditLog.businessId, f.tenant.businessId));
    expect(audits.map((row) => row.action)).toContain("integrations.webhook_secret_revealed");
  });

  it("adds the transcript only when the settings ask for it", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await setting(f, "integrations.webhooks", [
      { name: "Make", url: hookUrl(), events: ["handoff"], active: true },
    ]);
    await setting(f, "integrations.webhook_include_transcript", true);
    await t.admin.insert(messages).values({
      ...f.tenant,
      conversationId: f.conversationId as never,
      channelConnectionId: f.channelId as never,
      direction: "inbound",
      author: "customer",
      text: "My roof leaks over the kitchen",
      sequence: 1,
      status: "received",
    });
    receiver.received.length = 0;
    await runDeliveries(
      await runEvent(leadEvent(f, "lead.handoff"), INTEGRATION_FUNCTION_IDS.leadHandoff),
    );
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.json).toMatchObject({
      transcript: "Customer: My roof leaks over the kitchen",
    });
  });

  it("retries a target that fails while the other targets succeed, and shows the error", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    await setting(f, "integrations.webhooks", [
      { name: "Flaky", url: hookUrl(), events: ["lead_qualified"], active: true },
    ]);
    const emitted = await runEvent(
      leadEvent(f, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    expect(emitted).toHaveLength(2);
    const hookRow = (await deliveries(f)).find((row) => row.target === "business:Flaky")!;
    const webhookEvent = emitted.find(
      (e) => e.name === "integrations.delivery_requested" && e.data.deliveryId === hookRow.id,
    )!;
    receiver.answerWith(500, 500, 200);
    const crmFirst = emitted.filter((e) => e !== webhookEvent);
    expect(await runDeliveries(crmFirst)).toEqual([{ status: "succeeded" }]);
    const outcome = await runDeliveries([webhookEvent]);
    expect(outcome).toEqual([{ status: "succeeded" }]);
    const rows = await deliveries(f);
    const hook = rows.find((row) => row.target === "business:Flaky")!;
    expect(hook).toMatchObject({ status: "succeeded", attempts: 3 });
    const views = await createIntegrationService(deps()).webhookTargets(f.tenant);
    expect(views).toEqual([
      expect.objectContaining({
        name: "Flaky",
        scope: "business",
        secretHint: expect.stringMatching(/^whsec_…/),
        lastError: null,
      }),
    ]);
  });

  it("refuses a target whose address is not public, for good, and says why", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await setting(f, "integrations.webhooks", [
      {
        name: "Metadata",
        url: "https://169.254.169.254/latest/meta-data",
        events: ["handoff"],
        active: true,
      },
    ]);
    const emitted = await runEvent(
      leadEvent(f, "lead.handoff"),
      INTEGRATION_FUNCTION_IDS.leadHandoff,
    );
    expect(await runDeliveries(emitted, { poster: createSafePoster() })).toEqual([
      { status: "failed" },
    ]);
    const [row] = await deliveries(f);
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "validation",
      errorMessage: expect.stringContaining("not on the public internet"),
    });
    const check = await createIntegrationService(
      deps({ poster: createSafePoster() }),
    ).checkWebhookUrl("https://10.0.0.1/hook");
    expect(check).toEqual({ ok: false, message: "That address is not on the public internet." });
  });

  it("signs agency targets with one agency secret for every business, and rotates it", async () => {
    fake = createFakeCrms();
    const a = await fixture();
    const b = await fixture(a.tenant.agencyId);
    await setting(
      a,
      "integrations.agency_webhooks",
      [{ name: "Agency CRM", url: hookUrl(), events: ["emergency"], active: true }],
      "global",
    );
    receiver.received.length = 0;
    for (const f of [a, b]) {
      const emitted = await runEvent(
        leadEvent(f, "lead.emergency"),
        INTEGRATION_FUNCTION_IDS.leadEmergency,
      );
      expect(emitted).toHaveLength(1);
      expect(await runDeliveries(emitted)).toEqual([{ status: "succeeded" }]);
    }
    const service = createIntegrationService(deps());
    const secret = await service.revealAgencyWebhookSecret(
      a.tenant.agencyId,
      admin(a),
      "Agency CRM",
    );
    expect(receiver.received).toHaveLength(2);
    for (const got of receiver.received) {
      expect(
        verifyWebhookSignature(secret, got.headers["x-hsrb-signature"] ?? null, got.body, now).ok,
      ).toBe(true);
    }
    const businessesSeen = receiver.received.map(
      (r) => (r.json as { business: { id: string } }).business.id,
    );
    expect(new Set(businessesSeen)).toEqual(new Set([a.tenant.businessId, b.tenant.businessId]));
    const rotated = await service.rotateAgencyWebhookSecret(
      a.tenant.agencyId,
      admin(a),
      "Agency CRM",
    );
    expect(rotated).not.toBe(secret);
    const audits = await t.admin
      .select()
      .from(auditLog)
      .where(eq(auditLog.agencyId, a.tenant.agencyId));
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "integrations.agency_webhook_secret_revealed",
        "integrations.agency_webhook_secret_rotated",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(secret);
  });
});

describe("the sweeper", () => {
  it("restarts a delivery whose run was lost", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    await connectHubSpot(f);
    const planned = await planDeliveries(deps(), {
      agencyId: f.tenant.agencyId,
      businessId: f.tenant.businessId,
      traceId: TRACE,
      eventType: "lead.qualified",
      option: "lead_qualified",
      eventKey: randomUUID(),
      leadId: f.leadId,
      score: 82,
      updatesOnly: false,
    });
    const sweep = createIntegrationJobs(deps()).find(
      (d) => d.id === INTEGRATION_FUNCTION_IDS.sweep,
    )!;
    const before = sent.length;
    await sweep.handler({
      event: { name: "cron", id: null, data: {} } as never,
      step,
      runId: "r",
      attempt: 0,
      logger,
    });
    expect(
      sent
        .slice(before)
        .filter(
          (e) =>
            e.name === "integrations.delivery_requested" &&
            e.data.deliveryId === planned[0]!.deliveryId,
        ),
    ).toHaveLength(0);
    now = new Date("2026-11-12T15:20:00.000Z");
    try {
      await sweep.handler({
        event: { name: "cron", id: null, data: {} } as never,
        step,
        runId: "r",
        attempt: 0,
        logger,
      });
      const restarted = sent
        .slice(before)
        .filter(
          (e) =>
            e.name === "integrations.delivery_requested" &&
            e.data.deliveryId === planned[0]!.deliveryId,
        );
      expect(restarted).toHaveLength(1);
      expect(restarted[0]!.id).toMatch(/-sweep-\d+$/);
      expect(await runDeliveries(restarted)).toEqual([{ status: "succeeded" }]);
    } finally {
      now = new Date("2026-11-12T15:00:00.000Z");
    }
  });
});

describe("the admin panel's service", () => {
  it("connects HubSpot by OAuth: state bound to the cookie and the person, tokens stored encrypted", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const service = createIntegrationService(deps());
    const start = service.startOAuth(f.tenant, f.userId, "hubspot", {
      returnTo: "/settings/integrations",
    });
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/oauth/crm/hubspot/callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "oauth crm.objects.contacts.read crm.objects.contacts.write",
    );
    expect(start.cookie.name).toBe(CRM_OAUTH_COOKIE);
    const state = url.searchParams.get("state")!;
    expect(() => service.readState(state, null)).toThrow(/could not be verified/);
    expect(() => service.readState(`${state}x`, start.cookie.value)).toThrow();
    const payload = service.readState(state, start.cookie.value);
    expect(payload).toMatchObject({ p: "hubspot", b: f.tenant.businessId, u: f.userId });
    const view = await service.completeOAuth(payload, "code-123");
    expect(view).toMatchObject({
      provider: "hubspot",
      status: "active",
      account: "4242",
      config: { hubId: "4242" },
    });
    expect(JSON.stringify(view)).not.toMatch(/hs-access|refresh/);
    const exchange = fake.requestsTo("api.hubapi.com", /oauth/)[0]!;
    expect(exchange.body).toMatchObject({
      grant_type: "authorization_code",
      code: "code-123",
      code_verifier: payload.verifier,
    });
    const listed = await service.list(f.tenant);
    expect(listed).toHaveLength(1);
    const [row] = await t.admin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, view.id));
    expect(JSON.stringify(row)).not.toContain("hs-access");
    // Expired state.
    now = new Date("2026-11-12T15:11:00.000Z");
    try {
      expect(() => service.readState(state, start.cookie.value)).toThrow();
    } finally {
      now = new Date("2026-11-12T15:00:00.000Z");
    }
  });

  it("connects Housecall Pro and ServiceTitan with keys, after testing them", async () => {
    fake = createFakeCrms();
    const f = await fixture();
    const service = createIntegrationService(deps());
    const hcp = await service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
      fields: { apiKey: "hcp-key-0123456789" },
    });
    expect(hcp).toMatchObject({
      provider: "housecall_pro",
      displayName: "Summit Roofing",
      status: "active",
    });
    fake.failNext("api.housecallpro.com", /company/, {
      status: 401,
      body: { error: { message: "bad key" } },
    });
    await expect(
      service.connectWithKey(f.tenant, f.userId, "housecall_pro", {
        fields: { apiKey: "wrong-key-012345" },
      }),
    ).rejects.toThrow(/did not accept/);
    const st = await service.connectWithKey(f.tenant, f.userId, "servicetitan", {
      fields: { tenantId: "123456", clientId: "cid", clientSecret: "secret-x" },
      config: { bookingProviderId: "77" },
    });
    expect(st).toMatchObject({
      provider: "servicetitan",
      account: "123456",
      config: { bookingProviderId: "77" },
    });
    const updated = await service.updateConfig(f.tenant, f.userId, st.id, { campaignId: 5 });
    expect(updated.config).toMatchObject({ bookingProviderId: "77", campaignId: 5 });
    await expect(
      service.updateConfig(f.tenant, f.userId, st.id, { campaignId: "x" }),
    ).rejects.toThrow(/not valid/);
    expect(await service.test(f.tenant, f.userId, st.id)).toEqual({
      ok: true,
      message: "Connected to ServiceTitan tenant 123456.",
    });
    await expect(
      service.connectWithKey(f.tenant, f.userId, "jobber", { fields: {} }),
    ).rejects.toThrow(/signing in/);
    const catalogue = service.catalogue();
    expect(catalogue.map((c) => [c.id, c.oauth])).toEqual([
      ["hubspot", true],
      ["gohighlevel", true],
      ["jobber", false],
      ["housecall_pro", false],
      ["servicetitan", false],
    ]);
    const preview = await service.previewMapping(f.tenant, "housecall_pro", f.leadId);
    expect(preview.fields).toMatchObject({
      first_name: "Pat",
      last_name: "Lee",
      "address.zip": "78704",
    });
  });

  it("refuses another business's connection and delivery", async () => {
    fake = createFakeCrms();
    const a = await fixture();
    const b = await fixture();
    const connectionId = await connectHubSpot(a);
    const service = createIntegrationService(deps());
    await expect(service.test(b.tenant, b.userId, connectionId)).rejects.toThrow(/not found/);
    await expect(service.disconnect(b.tenant, b.userId, connectionId)).rejects.toThrow(/not found/);
    const emitted = await runEvent(
      leadEvent(a, "lead.qualified"),
      INTEGRATION_FUNCTION_IDS.leadQualified,
    );
    const deliveryId = (emitted[0]!.data as { deliveryId: string }).deliveryId;
    expect(await deliverOnce(deps(), b.tenant, deliveryId)).toEqual({ status: "failed" });
    expect(await service.deliveries(b.tenant)).toEqual([]);
  });
});
