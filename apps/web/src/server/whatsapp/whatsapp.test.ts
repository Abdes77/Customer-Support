import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeGraph, type FakeGraph } from "@repo/channel-whatsapp/testing";
import {
  FIXTURE_CUSTOMER_BSUID,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
  INBOUND_FIXTURES,
  inboundMessage,
  signedWhatsAppHttpRequest,
  statusFixture,
  templateStatusFixture,
} from "@repo/channel-whatsapp/testing";
import { ASK_TO_TYPE_NOTE } from "@repo/channel-whatsapp/server";
import {
  type AgencyId,
  type BusinessId,
  type ChannelConnectionId,
  createLogger,
  type TraceId,
  type UserId,
} from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  attachments,
  businesses,
  channelConnections,
  conversations,
  eq,
  messageParts,
  messages,
  messageTemplates,
  segments,
  sql,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, jobEvent, type LocalJobRunner } from "@repo/jobs";
import { sendEventId } from "@repo/pipeline";
import type { AppSettings } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";
import { createWebhookHandler } from "@/server/pipeline/webhook-route";

import { createEmbeddedSignupHandler } from "./routes";

/*
 * WhatsApp end to end, without Meta: recorded-style webhooks signed with the app secret go
 * through the real route, pipeline, jobs, engine (the offline model) and adapter, which talks
 * to a fake Graph API. The live version of this is HUMAN_TODO 29.
 */

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const APP_SECRET = "meta-app-secret-for-tests";
const VERIFY_TOKEN = "verify-token-for-tests";

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;
let graph: FakeGraph;
let tenant: { agencyId: AgencyId; businessId: BusinessId };
let connectionId: ChannelConnectionId;

const handle = () => createWebhookHandler(() => server.pipeline);
const params = { params: Promise.resolve({ channel: "whatsapp" }) };

async function deliver(body: unknown, secret = APP_SECRET): Promise<Response> {
  return handle()(signedWhatsAppHttpRequest(secret, body), params);
}

async function setSettings(values: Partial<AppSettings>) {
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    applySettingChanges(ctx, {
      target: { scope: "business", ...tenant },
      changes: Object.entries(values).map(([key, value]) => ({ key, value: value as never })),
      actor: { type: "system", label: "web whatsapp tests" },
    }),
  );
}

async function messagesOfBusiness() {
  return t.admin
    .select()
    .from(messages)
    .where(eq(messages.businessId, tenant.businessId))
    .orderBy(messages.conversationId, messages.sequence);
}

beforeAll(async () => {
  t = await createTestDatabase();
  graph = createFakeGraph({ accessToken: "EAAG-signup-token" });
  runner = createLocalJobRunner({ logger: quiet, debouncePeriodMs: 50, retryDelayMs: () => 10 });
  const store = new MemoryObjectStore();
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({
      META_APP_ID: "1234567890",
      META_APP_SECRET: APP_SECRET,
      META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      META_WHATSAPP_SIGNUP_CONFIG_ID: "987654321",
    }),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789",
    storage: (owner) => createTenantStorage(store, owner),
    metaFetch: graph.fetch,
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
      name: "Summit Roofing",
      slug: "summit",
      status: "active",
    })
    .returning({ id: businesses.id });
  tenant = { agencyId, businessId: business!.id };
  // The number as Embedded Signup leaves it.
  const [connection] = await t.admin
    .insert(channelConnections)
    .values({
      ...tenant,
      channel: "whatsapp",
      externalAccountId: FIXTURE_PHONE_NUMBER_ID,
      status: "active",
      config: { businessAccountId: FIXTURE_WABA_ID, phoneNumberId: FIXTURE_PHONE_NUMBER_ID },
    })
    .returning({ id: channelConnections.id });
  connectionId = connection!.id;
  await t.db.forBusiness(tenant.businessId).run((ctx) =>
    t.db.secrets.channel.write(ctx, connectionId, {
      accessToken: "EAAG-number-token",
      pin: "123456",
    }),
  );
  await setSettings({ "conversation.reply_wait_seconds.whatsapp": 0 });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

describe("POST /api/webhooks/whatsapp", () => {
  it("answers Meta's subscription handshake", async () => {
    const url = `http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=8462`;
    const response = await handle()(new Request(url), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("8462");
    const wrong = await handle()(new Request(url.replace(VERIFY_TOKEN, "nope")), params);
    expect(wrong.status).toBe(401);
  });

  it("refuses a webhook with a bad signature before anything is stored (I1)", async () => {
    const before = (await messagesOfBusiness()).length;
    const response = await deliver(INBOUND_FIXTURES.text(), "not-the-app-secret");
    expect(response.status).toBe(401);
    expect((await messagesOfBusiness()).length).toBe(before);
  });

  it("round-trips a customer message: stored once, answered by the bot, sent through the Graph API", async () => {
    const body = inboundMessage(
      "text",
      { text: { body: "Hi, my roof is leaking over the kitchen" } },
      { id: "wamid.ROUNDTRIP-1" },
    );
    const response = await deliver(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: 1, emitted: 1 });
    // Meta delivers again: stored once (I2).
    expect(await (await deliver(body)).json()).toMatchObject({ stored: 0, duplicates: 1 });
    await runner.idle();

    const rows = await messagesOfBusiness();
    const inbound = rows.find((row) => row.externalMessageId === "wamid.ROUNDTRIP-1")!;
    const replies = rows.filter(
      (row) => row.conversationId === inbound.conversationId && row.direction === "outbound",
    );
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((row) => row.status === "sent" && row.author === "bot")).toBe(true);

    const sent = graph.sent();
    expect(sent.length).toBe(replies.length);
    expect(sent[0]).toMatchObject({
      messaging_product: "whatsapp",
      recipient: FIXTURE_CUSTOMER_BSUID,
    });
    expect(sent.map((item) => (item["text"] as { body: string } | undefined)?.body ?? "")).toEqual(
      replies.map((row) => row.text),
    );
    // Read receipt with the typing indicator on the customer's message.
    expect(graph.receipts()).toContainEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ROUNDTRIP-1",
      typing_indicator: { type: "text" },
    });
    expect(
      graph.calls
        .filter((call) => call.path.endsWith("/messages"))
        .every((call) => call.token === "EAAG-number-token"),
    ).toBe(true);

    // The delivery status comes back by webhook.
    const reply = replies[0]!;
    const parts = await t.admin
      .select()
      .from(messageParts)
      .where(eq(messageParts.messageId, reply.id));
    expect(parts.map((part) => part.externalMessageId)).toEqual([reply.externalMessageId]);
    const status = await deliver(statusFixture("read", reply.externalMessageId!));
    expect(await status.json()).toMatchObject({ statuses: 1 });
    const [after] = await t.admin.select().from(messages).where(eq(messages.id, reply.id));
    expect(after!.status).toBe("read");
  });

  it("downloads a photo with the number's token and stores it", async () => {
    const body = inboundMessage(
      "image",
      { image: { caption: "the ceiling", mime_type: "image/jpeg", sha256: "x", id: "55501" } },
      { id: "wamid.PHOTO-1", fromUserId: "US.PHOTO-SENDER", from: "16505550001" },
    );
    expect((await deliver(body)).status).toBe(200);
    await runner.idle();
    const [stored] = await t.admin
      .select({ status: attachments.status, path: attachments.storagePath, kind: attachments.kind })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(messages.externalMessageId, "wamid.PHOTO-1"));
    expect(stored).toMatchObject({ status: "stored", kind: "image" });
    expect(stored!.path).toContain(`${tenant.agencyId}/${tenant.businessId}/`);
    const lookup = graph.calls.find((call) => call.path === "/55501")!;
    expect(lookup.url.searchParams.get("phone_number_id")).toBe(FIXTURE_PHONE_NUMBER_ID);
    expect(lookup.token).toBe("EAAG-number-token");
  });

  it("turns a voice message into a note asking the customer to type (the default)", async () => {
    const body = inboundMessage(
      "audio",
      { audio: { mime_type: "audio/ogg; codecs=opus", sha256: "x", id: "55502", voice: true } },
      { id: "wamid.VOICE-1", fromUserId: "US.VOICE-SENDER", from: "16505550002" },
    );
    expect((await deliver(body)).status).toBe(200);
    await runner.idle();
    const [stored] = await t.admin
      .select({ analysis: attachments.analysis, kind: attachments.kind })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(messages.externalMessageId, "wamid.VOICE-1"));
    expect(stored).toEqual({ kind: "audio", analysis: ASK_TO_TYPE_NOTE });
  });

  it("keeps template statuses current from Meta's webhook", async () => {
    await t.admin.insert(messageTemplates).values({
      ...tenant,
      channelConnectionId: connectionId,
      name: "status_check",
      language: "en_US",
      status: "pending",
      components: [{ type: "BODY", text: "Hi {{first_name}}" }],
    });
    const response = await deliver(
      templateStatusFixture("REJECTED", { name: "status_check", reason: "INVALID_FORMAT" }),
    );
    expect(await response.json()).toMatchObject({ ok: true, signals: 1 });
    const [row] = await t.admin
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.name, "status_check"));
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "INVALID_FORMAT" });
  });
});

describe("the 24-hour window and the template fallback (I6)", () => {
  /** A conversation whose customer last wrote `hoursAgo` hours ago, and a queued bot message. */
  async function closedConversation(hoursAgo: number, payload: Record<string, unknown> = {}) {
    const id = `wamid.WINDOW-${randomUUID()}`;
    const sender = `US.${randomUUID()}`;
    await deliver(
      inboundMessage(
        "text",
        { text: { body: "Thanks" } },
        { id, fromUserId: sender, name: "Maria Lopez" },
      ),
    );
    await runner.idle();
    const [inbound] = await t.admin
      .select()
      .from(messages)
      .where(eq(messages.externalMessageId, id));
    const conversationId = inbound!.conversationId;
    await t.admin
      .update(conversations)
      .set({ lastInboundAt: new Date(Date.now() - hoursAgo * 3600 * 1000) })
      .where(eq(conversations.id, conversationId));
    const [counter] = await t.admin
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, conversationId))
      .returning({ sequence: conversations.messageSeq });
    const [queued] = await t.admin
      .insert(messages)
      .values({
        ...tenant,
        conversationId,
        channelConnectionId: connectionId,
        direction: "outbound",
        author: "bot",
        kind: "text",
        text: "Hi Maria, did you still want that roof inspection?",
        payload,
        sequence: counter!.sequence,
        status: "queued",
      })
      .returning({ id: messages.id });
    const sentBefore = graph.sent().length;
    await server.events.send([
      jobEvent("message.send_requested", sendEventId(queued!.id), {
        traceId: randomUUID() as TraceId,
        ...tenant,
        conversationId,
        messageId: queued!.id,
        channel: "whatsapp",
      }),
    ]);
    await runner.idle();
    const [row] = await t.admin.select().from(messages).where(eq(messages.id, queued!.id));
    return { row: row!, sent: graph.sent().slice(sentBefore), sender };
  }

  it("sends nothing free-form after 24 hours when no template is set", async () => {
    await setSettings({ "channels.whatsapp.follow_up_template": null });
    const { row, sent } = await closedConversation(25);
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("window_closed");
    expect(sent).toEqual([]);
  });

  it("sends the approved follow-up template instead, filled from the conversation", async () => {
    await t.admin.insert(messageTemplates).values({
      ...tenant,
      channelConnectionId: connectionId,
      name: "follow_up_check_in",
      language: "en_US",
      status: "approved",
      components: [
        {
          type: "BODY",
          text: "Hi {{first_name}}, this is {{bot_name}} from {{business_name}}. Reply here to continue.",
        },
      ],
    });
    await setSettings({
      "channels.whatsapp.follow_up_template": "follow_up_check_in",
      "persona.bot_name": "Alex",
    });
    const { row, sent, sender } = await closedConversation(26);
    expect(row.status).toBe("sent");
    expect(row.kind).toBe("template");
    expect(row.text).toBe("Hi Maria, this is Alex from Summit Roofing. Reply here to continue.");
    expect(sent).toEqual([
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        recipient: sender,
        type: "template",
        template: {
          name: "follow_up_check_in",
          language: { code: "en_US" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", parameter_name: "first_name", text: "Maria" },
                { type: "text", parameter_name: "bot_name", text: "Alex" },
                { type: "text", parameter_name: "business_name", text: "Summit Roofing" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("still sends free-form inside the window, with buttons only when the setting allows them", async () => {
    await setSettings({ "channels.whatsapp.buttons": true });
    const withButtons = await closedConversation(1, { quickReplies: ["Yes", "No"] });
    expect(withButtons.row.status).toBe("sent");
    expect(withButtons.sent[0]).toMatchObject({
      type: "interactive",
      interactive: { type: "button" },
    });
    await setSettings({ "channels.whatsapp.buttons": false });
    const asText = await closedConversation(1, { quickReplies: ["Yes", "No"] });
    expect(asText.sent[0]).toMatchObject({
      type: "text",
      text: { body: "Hi Maria, did you still want that roof inspection?\n\n• Yes\n• No" },
    });
  });
});

describe("POST /api/oauth/meta/whatsapp (Embedded Signup)", () => {
  async function user(email: string): Promise<UserId> {
    const created = await t.db.localAuth.upsertUser({ email, fullName: email });
    return created.id;
  }

  function post(body: unknown, headers: Record<string, string> = {}) {
    return new Request("http://localhost:3000/api/oauth/meta/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("connects a number for agency staff and refuses everyone else", async () => {
    const adminId = await user(`admin-${randomUUID()}@example.com`);
    graph.phoneNumbers.push({
      id: "200000000000001",
      display_phone_number: "+1 555-020-0001",
      verified_name: "Summit Roofing",
    });
    const body = {
      businessId: tenant.businessId,
      code: "code-from-popup",
      businessAccountId: FIXTURE_WABA_ID,
      phoneNumberId: "200000000000001",
    };
    const asAdmin = createEmbeddedSignupHandler({
      getAccess: async () => ({
        user: { id: adminId, email: null },
        access: {
          userId: adminId,
          agencies: [{ agencyId: tenant.agencyId, role: "agency_admin" }],
          businesses: [],
        },
      }),
      getWhatsApp: () => server.whatsapp,
      directory: t.db.directory,
      logger: quiet,
    });
    const response = await asAdmin(post(body));
    expect(response.status).toBe(200);
    const { connection } = (await response.json()) as { connection: Record<string, unknown> };
    expect(connection).toMatchObject({ status: "active", phoneNumberId: "200000000000001" });
    expect(JSON.stringify(connection)).not.toContain("EAAG");

    const asClient = createEmbeddedSignupHandler({
      getAccess: async () => ({
        user: { id: adminId, email: null },
        access: {
          userId: adminId,
          agencies: [],
          businesses: [
            {
              businessId: tenant.businessId,
              agencyId: tenant.agencyId,
              role: "client_owner",
              enabled: true,
            },
          ],
        },
      }),
      getWhatsApp: () => server.whatsapp,
      directory: t.db.directory,
      logger: quiet,
    });
    expect((await asClient(post(body))).status).toBe(403);

    const anonymous = createEmbeddedSignupHandler({
      getAccess: async () => null,
      getWhatsApp: () => server.whatsapp,
      directory: t.db.directory,
      logger: quiet,
    });
    expect((await anonymous(post(body))).status).toBe(401);
    expect((await asAdmin(post(body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await asAdmin(post(body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await asAdmin(post(body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await asAdmin(post({ ...body, phoneNumberId: "../1" }))).status).toBe(400);
    expect((await asAdmin(post({ ...body, businessId: randomUUID() }))).status).toBe(404);

    const unconfigured = createEmbeddedSignupHandler({
      getAccess: async () => null,
      getWhatsApp: () => null,
      directory: t.db.directory,
    });
    expect((await unconfigured(post(body))).status).toBe(503);
  });
});
