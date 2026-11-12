import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGraphClient } from "@repo/channel-meta";
import { type ChannelConnectionId, createLogger, type MessageId } from "@repo/core";
import {
  type BusinessTenant,
  businesses,
  channelConnections,
  channelConnectionSecrets,
  contacts,
  conversations,
  eq,
  messageTemplates,
  segments,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { settingsWith } from "@repo/settings";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { WhatsAppCredentials } from "../credentials";
import { createFakeGraph, type FakeGraph } from "../testing/fake-graph";
import { FIXTURE_PHONE_NUMBER_ID, FIXTURE_WABA_ID, INBOUND_FIXTURES } from "../testing/fixtures";
import { parseWhatsAppWebhook } from "../webhook";
import { createConnectionService } from "./connections";
import { createWhatsAppEventHandler } from "./events";
import { createWhatsAppWindowFallback } from "./fallback";
import {
  ASK_TO_TYPE_NOTE,
  createDeepgramTranscriber,
  createVoiceMessageEnricher,
  type Transcriber,
} from "./voice";

const quiet = createLogger({ level: "error", sink: () => {} });
const APP = { appId: "1234567890", appSecret: "app-secret" };

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.dispose();
});

async function newBusiness(): Promise<BusinessTenant> {
  const suffix = randomUUID().slice(0, 8);
  const { id: agencyId } = await t.db.platform.createAgency({
    name: `Agency ${suffix}`,
    slug: `agency-${suffix}`,
  });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Summit Roofing",
      slug: `summit-${suffix}`,
      status: "active",
      phone: "(612) 555-0142",
    })
    .returning({ id: businesses.id });
  return { agencyId, businessId: business!.id };
}

async function setSettings(tenant: BusinessTenant, values: Partial<AppSettings>) {
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "whatsapp tests" },
    }),
  );
}

function servicesFor(graph: FakeGraph) {
  const deps = {
    db: t.db,
    graph: createGraphClient({ fetch: graph.fetch }),
    logger: quiet,
    app: APP,
    signupConfigId: "cfg-1",
  };
  return { connections: createConnectionService(deps), events: createWhatsAppEventHandler(deps) };
}

/** A unique phone number id per test, registered in the fake WABA. */
function numberIn(graph: FakeGraph): string {
  const id = String(100_000_000_000_000 + Math.floor(Math.random() * 1e12));
  graph.phoneNumbers.push({
    id,
    display_phone_number: "+1 555-010-0000",
    verified_name: "Summit Roofing",
  });
  return id;
}

async function connectionRow(id: string) {
  const [row] = await t.admin
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, id as ChannelConnectionId));
  return row!;
}

async function credentialsOf(tenant: BusinessTenant, id: string) {
  return t.db
    .forBusiness(tenant.businessId)
    .run((ctx) => t.db.secrets.channel.read(ctx, id as ChannelConnectionId, WhatsAppCredentials));
}

describe("Embedded Signup", () => {
  it("exchanges the code, checks the number, subscribes, registers and stores the connection", async () => {
    const graph = createFakeGraph({ accessToken: "EAAG-business-token" });
    graph.templates.push({
      id: "777",
      name: "follow_up_check_in",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Hi {{first_name}}, still interested?" }],
    });
    const { connections } = servicesFor(graph);
    const tenant = await newBusiness();
    expect(connections.signupConfig()).toEqual({
      appId: APP.appId,
      configId: "cfg-1",
      graphApiVersion: "v27.0",
    });
    const view = await connections.completeEmbeddedSignup(tenant, null, {
      code: "signup-code",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    });
    expect(view).toMatchObject({
      status: "active",
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
      businessAccountId: FIXTURE_WABA_ID,
      displayPhoneNumber: "+1 555-078-3881",
      verifiedName: "Summit Roofing",
      qualityRating: "GREEN",
      lastError: null,
      templates: { approved: 1, pending: 0, other: 0 },
    });
    expect(graph.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /oauth/access_token",
      `GET /${FIXTURE_WABA_ID}/phone_numbers`,
      `POST /${FIXTURE_WABA_ID}/subscribed_apps`,
      `POST /${FIXTURE_PHONE_NUMBER_ID}/register`,
      `GET /${FIXTURE_WABA_ID}/message_templates`,
    ]);
    expect(graph.calls[0]!.url.searchParams.get("code")).toBe("signup-code");
    expect(graph.calls.slice(1).every((call) => call.token === "EAAG-business-token")).toBe(true);
    const pin = (graph.calls[3]!.json as { pin: string }).pin;
    expect(pin).toMatch(/^\d{6}$/);

    const row = await connectionRow(view.connectionId);
    expect(row.businessId).toBe(tenant.businessId);
    expect(JSON.stringify(row)).not.toContain("EAAG-business-token");
    expect(await credentialsOf(tenant, view.connectionId)).toEqual({
      accessToken: "EAAG-business-token",
      pin,
    });
    const [secret] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, view.connectionId));
    expect(secret!.ciphertext).not.toContain("EAAG");

    // Reconnecting keeps the PIN a registered number already has.
    const again = await connections.completeEmbeddedSignup(tenant, null, {
      code: "second-code",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
    });
    expect(again.connectionId).toBe(view.connectionId);
    const registers = graph.calls.filter((call) => call.path.endsWith("/register"));
    expect((registers[1]!.json as { pin: string }).pin).toBe(pin);

    // Another business cannot take the number: refused before any call to Meta.
    const intruder = await newBusiness();
    const before = graph.calls.length;
    await expect(
      connections.completeEmbeddedSignup(intruder, null, {
        code: "x",
        businessAccountId: FIXTURE_WABA_ID,
        phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(graph.calls.length).toBe(before);
  });

  it("refuses a number that is not in the account, and stores nothing", async () => {
    const graph = createFakeGraph();
    const { connections } = servicesFor(graph);
    const tenant = await newBusiness();
    await expect(
      connections.completeEmbeddedSignup(tenant, null, {
        code: "c",
        businessAccountId: FIXTURE_WABA_ID,
        phoneNumberId: "999999999999999",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await connections.list(tenant)).toEqual([]);
    await expect(
      connections.completeEmbeddedSignup(tenant, null, {
        code: "c",
        businessAccountId: "../evil",
        phoneNumberId: "1",
      }),
    ).rejects.toThrow();
  });

  it("keeps a number whose registration failed, marked with the error", async () => {
    const graph = createFakeGraph();
    const phone = numberIn(graph);
    graph.failNext(/register$/, { code: 133005, details: "Two step verification PIN mismatch" });
    const { connections } = servicesFor(graph);
    const tenant = await newBusiness();
    const view = await connections.completeEmbeddedSignup(tenant, null, {
      code: "c",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: phone,
    });
    expect(view.status).toBe("error");
    expect(view.lastError).toContain("Registering the number failed");
  });

  it("disconnects: no more messages, and the token is gone", async () => {
    const graph = createFakeGraph();
    const phone = numberIn(graph);
    const { connections } = servicesFor(graph);
    const tenant = await newBusiness();
    const view = await connections.completeEmbeddedSignup(tenant, null, {
      code: "c",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: phone,
    });
    await connections.disconnect(tenant, view.connectionId);
    expect((await connectionRow(view.connectionId)).status).toBe("disabled");
    expect(await credentialsOf(tenant, view.connectionId)).toBeNull();
    const other = await newBusiness();
    await expect(connections.disconnect(other, view.connectionId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("templates", () => {
  it("creates templates with named parameters from the fixed list, and syncs them", async () => {
    const graph = createFakeGraph();
    const phone = numberIn(graph);
    const { connections, events } = servicesFor(graph);
    const tenant = await newBusiness();
    const { connectionId } = await connections.completeEmbeddedSignup(tenant, null, {
      code: "c",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: phone,
    });

    await expect(
      connections.templates.create(tenant, {
        connectionId,
        name: "bad_variables",
        category: "utility",
        body: "Hi {{first_name}}, your code is {{otp}}",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      connections.templates.create(tenant, {
        connectionId,
        name: "Not Allowed",
        category: "utility",
        body: "Hi",
      }),
    ).rejects.toThrow();

    const created = await connections.templates.create(tenant, {
      connectionId,
      name: "nudge_one",
      category: "utility",
      purpose: "follow_up",
      body: "Hi {{first_name}}, it's {{bot_name}} from {{business_name}}. Still need help?",
    });
    expect(created).toMatchObject({
      name: "nudge_one",
      language: "en_US",
      status: "pending",
      purpose: "follow_up",
      variables: ["first_name", "bot_name", "business_name"],
      usableAsFallback: true,
    });
    const post = graph.calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/message_templates"),
    )!;
    expect(post.json).toEqual({
      name: "nudge_one",
      language: "en_US",
      category: "utility",
      parameter_format: "named",
      components: [
        {
          type: "BODY",
          text: "Hi {{first_name}}, it's {{bot_name}} from {{business_name}}. Still need help?",
          example: {
            body_text_named_params: [
              { param_name: "first_name", example: "Maria" },
              { param_name: "bot_name", example: "Alex" },
              { param_name: "business_name", example: "Summit Roofing" },
            ],
          },
        },
      ],
    });
    await expect(
      connections.templates.create(tenant, {
        connectionId,
        name: "nudge_one",
        category: "utility",
        body: "Again",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Meta approves it: the webhook names the account, the handler finds the connection.
    const parsed = parseWhatsAppWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: FIXTURE_WABA_ID,
            changes: [
              {
                field: "message_template_status_update",
                value: {
                  event: "APPROVED",
                  message_template_id: Number(created.id === "" ? 0 : 1),
                  message_template_name: "nudge_one",
                  message_template_language: "en-US",
                  reason: "NONE",
                },
              },
            ],
          },
        ],
      }),
      new Date(),
    );
    const signal = parsed.signals[0]!;
    expect(signal.type).toBe("provider_event");
    if (signal.type !== "provider_event") return;
    expect(await events.handle(signal)).toBe(true);
    expect((await connections.templates.list(tenant, connectionId))[0]?.status).toBe("approved");

    // A template deleted in WhatsApp Manager is disabled at the next sync.
    graph.templates.splice(0, graph.templates.length);
    await connections.templates.sync(tenant, connectionId);
    expect((await connections.templates.list(tenant, connectionId))[0]?.status).toBe("disabled");

    await connections.templates.remove(tenant, connectionId, "nudge_one");
    expect(await connections.templates.list(tenant, connectionId)).toEqual([]);
  });
});

describe("account events", () => {
  it("revokes every number of an account the business removed the app from, and records quality", async () => {
    const graph = createFakeGraph();
    const phone = numberIn(graph);
    const { connections, events } = servicesFor(graph);
    const tenant = await newBusiness();
    const { connectionId } = await connections.completeEmbeddedSignup(tenant, null, {
      code: "c",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: phone,
    });
    const quality = await events.handle({
      type: "provider_event",
      channel: "whatsapp",
      externalAccountId: FIXTURE_WABA_ID,
      event: "phone_quality",
      data: { event: "FLAGGED", currentLimit: "TIER_1K" },
      occurredAt: new Date().toISOString(),
    });
    expect(quality).toBe(true);
    expect((await connectionRow(connectionId)).state).toMatchObject({
      qualityEvent: "FLAGGED",
      messagingLimit: "TIER_1K",
    });
    // A quality update for another number of the same account (maybe another business's)
    // leaves this one alone; its own number, in Meta's digits-only form, applies.
    expect(
      await events.handle({
        type: "provider_event",
        channel: "whatsapp",
        externalAccountId: FIXTURE_WABA_ID,
        event: "phone_quality",
        data: { event: "DOWNGRADE", displayPhoneNumber: "15550109999" },
        occurredAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect((await connectionRow(connectionId)).state).toMatchObject({ qualityEvent: "FLAGGED" });
    await events.handle({
      type: "provider_event",
      channel: "whatsapp",
      externalAccountId: FIXTURE_WABA_ID,
      event: "phone_quality",
      data: { event: "UPGRADE", displayPhoneNumber: "15550100000" },
      occurredAt: new Date().toISOString(),
    });
    expect((await connectionRow(connectionId)).state).toMatchObject({ qualityEvent: "UPGRADE" });
    expect(
      await events.handle({
        type: "provider_event",
        channel: "whatsapp",
        externalAccountId: "000",
        event: "account_update",
        data: { event: "PARTNER_REMOVED" },
        occurredAt: new Date().toISOString(),
      }),
    ).toBe(false);
    // A removal from before the number was connected (redelivered late) changes nothing.
    await events.handle({
      type: "provider_event",
      channel: "whatsapp",
      externalAccountId: FIXTURE_WABA_ID,
      event: "account_update",
      data: { event: "PARTNER_REMOVED" },
      occurredAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    });
    expect((await connectionRow(connectionId)).status).toBe("active");
    // A ban that is only scheduled, or lifted, leaves the number connected.
    for (const banState of ["SCHEDULE_FOR_DISABLE", "REINSTATE"]) {
      await events.handle({
        type: "provider_event",
        channel: "whatsapp",
        externalAccountId: FIXTURE_WABA_ID,
        event: "account_update",
        data: { event: "DISABLED_UPDATE", banState },
        occurredAt: new Date().toISOString(),
      });
      expect((await connectionRow(connectionId)).status).toBe("active");
    }
    await events.handle({
      type: "provider_event",
      channel: "whatsapp",
      externalAccountId: FIXTURE_WABA_ID,
      event: "account_update",
      data: { event: "PARTNER_REMOVED" },
      occurredAt: new Date().toISOString(),
    });
    const row = await connectionRow(connectionId);
    expect(row.status).toBe("revoked");
    expect(row.lastError).toContain("PARTNER_REMOVED");
  });
});

describe("window fallback", () => {
  async function setup(templateStatus: "approved" | "pending" = "approved", body?: string) {
    const tenant = await newBusiness();
    const [connection] = await t.admin
      .insert(channelConnections)
      .values({
        ...tenant,
        channel: "whatsapp",
        externalAccountId: `wa-${randomUUID()}`,
        status: "active",
        config: { businessAccountId: FIXTURE_WABA_ID, phoneNumberId: "1" },
      })
      .returning({ id: channelConnections.id });
    const [contact] = await t.admin
      .insert(contacts)
      .values({ ...tenant, displayName: "Maria Lopez" })
      .returning({ id: contacts.id });
    const [conversation] = await t.admin
      .insert(conversations)
      .values({
        ...tenant,
        contactId: contact!.id,
        channelConnectionId: connection!.id,
        channel: "whatsapp",
      })
      .returning({ id: conversations.id });
    for (const [name, text] of [
      [
        "follow_up_check_in",
        body ?? "Hi {{first_name}}, it's {{bot_name}} from {{business_name}}. Still interested?",
      ],
      [
        "team_reply_ready",
        "Hi {{contact_name}}, {{business_name}} has replied. Call {{business_phone}}.",
      ],
    ] as const) {
      await t.admin.insert(messageTemplates).values({
        ...tenant,
        channelConnectionId: connection!.id,
        name,
        language: "en_US",
        status: templateStatus,
        components: [{ type: "BODY", text }],
      });
    }
    const request = (author: "bot" | "human_agent") => ({
      ...tenant,
      connectionId: connection!.id,
      conversationId: conversation!.id,
      messageId: randomUUID() as MessageId,
      author,
    });
    return { tenant, request };
  }

  const fallback = () => createWhatsAppWindowFallback({ db: t.db, logger: quiet });

  it("has nothing to offer until the business names a template", async () => {
    const { request } = await setup();
    expect(await fallback().resolve(request("bot"))).toEqual({
      kind: "none",
      reason: "no_template_configured",
    });
  });

  it("fills the follow-up template from the conversation", async () => {
    const { tenant, request } = await setup();
    await setSettings(tenant, {
      "channels.whatsapp.follow_up_template": "follow_up_check_in",
      "persona.bot_name": "Sam",
    });
    expect(await fallback().resolve(request("bot"))).toEqual({
      kind: "template",
      message: {
        kind: "template",
        templateName: "follow_up_check_in",
        languageCode: "en_US",
        variables: [],
        namedVariables: { first_name: "Maria", bot_name: "Sam", business_name: "Summit Roofing" },
      },
      renderedText: "Hi Maria, it's Sam from Summit Roofing. Still interested?",
    });
  });

  it("uses the staff template for a person's reply", async () => {
    const { tenant, request } = await setup();
    await setSettings(tenant, { "channels.whatsapp.staff_reply_template": "team_reply_ready" });
    const result = await fallback().resolve(request("human_agent"));
    expect(result).toMatchObject({
      kind: "template",
      renderedText: "Hi Maria Lopez, Summit Roofing has replied. Call (612) 555-0142.",
    });
    expect(await fallback().resolve(request("bot"))).toMatchObject({ kind: "none" });
  });

  it("refuses a template that is not approved, missing, or has parameters it cannot fill", async () => {
    const pending = await setup("pending");
    await setSettings(pending.tenant, {
      "channels.whatsapp.follow_up_template": "follow_up_check_in",
    });
    expect(await fallback().resolve(pending.request("bot"))).toEqual({
      kind: "none",
      reason: "template_pending",
    });
    const missing = await setup();
    await setSettings(missing.tenant, {
      "channels.whatsapp.follow_up_template": "no_such_template",
    });
    expect(await fallback().resolve(missing.request("bot"))).toEqual({
      kind: "none",
      reason: "template_not_found",
    });
    const positional = await setup("approved", "Hi {{1}}, still interested?");
    await setSettings(positional.tenant, {
      "channels.whatsapp.follow_up_template": "follow_up_check_in",
    });
    expect(await fallback().resolve(positional.request("bot"))).toEqual({
      kind: "none",
      reason: "template_parameters_unknown",
    });
  });
});

describe("voice messages", () => {
  const settings = (mode: "ask_to_type" | "transcribe") =>
    settingsWith({ "channels.whatsapp.voice_messages": mode });
  const logger = { warn: () => undefined };
  const audio = new Uint8Array([1, 2, 3]);

  it("asks the customer to type by default, or without a transcriber", async () => {
    const enricher = createVoiceMessageEnricher({ transcriber: null });
    expect(
      await enricher.enrich({
        mimeType: "audio/ogg",
        bytes: audio,
        settings: settings("transcribe"),
        logger,
      }),
    ).toBe(ASK_TO_TYPE_NOTE);
    const transcriber: Transcriber = { name: "fake", transcribe: async () => "It leaks" };
    expect(
      await createVoiceMessageEnricher({ transcriber }).enrich({
        mimeType: "audio/ogg",
        bytes: audio,
        settings: settings("ask_to_type"),
        logger,
      }),
    ).toBe(ASK_TO_TYPE_NOTE);
  });

  it("transcribes when the business wants it, and falls back when that fails", async () => {
    const transcriber: Transcriber = {
      name: "fake",
      transcribe: async () => "The ceiling is  dripping\nnear the chimney.",
    };
    expect(
      await createVoiceMessageEnricher({ transcriber }).enrich({
        mimeType: "audio/ogg",
        bytes: audio,
        settings: settings("transcribe"),
        logger,
      }),
    ).toBe("Voice message, transcribed: The ceiling is dripping near the chimney.");
    const broken: Transcriber = {
      name: "broken",
      transcribe: () => Promise.reject(new Error("down")),
    };
    expect(
      await createVoiceMessageEnricher({ transcriber: broken }).enrich({
        mimeType: "audio/ogg",
        bytes: audio,
        settings: settings("transcribe"),
        logger,
      }),
    ).toBe(ASK_TO_TYPE_NOTE);
    expect(
      await createVoiceMessageEnricher({ transcriber }).enrich({
        mimeType: "audio/ogg",
        bytes: null,
        settings: settings("transcribe"),
        logger,
      }),
    ).toBe(ASK_TO_TYPE_NOTE);
  });

  it("reads Deepgram's answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const transcriber = createDeepgramTranscriber({
      apiKey: "dg-key",
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        return Response.json({
          metadata: { request_id: "r1" },
          results: {
            channels: [
              { alternatives: [{ transcript: "Hi, my AC stopped working.", confidence: 0.98 }] },
            ],
          },
        });
      },
    });
    expect(await transcriber.transcribe({ bytes: audio, mimeType: "audio/ogg; codecs=opus" })).toBe(
      "Hi, my AC stopped working.",
    );
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Token dg-key");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("audio/ogg");
    const failing = createDeepgramTranscriber({
      apiKey: "k",
      fetch: async () => new Response("no", { status: 401 }),
    });
    await expect(failing.transcribe({ bytes: audio, mimeType: "audio/ogg" })).rejects.toThrow(
      /401/,
    );
  });

  it("matches the fixture's voice note", () => {
    const message = parseWhatsAppWebhook(JSON.stringify(INBOUND_FIXTURES.audio()), new Date())
      .messages[0]!;
    expect(message.attachments[0]?.kind).toBe("audio");
  });
});
