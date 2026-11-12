import { beforeEach, describe, expect, it } from "vitest";

import {
  type BusinessId,
  type ConnectorContext,
  type ConnectorSyncOptions,
  createLogger,
  type IntegrationConnectionId,
  type IntegrationConnector,
} from "@repo/core";

import { createFakeCrms, type FakeCrms, sampleLeadPayload } from "../testing";
import {
  createGoHighLevelConnector,
  type GoHighLevelConfig,
  type GoHighLevelCredentials,
} from "./gohighlevel";
import { createHousecallProConnector } from "./housecall-pro";
import { createHubSpotConnector, type HubSpotConfig, type HubSpotCredentials } from "./hubspot";
import { createJobberConnector, type JobberConfig, type JobberCredentials } from "./jobber";
import {
  createServiceTitanConnector,
  type ServiceTitanConfig,
  type ServiceTitanCredentials,
} from "./servicetitan";

/*
 * Contract tests: every connector against its vendor's recorded-style answers (the fakes in
 * `testing/fake-crms.ts`). Each checks what the connector sends (method, path, headers, body),
 * what it makes of the answers, and how it reports the vendor's failures.
 */

const quiet = createLogger({ level: "error", sink: () => {} });
const NOW = new Date("2026-11-12T15:00:00Z");
const OPTIONS: ConnectorSyncOptions = {
  leadSource: "AI assistant",
  tags: ["ai-assistant"],
  includeReport: true,
  includeTranscript: false,
  duplicates: "update_existing",
};

let fake: FakeCrms;
beforeEach(() => {
  fake = createFakeCrms();
});

function contextFor<C, K>(
  connector: IntegrationConnector<C, K>,
  credentials: C,
  config: K,
  options: Partial<ConnectorSyncOptions> = {},
): ConnectorContext<C, K> {
  return {
    connectionId: "55555555-5555-4555-8555-555555555555" as IntegrationConnectionId,
    businessId: "33333333-3333-4333-8333-333333333333" as BusinessId,
    credentials,
    config,
    fieldMapping: connector.defaultFieldMapping,
    options: { ...OPTIONS, ...options },
    fetch: fake.fetch as unknown as typeof fetch,
    logger: quiet,
    now: () => NOW,
  };
}

describe("HubSpot", () => {
  const connector = createHubSpotConnector({
    app: { clientId: "hs-client", clientSecret: "hs-secret" },
  });
  const credentials: HubSpotCredentials = {
    kind: "oauth",
    accessToken: "hs-token",
    refreshToken: "hs-refresh",
    expiresAt: "2026-11-12T16:00:00.000Z",
  };
  const config: HubSpotConfig = { hubId: "4242" };

  it("creates a contact from the mapped fields and adds the report as an escaped note", async () => {
    const result = await connector.pushLead(
      contextFor(connector, credentials, config),
      sampleLeadPayload(),
      {
        idempotencyKey: "k1",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalUrl).toBe(
      `https://app.hubspot.com/contacts/4242/record/0-1/${result.value.externalId}`,
    );
    const create = fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)[0]!;
    expect(create.headers["authorization"]).toBe("Bearer hs-token");
    expect(create.body).toEqual({
      properties: {
        email: "pat.lee@example.com",
        firstname: 'Pat "Bobby"',
        lastname: "Lee",
        phone: "+15125550199",
        address: "1200 Elm St, Austin, TX 78704",
        zip: "78704",
      },
    });
    const note = fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/notes$/)[0]!;
    const body = note.body as { properties: Record<string, string>; associations: unknown[] };
    expect(body.properties["hs_note_body"]).toContain("&lt;script&gt;");
    expect(body.properties["hs_note_body"]).not.toContain("<script>");
    expect(body.associations).toEqual([
      {
        to: { id: result.value.externalId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      },
    ]);
    expect(result.value.state).toEqual({ reportNoteId: expect.any(String) });
  });

  it("finds an existing contact by email and updates it instead of creating one", async () => {
    const existing = fake.seedExisting("hubspot", "pat.lee@example.com");
    const result = await connector.pushLead(
      contextFor(connector, credentials, config),
      sampleLeadPayload(),
      {
        idempotencyKey: "k1",
      },
    );
    expect(result).toMatchObject({ ok: true, value: { externalId: existing } });
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/contacts$/)).toHaveLength(0);
    expect(fake.requestsTo("api.hubapi.com", new RegExp(`/contacts/${existing}$`))[0]!.method).toBe(
      "PATCH",
    );
  });

  it("with 'always create' still updates when HubSpot says the email exists (409)", async () => {
    const existing = fake.seedExisting("hubspot", "pat.lee@example.com");
    const result = await connector.pushLead(
      contextFor(connector, credentials, config, { duplicates: "always_create" }),
      sampleLeadPayload(),
      { idempotencyKey: "k1" },
    );
    expect(result).toMatchObject({ ok: true, value: { externalId: existing } });
    expect(fake.requestsTo("api.hubapi.com", /\/search$/)).toHaveLength(0);
  });

  it("updates the contact and replaces the same note on a later update", async () => {
    const ctx = contextFor(connector, credentials, config);
    const first = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k1" });
    if (!first.ok) throw new Error("push failed");
    const second = await connector.updateLead(ctx, first.value.externalId, sampleLeadPayload(), {
      idempotencyKey: "k2",
      record: first.value,
    });
    expect(second).toMatchObject({ ok: true, value: { state: first.value.state } });
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/notes$/)).toHaveLength(1);
    expect(fake.requestsTo("api.hubapi.com", /^\/crm\/v3\/objects\/notes\/\d+$/)[0]!.method).toBe(
      "PATCH",
    );
  });

  it("maps HubSpot's failures to the contract's codes", async () => {
    const ctx = contextFor(connector, credentials, config);
    fake.failNext("api.hubapi.com", /search/, {
      status: 429,
      body: {
        status: "error",
        message: "You have reached your secondly limit.",
        errorType: "RATE_LIMIT",
        policyName: "SECONDLY",
      },
      headers: { "retry-after": "2" },
    });
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryable: true, retryAfterSeconds: 2 },
    });
    fake.failNext("api.hubapi.com", /search/, {
      status: 401,
      body: {
        status: "error",
        message: "Authentication credentials not found.",
        category: "INVALID_AUTHENTICATION",
      },
    });
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "auth_expired", retryable: false },
    });
    fake.failNext(
      "api.hubapi.com",
      /contacts$/,
      {
        status: 400,
        body: {
          status: "error",
          message: "Property values were not valid",
          category: "VALIDATION_ERROR",
        },
      },
      "POST",
    );
    const invalid = await connector.pushLead(
      contextFor(connector, credentials, config, { duplicates: "always_create" }),
      sampleLeadPayload(),
      { idempotencyKey: "k" },
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    fake.failNext("api.hubapi.com", /search/, { status: 502, body: null });
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    fake.setOffline(true);
    expect(await connector.testConnection(ctx)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("tests the connection and refreshes an expiring token", async () => {
    const ctx = contextFor(connector, credentials, config);
    expect(await connector.testConnection(ctx)).toEqual({
      ok: true,
      value: { accountLabel: "HubSpot account 4242" },
    });
    expect(connector.credentialsExpireSoon!(credentials, new Date("2026-11-12T15:59:00Z"))).toBe(
      true,
    );
    expect(connector.credentialsExpireSoon!(credentials, NOW)).toBe(false);
    const refreshed = await connector.refreshCredentials!(ctx);
    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        kind: "oauth",
        refreshToken: "hs-refresh-rotated",
        expiresAt: "2026-11-12T15:30:00.000Z",
      },
    });
    const form = fake.requestsTo("api.hubapi.com", /oauth/)[0]!.body;
    expect(form).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "hs-refresh",
      client_id: "hs-client",
    });
    // A private app token never expires and is never refreshed.
    expect(connector.credentialsExpireSoon!({ kind: "token", accessToken: "pat" }, NOW)).toBe(
      false,
    );
  });
});

describe("GoHighLevel", () => {
  const connector = createGoHighLevelConnector({
    app: { clientId: "ghl-client", clientSecret: "ghl-secret" },
  });
  const credentials: GoHighLevelCredentials = { kind: "token", accessToken: "pit-token" };
  const config: GoHighLevelConfig = {
    locationId: "loc_123",
    pipelineId: "pipe_1",
    pipelineStageId: "stage_1",
  };

  it("upserts the contact with source and tags, adds the note and opens an opportunity once", async () => {
    const ctx = contextFor(connector, credentials, config);
    const result = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const upsert = fake.requestsTo("services.leadconnectorhq.com", /^\/contacts\/upsert$/)[0]!;
    expect(upsert.headers["version"]).toBe("v3");
    expect(upsert.headers["authorization"]).toBe("Bearer pit-token");
    expect(upsert.body).toEqual({
      firstName: 'Pat "Bobby"',
      lastName: "Lee",
      email: "pat.lee@example.com",
      phone: "+15125550199",
      address1: "1200 Elm St, Austin, TX 78704",
      postalCode: "78704",
      source: "AI assistant",
      tags: ["ai-assistant"],
      locationId: "loc_123",
      createNewIfDuplicateAllowed: false,
    });
    expect(fake.requestsTo("services.leadconnectorhq.com", /\/notes$/)).toHaveLength(1);
    const opportunity = fake.requestsTo("services.leadconnectorhq.com", /^\/opportunities\/$/)[0]!;
    expect(opportunity.body).toMatchObject({
      pipelineId: "pipe_1",
      pipelineStageId: "stage_1",
      contactId: result.value.externalId,
      status: "open",
      name: "roof leak repair (Summit Roofing)",
    });
    expect(result.value.externalUrl).toBe(
      `https://app.gohighlevel.com/v2/location/loc_123/contacts/detail/${result.value.externalId}`,
    );

    const updated = await connector.updateLead(ctx, result.value.externalId, sampleLeadPayload(), {
      idempotencyKey: "k2",
      record: result.value,
    });
    expect(updated.ok).toBe(true);
    expect(fake.requestsTo("services.leadconnectorhq.com", /^\/opportunities\/$/)).toHaveLength(1);
    expect(fake.requestsTo("services.leadconnectorhq.com", /\/notes\/note_/)[0]!.method).toBe(
      "PUT",
    );
  });

  it("sends custom fields by key and leaves unknown targets out", async () => {
    const ctx = {
      ...contextFor(connector, credentials, { ...config, pipelineId: null, pipelineStageId: null }),
      fieldMapping: [
        { source: "contact.email", target: "email" },
        { source: "lead.fields.timeline", target: "customField.timeline" },
        { source: "lead.score", target: "customFieldId.Xyz123", transform: "number" as const },
        { source: "lead.fields.job_scope", target: "notAField" },
      ],
    };
    await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k1" });
    const body = fake.requestsTo("services.leadconnectorhq.com", /upsert/)[0]!.body as Record<
      string,
      unknown
    >;
    expect(body["customFields"]).toEqual([
      { key: "timeline", fieldValue: "this_week" },
      { id: "Xyz123", fieldValue: 82 },
    ]);
    expect(body).not.toHaveProperty("notAField");
  });

  it("creates (not upserts) a lead with neither email nor phone, and reports failures", async () => {
    const ctx = contextFor(connector, credentials, {
      ...config,
      pipelineId: null,
      pipelineStageId: null,
    });
    const result = await connector.pushLead(ctx, sampleLeadPayload({ email: null, phone: null }), {
      idempotencyKey: "k",
    });
    expect(result.ok).toBe(true);
    expect(fake.requestsTo("services.leadconnectorhq.com", /^\/contacts\/$/)).toHaveLength(1);
    fake.failNext("services.leadconnectorhq.com", /upsert/, {
      status: 422,
      body: { statusCode: 422, message: ["phone must be a valid phone number"] },
    });
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "validation", retryable: false },
    });
    fake.failNext("services.leadconnectorhq.com", /upsert/, {
      status: 429,
      body: { message: "Too many requests" },
      headers: { "retry-after": "10" },
    });
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryAfterSeconds: 10 },
    });
  });

  it("tests the location and refreshes a single-use refresh token", async () => {
    const oauth: GoHighLevelCredentials = {
      kind: "oauth",
      accessToken: "a",
      refreshToken: "r-1",
      expiresAt: "2026-11-12T15:01:00.000Z",
    };
    const ctx = contextFor(connector, oauth, config);
    expect(await connector.testConnection(ctx)).toEqual({
      ok: true,
      value: { accountLabel: "Summit Roofing" },
    });
    expect(connector.credentialsExpireSoon!(oauth, NOW)).toBe(true);
    const refreshed = await connector.refreshCredentials!(ctx);
    expect(
      refreshed.ok && refreshed.value.kind === "oauth" && refreshed.value.refreshToken,
    ).toMatch(/^ghl-refresh-/);
    expect(fake.requestsTo("services.leadconnectorhq.com", /oauth/)[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r-1",
      user_type: "Location",
    });
    fake.failNext("services.leadconnectorhq.com", /oauth/, {
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(await connector.refreshCredentials!(ctx)).toMatchObject({
      ok: false,
      error: { code: "auth_expired" },
    });
  });
});

describe("Jobber", () => {
  const connector = createJobberConnector({
    app: { clientId: "jb-client", clientSecret: "jb-secret" },
  });
  const credentials: JobberCredentials = {
    kind: "oauth",
    accessToken: "jb-token",
    refreshToken: "jb-refresh",
    expiresAt: "2026-11-12T16:00:00.000Z",
  };
  const config: JobberConfig = { accountName: "Summit Roofing LLC" };

  it("creates a client, a request and a note, with every value as a GraphQL variable", async () => {
    const result = await connector.pushLead(
      contextFor(connector, credentials, config),
      sampleLeadPayload(),
      {
        idempotencyKey: "k1",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = fake.requestsTo("api.getjobber.com", /graphql/);
    for (const call of calls) {
      expect(call.headers["x-jobber-graphql-version"]).toBe("2025-04-16");
      expect(call.headers["authorization"]).toBe("Bearer jb-token");
      // Customer text never becomes part of the query.
      expect((call.body as { query: string }).query).not.toContain("Pat");
      expect((call.body as { query: string }).query).not.toContain("roof leak");
    }
    const create = calls.find((call) =>
      (call.body as { query: string }).query.includes("clientCreate"),
    )!;
    expect((create.body as { variables: unknown }).variables).toEqual({
      input: {
        firstName: 'Pat "Bobby"',
        lastName: "Lee",
        emails: [{ description: "MAIN", primary: true, address: "pat.lee@example.com" }],
        phones: [{ description: "MAIN", primary: true, number: "+15125550199" }],
        billingAddress: { street1: "1200 Elm St, Austin, TX 78704", postalCode: "78704" },
      },
    });
    const request = calls.find((call) =>
      (call.body as { query: string }).query.includes("requestCreate"),
    )!;
    expect(
      (request.body as { variables: { input: Record<string, unknown> } }).variables.input,
    ).toEqual({
      clientId: result.value.state!["clientId"],
      title: "roof leak repair (Summit Roofing)",
    });
    expect(
      calls.some((call) => (call.body as { query: string }).query.includes("clientCreateNote")),
    ).toBe(true);
    expect(result.value.externalUrl).toMatch(/^https:\/\/secure\.getjobber\.com\/requests\//);
  });

  it("reuses a client found by email, edits it on update and adds a note only when the report changed", async () => {
    const existing = fake.seedExisting("jobber", "pat.lee@example.com");
    const ctx = contextFor(connector, credentials, config);
    const first = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k1" });
    if (!first.ok) throw new Error("push failed");
    expect(first.value.state!["clientId"]).toBe(existing);
    const notesBefore = fake.requests.filter((r) => r.rawBody.includes("clientCreateNote")).length;
    await connector.updateLead(ctx, first.value.externalId, sampleLeadPayload(), {
      idempotencyKey: "k2",
      record: first.value,
    });
    expect(fake.requests.filter((r) => r.rawBody.includes("clientCreateNote")).length).toBe(
      notesBefore,
    );
    const changed = sampleLeadPayload();
    const updated = await connector.updateLead(
      ctx,
      first.value.externalId,
      { ...changed, lead: { ...changed.lead, report: { summary: "x", markdown: "A new report" } } },
      { idempotencyKey: "k3", record: first.value },
    );
    expect(updated.ok).toBe(true);
    expect(fake.requests.filter((r) => r.rawBody.includes("clientCreateNote")).length).toBe(
      notesBefore + 1,
    );
    expect(fake.requests.some((r) => r.rawBody.includes("clientEdit"))).toBe(true);
  });

  it("recovering a lost push, adopts the request it made instead of creating another", async () => {
    const ctx = contextFor(connector, credentials, config);
    const payload = sampleLeadPayload();
    const first = await connector.pushLead(ctx, payload, { idempotencyKey: "k1" });
    if (!first.ok) throw new Error("push failed");
    const before = fake.requests.length;
    const known = new Set<string>();
    const recovery = {
      since: new Date(NOW.getTime() - 600_000),
      isKnownRecord: async (id: string) => known.has(id),
    };
    const again = await connector.pushLead(ctx, payload, { idempotencyKey: "k2", recovery });
    expect(again).toMatchObject({ ok: true, value: { externalId: first.value.externalId } });
    const queries = fake.requests
      .slice(before)
      .map((call) => (call.body as { query: string }).query);
    expect(queries.some((query) => query.includes("requestCreate"))).toBe(false);
    const search = fake.requests
      .slice(before)
      .find((call) => (call.body as { query: string }).query.includes("requests(filter"))!;
    expect((search.body as { variables: unknown }).variables).toEqual({
      clientId: first.value.state!["clientId"],
      after: "2026-11-12T14:50:00.000Z",
    });
    // A request stored for another lead is not adopted: a new one is created.
    known.add(first.value.externalId);
    const third = await connector.pushLead(ctx, payload, { idempotencyKey: "k3", recovery });
    expect(third.ok && third.value.externalId).not.toBe(first.value.externalId);
  });

  it("reports userErrors, GraphQL throttling and auth failures", async () => {
    const ctx = contextFor(connector, credentials, config);
    fake.failNext("api.getjobber.com", /graphql/, {
      status: 200,
      body: {
        data: {
          clientCreate: {
            client: null,
            userErrors: [{ message: "Email is invalid", path: ["emails"] }],
          },
        },
      },
    });
    expect(
      await connector.pushLead(
        contextFor(connector, credentials, config, { duplicates: "always_create" }),
        sampleLeadPayload(),
        { idempotencyKey: "k" },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "validation", message: expect.stringContaining("Email is invalid") },
    });
    fake.failNext("api.getjobber.com", /graphql/, {
      status: 200,
      body: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
    });
    expect(await connector.testConnection(ctx)).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryable: true },
    });
    fake.failNext("api.getjobber.com", /graphql/, {
      status: 401,
      body: { message: "Unauthorized" },
    });
    expect(await connector.testConnection(ctx)).toMatchObject({
      ok: false,
      error: { code: "auth_expired" },
    });
    expect(await connector.testConnection(ctx)).toEqual({
      ok: true,
      value: { accountLabel: "Summit Roofing LLC" },
    });
  });
});

describe("Housecall Pro", () => {
  const connector = createHousecallProConnector();
  const credentials = { kind: "api_key" as const, apiKey: "hcp-key-0123456789" };

  it("creates a customer (no notifications) and a lead carrying the report", async () => {
    const result = await connector.pushLead(
      contextFor(connector, credentials, {}),
      sampleLeadPayload(),
      {
        idempotencyKey: "k1",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const customer = fake
      .requestsTo("api.housecallpro.com", /^\/customers$/)
      .find((r) => r.method === "POST")!;
    expect(customer.headers["authorization"]).toBe("Token hcp-key-0123456789");
    expect(customer.body).toEqual({
      first_name: 'Pat "Bobby"',
      last_name: "Lee",
      email: "pat.lee@example.com",
      mobile_number: "+15125550199",
      addresses: [{ street: "1200 Elm St, Austin, TX 78704", zip: "78704" }],
      lead_source: "AI assistant",
      tags: ["ai-assistant"],
      notifications_enabled: false,
    });
    const lead = fake.requestsTo("api.housecallpro.com", /^\/leads$/)[0]!;
    expect(lead.body).toMatchObject({
      customer_id: result.value.state!["customerId"],
      address_id: expect.stringMatching(/^adr_/),
      lead_source: "AI assistant",
      note: expect.stringContaining("Lead report (score 82, hot)"),
    });
    expect(lead.headers["idempotency-key"]).toBe("k1:lead");
  });

  it("recovering a lost push, adopts the open lead it made instead of creating another", async () => {
    const ctx = contextFor(connector, credentials, {}, { duplicates: "always_create" });
    const payload = sampleLeadPayload();
    const first = await connector.pushLead(ctx, payload, { idempotencyKey: "k1" });
    if (!first.ok) throw new Error("push failed");
    const before = fake.requests.length;
    const known = new Set<string>();
    const recovery = {
      since: new Date(NOW.getTime() - 600_000),
      isKnownRecord: async (id: string) => known.has(id),
    };
    const again = await connector.pushLead(ctx, payload, { idempotencyKey: "k2", recovery });
    expect(again).toMatchObject({
      ok: true,
      value: { externalId: first.value.externalId, state: first.value.state },
    });
    const calls = fake.requests.slice(before);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /customers",
      "GET /leads",
    ]);
    expect(calls[1]!.url.searchParams.get("customer_id")).toBe(first.value.state!["customerId"]);
    // A lead stored for another lead of ours is never adopted: a new one is created.
    known.add(first.value.externalId);
    const third = await connector.pushLead(ctx, payload, { idempotencyKey: "k3", recovery });
    expect(third.ok && third.value.externalId).not.toBe(first.value.externalId);
  });

  it("never reuses a customer the loose search found for another email or number", async () => {
    // `q` also matches names and addresses: a "Pat Lee" with other details is someone else.
    fake.failNext(
      "api.housecallpro.com",
      /^\/customers$/,
      {
        status: 200,
        body: {
          customers: [
            { id: "cus_other", email: "pat.lee@example.org", mobile_number: "5125550100" },
          ],
        },
      },
      "GET",
    );
    const result = await connector.pushLead(
      contextFor(connector, credentials, {}),
      sampleLeadPayload(),
      { idempotencyKey: "k1" },
    );
    expect(result.ok && result.value.state).not.toEqual({ customerId: "cus_other" });
    expect(
      fake.requestsTo("api.housecallpro.com", /^\/customers$/).some((r) => r.method === "POST"),
    ).toBe(true);
  });

  it("finds the customer by email, updates it later, and reports a refused key", async () => {
    const existing = fake.seedExisting("housecall_pro", "pat.lee@example.com");
    const ctx = contextFor(connector, credentials, {});
    const first = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k1" });
    if (!first.ok) throw new Error("push failed");
    expect(first.value.state).toEqual({ customerId: existing });
    expect(
      fake.requestsTo("api.housecallpro.com", /^\/customers$/).every((r) => r.method === "GET"),
    ).toBe(true);
    const search = fake.requestsTo("api.housecallpro.com", /^\/customers$/)[0]!;
    expect(search.url.searchParams.get("q")).toBe("pat.lee@example.com");
    const updated = await connector.updateLead(ctx, first.value.externalId, sampleLeadPayload(), {
      idempotencyKey: "k2",
      record: first.value,
    });
    expect(updated.ok).toBe(true);
    expect(
      fake.requestsTo("api.housecallpro.com", new RegExp(`/customers/${existing}$`))[0]!.method,
    ).toBe("PUT");
    fake.failNext("api.housecallpro.com", /company/, {
      status: 401,
      body: { error: { message: "Invalid API key" } },
    });
    expect(await connector.testConnection(ctx)).toMatchObject({
      ok: false,
      error: { code: "auth_expired" },
    });
    expect(await connector.testConnection(ctx)).toEqual({
      ok: true,
      value: { accountLabel: "Summit Roofing" },
    });
  });
});

describe("ServiceTitan", () => {
  const connector = createServiceTitanConnector({
    appKey: "st-app-key",
    environment: "integration",
  });
  const credentials: ServiceTitanCredentials = {
    kind: "client_credentials",
    tenantId: "123456",
    clientId: "cid.abc",
    clientSecret: "cs.secret",
    accessToken: null,
    expiresAt: null,
  };
  const config: ServiceTitanConfig = {
    bookingProviderId: "77",
    campaignId: 12,
    businessUnitId: null,
    jobTypeId: null,
  };

  it("gets a token by client credentials, then creates a booking with our lead reference as externalId", async () => {
    const ctx = contextFor(connector, credentials, config);
    expect(connector.credentialsExpireSoon!(credentials, NOW)).toBe(true);
    const refreshed = await connector.refreshCredentials!(ctx);
    if (!refreshed.ok) throw new Error("token failed");
    expect(refreshed.value).toMatchObject({
      accessToken: expect.stringMatching(/^st-access-/),
      expiresAt: "2026-11-12T15:15:00.000Z",
    });
    expect(fake.requestsTo("auth-integration.servicetitan.io", /connect\/token/)[0]!.body).toEqual({
      grant_type: "client_credentials",
      client_id: "cid.abc",
      client_secret: "cs.secret",
    });
    const result = await connector.pushLead(
      { ...ctx, credentials: refreshed.value },
      sampleLeadPayload(),
      {
        idempotencyKey: "evt-1:conn-1",
      },
    );
    expect(result.ok).toBe(true);
    const create = fake.requestsTo("api-integration.servicetitan.io", /bookings$/)[0]!;
    expect(create.url.pathname).toBe("/crm/v2/tenant/123456/booking-provider/77/bookings");
    expect(create.headers["st-app-key"]).toBe("st-app-key");
    const payload = sampleLeadPayload();
    expect(create.body).toMatchObject({
      source: "AI assistant",
      name: 'Pat "Bobby" Lee',
      externalId: `hsrb-lead-${payload.lead.id}`,
      isFirstTimeClient: true,
      customerType: "Residential",
      campaignId: 12,
      contacts: [
        { type: "Phone", value: "+15125550199", memo: "From the AI assistant" },
        { type: "Email", value: "pat.lee@example.com", memo: "From the AI assistant" },
      ],
    });
    // `Crm.V2.AddressModel` requires street, city, state, zip and country: the default mapping
    // has only the street line and the ZIP, so they travel in the summary instead.
    expect(create.body).not.toHaveProperty("address");
    expect((create.body as { summary: string }).summary).toContain("Lead report");
    expect((create.body as { summary: string }).summary).toContain(
      "Address: 1200 Elm St, Austin, TX 78704, 78704",
    );
    // Only the fields of `Crm.V2.CreateBookingRequest` (additionalProperties: false).
    const allowed = new Set([
      "source",
      "name",
      "address",
      "contacts",
      "customerType",
      "start",
      "summary",
      "campaignId",
      "businessUnitId",
      "jobTypeId",
      "priority",
      "isFirstTimeClient",
      "uploadedImages",
      "isSendConfirmationEmail",
      "externalId",
    ]);
    expect(Object.keys(create.body as object).filter((key) => !allowed.has(key))).toEqual([]);

    if (!result.ok) return;
    const updated = await connector.updateLead(
      { ...ctx, credentials: refreshed.value },
      result.value.externalId,
      sampleLeadPayload(),
      {
        idempotencyKey: "evt-2:conn-1",
        record: result.value,
      },
    );
    expect(updated.ok).toBe(true);
    const patch = fake.requestsTo("api-integration.servicetitan.io", /bookings\/\d+$/)[0]!;
    expect(patch.method).toBe("PATCH");
    expect(patch.body).not.toHaveProperty("externalId");
    // `Crm.V2.UpdateBookingRequest` has no contacts.
    expect(patch.body).not.toHaveProperty("contacts");
  });

  it("sends a complete address, with every field the update requires", async () => {
    const ctx = contextFor(
      connector,
      { ...credentials, accessToken: "t", expiresAt: "2026-11-12T16:00:00.000Z" },
      config,
    );
    const mapped = {
      ...ctx,
      fieldMapping: [
        { source: "contact.name", target: "name" },
        { source: "contact.address", target: "address.street" },
        { source: "lead.fields.city", target: "address.city" },
        { source: "lead.fields.state", target: "address.state" },
        { source: "contact.postalCode", target: "address.zip" },
      ],
    };
    const payload = sampleLeadPayload();
    const withCity = {
      ...payload,
      lead: { ...payload.lead, fields: { ...payload.lead.fields, city: "Austin", state: "TX" } },
    };
    const result = await connector.pushLead(mapped, withCity, { idempotencyKey: "k" });
    if (!result.ok) throw new Error("push failed");
    const create = fake.requestsTo("api-integration.servicetitan.io", /bookings$/).at(-1)!;
    expect((create.body as { address: unknown }).address).toEqual({
      street: "1200 Elm St, Austin, TX 78704",
      city: "Austin",
      state: "TX",
      zip: "78704",
      country: "USA",
    });
    await connector.updateLead(mapped, result.value.externalId, withCity, {
      idempotencyKey: "k2",
      record: result.value,
    });
    const patch = fake.requestsTo("api-integration.servicetitan.io", /bookings\/\d+$/).at(-1)!;
    expect((patch.body as { address: unknown }).address).toEqual({
      street: "1200 Elm St, Austin, TX 78704",
      unit: "",
      city: "Austin",
      state: "TX",
      zip: "78704",
      country: "USA",
    });
  });

  it("recovering a lost push, finds the booking by our reference instead of creating another", async () => {
    const ctx = contextFor(
      connector,
      { ...credentials, accessToken: "t", expiresAt: "2026-11-12T16:00:00.000Z" },
      config,
    );
    const payload = sampleLeadPayload();
    const first = await connector.pushLead(ctx, payload, { idempotencyKey: "k" });
    if (!first.ok) throw new Error("push failed");
    const before = fake.requestsTo("api-integration.servicetitan.io", /bookings$/).length;
    const again = await connector.pushLead(ctx, payload, {
      idempotencyKey: "k-retry",
      recovery: { since: new Date(NOW.getTime() - 600_000), isKnownRecord: async () => false },
    });
    expect(again).toMatchObject({ ok: true, value: { externalId: first.value.externalId } });
    const calls = fake.requestsTo("api-integration.servicetitan.io", /bookings$/).slice(before);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(calls[0]!.url.searchParams.get("externalId")).toBe(`hsrb-lead-${payload.lead.id}`);
  });

  it("refuses to push without a booking provider and reports refused credentials", async () => {
    const ctx = contextFor(
      connector,
      { ...credentials, accessToken: "t", expiresAt: "2026-11-12T16:00:00.000Z" },
      { ...config, bookingProviderId: null },
    );
    expect(
      await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" }),
    ).toMatchObject({
      ok: false,
      error: { code: "validation", retryable: false },
    });
    fake.failNext("auth-integration.servicetitan.io", /token/, {
      status: 400,
      body: { error: "invalid_client" },
    });
    expect(await connector.refreshCredentials!(ctx)).toMatchObject({
      ok: false,
      error: { code: "auth_expired", retryable: false },
    });
    const none = createServiceTitanConnector(null);
    expect(await none.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "k" })).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });
});
