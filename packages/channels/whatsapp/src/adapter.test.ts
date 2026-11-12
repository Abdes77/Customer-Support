import { describe, expect, it } from "vitest";

import {
  type ChannelConnectionContext,
  type ChannelConnectionId,
  type BusinessId,
  type ConversationId,
  ParsedWebhook,
  type SendTarget,
} from "@repo/core";
import { createGraphClient } from "@repo/channel-meta";

import { createWhatsAppAdapter } from "./adapter";
import { recipientOf, textBody } from "./send";
import { createFakeGraph, type FakeGraph } from "./testing/fake-graph";
import {
  accountUpdateFixture,
  echoFixture,
  FIXTURE_CUSTOMER_BSUID,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
  INBOUND_FIXTURES,
  qualityFixture,
  signedWhatsAppRequest,
  statusFixture,
  templateStatusFixture,
} from "./testing/fixtures";

const APP_SECRET = "whatsapp-app-secret";
const VERIFY_TOKEN = "verify-me";
const NOW = new Date("2026-11-12T15:00:00.000Z");

function adapterWith(graph: FakeGraph, media = true) {
  return createWhatsAppAdapter({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    graph: createGraphClient({ fetch: graph.fetch }),
    clock: () => NOW,
    ...(media
      ? {
          media: async () => ({
            bytes: new Uint8Array([0xff, 0xd8, 0xff]),
            mimeType: "image/jpeg",
            fileName: "photo.jpg",
          }),
        }
      : {}),
  });
}

const connection: ChannelConnectionContext = {
  connectionId: "11111111-1111-4111-8111-111111111111" as ChannelConnectionId,
  businessId: "22222222-2222-4222-8222-222222222222" as BusinessId,
  externalAccountId: FIXTURE_PHONE_NUMBER_ID,
  credentials: { accessToken: "EAAG-token", pin: "123456" },
  config: { businessAccountId: FIXTURE_WABA_ID },
};

function target(overrides: Partial<SendTarget> = {}): SendTarget {
  return {
    connection,
    conversationId: "33333333-3333-4333-8333-333333333333" as ConversationId,
    recipientExternalId: FIXTURE_CUSTOMER_BSUID,
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: "2026-11-13T15:00:00.000Z" },
    email: null,
    idempotencyKey: "msg-1:0",
    sentByHuman: false,
    ...overrides,
  };
}

async function parse(body: unknown) {
  const adapter = adapterWith(createFakeGraph());
  const request = signedWhatsAppRequest(APP_SECRET, body);
  expect((await adapter.verifyWebhook(request)).outcome).toBe("verified");
  const parsed = await adapter.parseWebhook(request);
  // Every result must satisfy the pipeline's contract.
  expect(ParsedWebhook.safeParse(parsed).success).toBe(true);
  return parsed;
}

describe("webhook verification (I1)", () => {
  it("verifies Meta's signature and refuses a forged one", async () => {
    const adapter = adapterWith(createFakeGraph());
    const body = INBOUND_FIXTURES.text();
    expect((await adapter.verifyWebhook(signedWhatsAppRequest(APP_SECRET, body))).outcome).toBe(
      "verified",
    );
    expect((await adapter.verifyWebhook(signedWhatsAppRequest("someone-else", body))).outcome).toBe(
      "rejected",
    );
  });

  it("answers the subscription handshake", async () => {
    const adapter = adapterWith(createFakeGraph());
    const verification = await adapter.verifyWebhook({
      method: "GET",
      url: "https://app.example.com/api/webhooks/whatsapp",
      headers: {},
      query: { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "42" },
      rawBody: "",
    });
    expect(verification).toMatchObject({ outcome: "challenge", body: "42" });
  });
});

describe("inbound fixtures, every type", () => {
  it("text", async () => {
    const { messages } = await parse(INBOUND_FIXTURES.text());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: "whatsapp",
      externalAccountId: FIXTURE_PHONE_NUMBER_ID,
      kind: "text",
      text: "Hi, my roof is leaking over the kitchen",
      sender: {
        externalId: FIXTURE_CUSTOMER_BSUID,
        displayName: "Sheena Nelson",
        phone: "+16505551234",
        email: null,
      },
      sentAt: new Date(1794496000 * 1000).toISOString(),
      externalThreadId: null,
    });
  });

  it("image, video, document, sticker and audio become attachments fetched by media id", async () => {
    const image = (await parse(INBOUND_FIXTURES.image())).messages[0]!;
    expect(image).toMatchObject({
      kind: "media",
      text: "Here is the ceiling",
      attachments: [
        {
          kind: "image",
          mimeType: "image/jpeg",
          source: { type: "provider_media", mediaId: "1003383421387256" },
        },
      ],
    });
    const video = (await parse(INBOUND_FIXTURES.video())).messages[0]!;
    expect(video.attachments[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
    expect(video.text).toBeNull();
    const document = (await parse(INBOUND_FIXTURES.document())).messages[0]!;
    expect(document.attachments[0]).toMatchObject({ kind: "file", fileName: "quote.pdf" });
    expect(document.text).toBe("The old quote");
    const sticker = (await parse(INBOUND_FIXTURES.sticker())).messages[0]!;
    expect(sticker.attachments[0]).toMatchObject({ kind: "image", mimeType: "image/webp" });
    expect(sticker.metadata).toMatchObject({ sticker: true });
    const audio = (await parse(INBOUND_FIXTURES.audio())).messages[0]!;
    expect(audio.attachments[0]).toMatchObject({
      kind: "audio",
      mimeType: "audio/ogg",
      source: { type: "provider_media", mediaId: "1066587198580138" },
    });
    expect(audio.metadata).toMatchObject({ voice: true });
  });

  it("location", async () => {
    const message = (await parse(INBOUND_FIXTURES.location())).messages[0]!;
    expect(message).toMatchObject({
      kind: "location",
      location: {
        latitude: 44.97776,
        longitude: -93.26501,
        name: "Home",
        address: "100 Main St, Minneapolis, MN 55401",
      },
    });
  });

  it("button and list replies, and template quick-reply buttons", async () => {
    const button = (await parse(INBOUND_FIXTURES.buttonReply())).messages[0]!;
    expect(button).toMatchObject({
      kind: "interactive_reply",
      text: "This week",
      interactiveReply: { id: "qr_2", title: "This week" },
      replyToExternalMessageId: "wamid.BOT-QUESTION",
    });
    const list = (await parse(INBOUND_FIXTURES.listReply())).messages[0]!;
    expect(list).toMatchObject({
      kind: "interactive_reply",
      interactiveReply: { id: "qr_4", title: "Tue 9:00" },
    });
    const template = (await parse(INBOUND_FIXTURES.templateButton())).messages[0]!;
    expect(template).toMatchObject({
      kind: "interactive_reply",
      text: "Yes, still interested",
      interactiveReply: { id: "Yes, still interested", title: "Yes, still interested" },
    });
  });

  it("reactions, added and removed", async () => {
    const added = (await parse(INBOUND_FIXTURES.reaction())).messages[0]!;
    expect(added).toMatchObject({
      kind: "reaction",
      reaction: { targetExternalMessageId: "wamid.BOT-REPLY", emoji: "👍", removed: false },
    });
    const removed = (await parse(INBOUND_FIXTURES.reactionRemoved())).messages[0]!;
    expect(removed.reaction).toEqual({
      targetExternalMessageId: "wamid.BOT-REPLY",
      emoji: null,
      removed: true,
    });
  });

  it("contact cards become text, unknown types are kept as unsupported", async () => {
    const contacts = (await parse(INBOUND_FIXTURES.contacts())).messages[0]!;
    expect(contacts).toMatchObject({
      kind: "text",
      text: "Shared a contact: Mark Nelson: +1 (650) 555-9876",
    });
    const unsupported = (await parse(INBOUND_FIXTURES.unsupported())).messages[0]!;
    expect(unsupported).toMatchObject({
      kind: "unsupported",
      text: null,
      metadata: { type: "unsupported", errorCode: 131051 },
    });
  });

  it("identifies a customer by BSUID, and by phone in payloads without one", async () => {
    const hidden = (await parse(INBOUND_FIXTURES.usernameOnly())).messages[0]!;
    expect(hidden.sender).toEqual({
      externalId: FIXTURE_CUSTOMER_BSUID,
      displayName: "Sheena Nelson",
      phone: null,
      email: null,
    });
    const older = (await parse(INBOUND_FIXTURES.phoneOnly())).messages[0]!;
    expect(older.sender.externalId).toBe("16505551234");
    expect(older.sender.phone).toBe("+16505551234");
  });

  it("skips system notices", async () => {
    expect((await parse(INBOUND_FIXTURES.system())).messages).toEqual([]);
  });

  it("reads several messages and statuses of one delivery", async () => {
    const first = INBOUND_FIXTURES.text() as {
      entry: { changes: { value: { messages: unknown[] } }[] }[];
    };
    const second = INBOUND_FIXTURES.image() as typeof first;
    first.entry[0]!.changes[0]!.value.messages.push(
      ...second.entry[0]!.changes[0]!.value.messages.map((item) => ({
        ...(item as object),
        id: "wamid.SECOND",
      })),
    );
    const parsed = await parse(first);
    expect(parsed.messages.map((message) => message.kind)).toEqual(["text", "media"]);
  });

  it("refuses what is not a WhatsApp webhook, ignores other objects", async () => {
    const adapter = adapterWith(createFakeGraph());
    await expect(
      adapter.parseWebhook(signedWhatsAppRequest(APP_SECRET, "not json")),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      adapter.parseWebhook(signedWhatsAppRequest(APP_SECRET, { hello: "world" })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await parse({ object: "page", entry: [] })).toEqual({
      messages: [],
      statuses: [],
      signals: [],
    });
  });
});

describe("statuses and signals", () => {
  it("maps sent, delivered, read and failed", async () => {
    for (const status of ["sent", "delivered", "read"] as const) {
      const parsed = await parse(statusFixture(status, "wamid.OUT-1"));
      expect(parsed.statuses).toEqual([
        {
          channel: "whatsapp",
          externalAccountId: FIXTURE_PHONE_NUMBER_ID,
          externalMessageId: "wamid.OUT-1",
          status,
          occurredAt: new Date(1794496000 * 1000).toISOString(),
          error: null,
        },
      ]);
    }
    const failed = await parse(statusFixture("failed", "wamid.OUT-2"));
    expect(failed.statuses[0]).toMatchObject({
      status: "failed",
      error: { code: "meta_131026", message: "Message could not be delivered to the recipient." },
    });
  });

  it("turns a reply from the WhatsApp Business app into a human-agent signal", async () => {
    const parsed = await parse(echoFixture("I'll call you in 5 minutes"));
    expect(parsed.signals).toEqual([
      {
        type: "human_agent_replied",
        channel: "whatsapp",
        externalAccountId: FIXTURE_PHONE_NUMBER_ID,
        contactExternalId: "16505551234",
        externalMessageId: "wamid.ECHO-1",
        text: "I'll call you in 5 minutes",
        occurredAt: new Date(1794496000 * 1000).toISOString(),
      },
    ]);
  });

  it("passes template, account and quality updates on as provider events of the WABA", async () => {
    const template = await parse(templateStatusFixture("APPROVED"));
    expect(template.signals).toEqual([
      expect.objectContaining({
        type: "provider_event",
        externalAccountId: FIXTURE_WABA_ID,
        event: "template_status",
        data: {
          templateId: "806312974732579",
          name: "follow_up_check_in",
          language: "en_US",
          status: "APPROVED",
          reason: "NONE",
          category: "UTILITY",
        },
      }),
    ]);
    const removed = await parse(accountUpdateFixture("PARTNER_REMOVED"));
    expect(removed.signals[0]).toMatchObject({
      event: "account_update",
      data: { event: "PARTNER_REMOVED" },
    });
    // Meta's example of DISABLED_UPDATE: the account was reinstated.
    const reinstated = await parse(
      accountUpdateFixture("DISABLED_UPDATE", undefined, {
        ban_info: { waba_ban_state: "REINSTATE", waba_ban_date: "April 17, 2025" },
      }),
    );
    expect(reinstated.signals[0]).toMatchObject({
      event: "account_update",
      data: { event: "DISABLED_UPDATE", banState: "REINSTATE" },
    });
    const quality = await parse(qualityFixture("FLAGGED"));
    expect(quality.signals[0]).toMatchObject({
      event: "phone_quality",
      data: { event: "FLAGGED" },
    });
  });
});

describe("sending", () => {
  it("sends text to a BSUID or a phone number, without link previews", async () => {
    const graph = createFakeGraph();
    const adapter = adapterWith(graph);
    const result = await adapter.send({ kind: "text", text: "Thanks! What's your ZIP?" }, target());
    expect(result).toEqual({
      ok: true,
      externalMessageId: "wamid.SENT-1",
      sentAt: NOW.toISOString(),
    });
    expect(graph.calls[0]!.path).toBe(`/${FIXTURE_PHONE_NUMBER_ID}/messages`);
    expect(graph.calls[0]!.token).toBe("EAAG-token");
    expect(graph.sent()[0]).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      recipient: FIXTURE_CUSTOMER_BSUID,
      type: "text",
      text: { body: "Thanks! What's your ZIP?", preview_url: false },
    });
    await adapter.send(
      { kind: "text", text: "Hi" },
      target({ recipientExternalId: "16505551234" }),
    );
    expect(graph.sent()[1]).toMatchObject({ to: "+16505551234" });
    expect(graph.sent()[1]).not.toHaveProperty("recipient");
  });

  it("offers up to three short options as reply buttons", async () => {
    const graph = createFakeGraph();
    await adapterWith(graph).send(
      {
        kind: "text",
        text: "When would you like us out?",
        quickReplies: ["This week", "Next week", "Not sure"],
      },
      target(),
    );
    expect(graph.sent()[0]).toMatchObject({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "When would you like us out?" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "qr_1", title: "This week" } },
            { type: "reply", reply: { id: "qr_2", title: "Next week" } },
            { type: "reply", reply: { id: "qr_3", title: "Not sure" } },
          ],
        },
      },
    });
  });

  it("uses a list for more options or longer titles, and text when nothing fits", () => {
    const recipient = recipientOf(FIXTURE_CUSTOMER_BSUID);
    const list = textBody(
      {
        kind: "text",
        text: "Which time works?",
        quickReplies: ["Tue 9:00", "Tue 13:00", "Wed 9:00", "Thursday morning between 8 and 10"],
      },
      recipient,
      null,
    );
    expect(list).toMatchObject({
      type: "interactive",
      interactive: {
        type: "list",
        action: {
          button: "Choose",
          sections: [
            {
              rows: [
                { id: "qr_1", title: "Tue 9:00" },
                { id: "qr_2", title: "Tue 13:00" },
                { id: "qr_3", title: "Wed 9:00" },
                {
                  id: "qr_4",
                  title: "Thursday morning betwee…",
                  description: "Thursday morning between 8 and 10",
                },
              ],
            },
          ],
        },
      },
    });
    const tooMany = textBody(
      {
        kind: "text",
        text: "Pick",
        quickReplies: Array.from({ length: 11 }, (_, i) => `Option ${i}`),
      },
      recipient,
      null,
    );
    expect(tooMany).toMatchObject({ type: "text" });
    expect((tooMany["text"] as { body: string }).body).toContain("• Option 10");
    const duplicate = textBody(
      { kind: "text", text: "Pick", quickReplies: ["Yes", "Yes"] },
      recipient,
      null,
    );
    expect(duplicate).toMatchObject({ type: "interactive", interactive: { type: "list" } });
  });

  it("uploads media from storage and sends it by id", async () => {
    const graph = createFakeGraph();
    const result = await adapterWith(graph).send(
      {
        kind: "media",
        mediaKind: "image",
        storage: { bucket: "attachments", path: "a/b/c/d/photo.jpg" },
        mimeType: "image/jpeg",
        caption: "Our crew's last job",
      },
      target(),
    );
    expect(result.ok).toBe(true);
    expect(graph.calls[0]!.path).toBe(`/${FIXTURE_PHONE_NUMBER_ID}/media`);
    const mediaId = (graph.calls[0]!.form!.get("file") as File).name;
    expect(mediaId).toBe("photo.jpg");
    expect(graph.sent()[0]).toMatchObject({
      type: "image",
      image: { id: "media-1", caption: "Our crew's last job" },
    });
    const without = await adapterWith(createFakeGraph(), false).send(
      {
        kind: "media",
        mediaKind: "image",
        storage: { bucket: "b", path: "p" },
        mimeType: "image/jpeg",
        caption: null,
      },
      target(),
    );
    expect(without).toMatchObject({
      ok: false,
      error: { code: "media_unavailable", retryable: false },
    });
  });

  it("sends templates with named or positional parameters", async () => {
    const graph = createFakeGraph();
    const adapter = adapterWith(graph);
    await adapter.send(
      {
        kind: "template",
        templateName: "follow_up_check_in",
        languageCode: "en_US",
        variables: [],
        namedVariables: { first_name: "Sheena", business_name: "Summit Roofing" },
      },
      target({ window: { open: false, closesAt: "2026-11-10T00:00:00.000Z" } }),
    );
    expect(graph.sent()[0]).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      recipient: FIXTURE_CUSTOMER_BSUID,
      type: "template",
      template: {
        name: "follow_up_check_in",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", parameter_name: "first_name", text: "Sheena" },
              { type: "text", parameter_name: "business_name", text: "Summit Roofing" },
            ],
          },
        ],
      },
    });
    await adapter.send(
      { kind: "template", templateName: "hello_world", languageCode: "en_US", variables: [] },
      target(),
    );
    expect(graph.sent()[1]).toMatchObject({
      template: { name: "hello_world", language: { code: "en_US" } },
    });
    expect((graph.sent()[1]!["template"] as Record<string, unknown>)["components"]).toBeUndefined();
    await adapter.send(
      { kind: "template", templateName: "legacy", languageCode: "en_US", variables: ["A", "B"] },
      target(),
    );
    expect(graph.sent()[2]).toMatchObject({
      template: {
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "A" },
              { type: "text", text: "B" },
            ],
          },
        ],
      },
    });
  });

  it("reports Meta's refusals as the pipeline expects", async () => {
    const graph = createFakeGraph();
    const adapter = adapterWith(graph);
    graph.failNext(/messages$/, { code: 131047, details: "More than 24 hours have passed" });
    expect(await adapter.send({ kind: "text", text: "Hi" }, target())).toEqual({
      ok: false,
      error: {
        code: "meta_131047",
        message: "(#131047) Test failure: More than 24 hours have passed",
        retryable: false,
        retryAfterSeconds: null,
        windowClosed: true,
      },
    });
    graph.failNext(/messages$/, { code: 130429 });
    expect(await adapter.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_130429", retryable: true, retryAfterSeconds: 5, windowClosed: false },
    });
    graph.failNext(/messages$/, { code: 131056 });
    expect(await adapter.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_131056", retryable: true, retryAfterSeconds: 30 },
    });
    graph.failNext(/messages$/, { code: 190, status: 401 });
    expect(await adapter.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_190", retryable: false },
    });
    graph.failNext(/messages$/, { code: 131000, status: 500 });
    expect(await adapter.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_131000", retryable: true },
    });
    expect(
      await adapter.send({ kind: "email", subject: "s", text: "t", html: "<p>t</p>" }, target()),
    ).toMatchObject({ ok: false, error: { code: "unsupported_message" } });
    expect(
      await adapter.send(
        { kind: "text", text: "Hi" },
        target({ connection: { ...connection, credentials: null } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "missing_credentials", retryable: false } });
  });

  it("marks messages read and shows typing on the newest customer message", async () => {
    const graph = createFakeGraph();
    const adapter = adapterWith(graph);
    await adapter.markRead!(target(), "wamid.IN-1");
    await adapter.sendTyping!(target({ replyToExternalMessageId: "wamid.IN-1" }), "on");
    await adapter.sendTyping!(target({ replyToExternalMessageId: "wamid.IN-1" }), "off");
    await adapter.sendTyping!(target(), "on");
    expect(graph.receipts()).toEqual([
      { messaging_product: "whatsapp", status: "read", message_id: "wamid.IN-1" },
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.IN-1",
        typing_indicator: { type: "text" },
      },
    ]);
  });

  it("downloads an inbound attachment by media id with the number's token", async () => {
    const graph = createFakeGraph({ mediaBytes: new Uint8Array([7, 8, 9]) });
    const file = await adapterWith(graph).fetchAttachment!(connection, {
      type: "provider_media",
      mediaId: "1003383421387256",
    });
    expect([...file.bytes]).toEqual([7, 8, 9]);
    expect(file.mimeType).toBe("image/jpeg");
    expect(graph.calls[0]!.url.searchParams.get("phone_number_id")).toBe(FIXTURE_PHONE_NUMBER_ID);
    expect(graph.calls.every((call) => call.token === "EAAG-token")).toBe(true);
    graph.failNext(/^\/\d+$/, { code: 100, details: "Media expired" });
    await expect(
      adapterWith(graph).fetchAttachment!(connection, { type: "provider_media", mediaId: "1" }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
