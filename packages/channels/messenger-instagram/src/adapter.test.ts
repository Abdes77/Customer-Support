import { describe, expect, it } from "vitest";

import { createGraphClient } from "@repo/channel-meta";
import {
  type ChannelConnectionContext,
  type ChannelConnectionId,
  type BusinessId,
  type ConversationId,
  ParsedWebhook,
  type SendTarget,
} from "@repo/core";

import { createInstagramAdapter, createMessengerAdapter, messagingTypeFor } from "./adapter";
import { fitText, HUMAN_AGENT_TAG, RESPONSE } from "./send";
import {
  createFakeMetaGraph,
  deliveryFixture,
  echoMessage,
  FIXTURE_APP_ID,
  FIXTURE_IG_ACCOUNT_ID,
  FIXTURE_IGSID,
  FIXTURE_PAGE_ID,
  FIXTURE_PSID,
  FIXTURE_TIME_MS,
  INBOUND_FIXTURES,
  metaEnvelope,
  mid,
  PAGE_INBOX_APP_ID,
  policyFixture,
  readFixture,
  signedMetaRequest,
} from "./testing";

const APP_SECRET = "app-secret-for-tests";
const NOW = new Date("2026-11-12T10:00:05.000Z");

function adapters(graph = createFakeMetaGraph(), appId: string | null = FIXTURE_APP_ID) {
  const options = {
    appSecret: APP_SECRET,
    verifyToken: "verify",
    graph: createGraphClient({ fetch: graph.fetch }),
    appId,
    clock: () => NOW,
    media: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      fileName: "roof.jpg",
    }),
  };
  return {
    graph,
    messenger: createMessengerAdapter(options),
    instagram: createInstagramAdapter(options),
  };
}

async function parse(
  body: unknown,
  channel: "messenger" | "instagram" = "messenger",
  appId?: string | null,
) {
  const { messenger, instagram } = adapters(createFakeMetaGraph(), appId);
  const adapter = channel === "messenger" ? messenger : instagram;
  const request = signedMetaRequest(APP_SECRET, body);
  expect(await adapter.verifyWebhook(request)).toEqual({ outcome: "verified" });
  const parsed = await adapter.parseWebhook(request);
  // Whatever the adapter returns must be what the pipeline accepts.
  expect(ParsedWebhook.safeParse(parsed).success).toBe(true);
  return parsed;
}

describe("webhook verification", () => {
  it("refuses a body signed with another secret or changed after signing (I1)", async () => {
    const { messenger, instagram } = adapters();
    const body = INBOUND_FIXTURES.text();
    const forged = signedMetaRequest("someone-else", body);
    expect((await messenger.verifyWebhook(forged)).outcome).toBe("rejected");
    const tampered = {
      ...signedMetaRequest(APP_SECRET, body),
      rawBody: JSON.stringify(body) + " ",
    };
    expect((await instagram.verifyWebhook(tampered)).outcome).toBe("rejected");
  });

  it("answers the subscription handshake only with the right token", async () => {
    const { messenger } = adapters();
    const handshake = (token: string) => ({
      method: "GET" as const,
      url: "https://app.example.com/api/webhooks/messenger",
      headers: {},
      query: { "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "1158201444" },
      rawBody: "",
    });
    expect(await messenger.verifyWebhook(handshake("verify"))).toMatchObject({
      outcome: "challenge",
      body: "1158201444",
    });
    expect((await messenger.verifyWebhook(handshake("wrong"))).outcome).toBe("rejected");
  });
});

describe("inbound fixtures, every kind", () => {
  it("reads a text message: Page, PSID, time in milliseconds", async () => {
    const parsed = await parse(INBOUND_FIXTURES.text("Hello there"));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toMatchObject({
      channel: "messenger",
      externalAccountId: FIXTURE_PAGE_ID,
      sender: { externalId: FIXTURE_PSID, phone: null },
      kind: "text",
      text: "Hello there",
      sentAt: new Date(FIXTURE_TIME_MS).toISOString(),
    });
  });

  it("reads quick-reply taps and postbacks as interactive replies", async () => {
    const tap = (await parse(INBOUND_FIXTURES.quickReply())).messages[0]!;
    expect(tap).toMatchObject({
      kind: "interactive_reply",
      text: "This week",
      interactiveReply: { id: "qr_1", title: "This week" },
    });
    const postback = (await parse(INBOUND_FIXTURES.postback())).messages[0]!;
    expect(postback).toMatchObject({
      kind: "interactive_reply",
      text: "Get Started",
      interactiveReply: { id: "GET_STARTED", title: "Get Started" },
      metadata: { postback: true },
    });
  });

  it.each(["image", "video", "audio", "file"] as const)(
    "reads a %s as a downloadable attachment",
    async (kind) => {
      const message = (await parse(INBOUND_FIXTURES[kind]())).messages[0]!;
      expect(message.kind).toBe("media");
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({
        kind,
        source: { type: "url" },
      });
    },
  );

  it("turns Messenger's like sticker into a thumbs-up, once, during the sticker transition", async () => {
    const message = (await parse(INBOUND_FIXTURES.likeSticker())).messages[0]!;
    expect(message).toMatchObject({ kind: "text", text: "👍", attachments: [] });
  });

  it("keeps shared links as metadata and the text as the message", async () => {
    const message = (await parse(INBOUND_FIXTURES.share())).messages[0]!;
    expect(message.kind).toBe("text");
    expect(message.metadata["shares"]).toEqual([
      { type: "fallback", url: "https://example.com/roof", title: "Slate roofs" },
    ]);
  });

  it("keeps the message a customer replied to and an ad referral", async () => {
    const reply = (await parse(INBOUND_FIXTURES.inlineReply("m_original"))).messages[0]!;
    expect(reply.replyToExternalMessageId).toBe("m_original");
    const ad = (await parse(INBOUND_FIXTURES.adReferral())).messages[0]!;
    expect(ad.metadata["referral"]).toEqual({
      ref: "spring-roof",
      ad_id: "6045246247433",
      source: "ADS",
      type: "OPEN_THREAD",
      ad_title: "Spring roof check",
    });
  });

  it("reads Instagram story replies and mentions as story replies", async () => {
    const reply = (await parse(INBOUND_FIXTURES.storyReply(), "instagram")).messages[0]!;
    expect(reply).toMatchObject({
      channel: "instagram",
      externalAccountId: FIXTURE_IG_ACCOUNT_ID,
      sender: { externalId: FIXTURE_IGSID },
      kind: "story_reply",
      text: "How much was this one?",
      metadata: { story: { reply: true, id: "17920370216031394" } },
    });
    const mention = (await parse(INBOUND_FIXTURES.storyMention(), "instagram")).messages[0]!;
    expect(mention).toMatchObject({ kind: "story_reply", metadata: { story: { mention: true } } });
    expect(mention.attachments).toHaveLength(1);
  });

  it("stores disappearing and unsupported media as unsupported, skips deleted and notices", async () => {
    const ephemeral = (await parse(INBOUND_FIXTURES.ephemeral(), "instagram")).messages[0]!;
    expect(ephemeral).toMatchObject({ kind: "unsupported", metadata: { ephemeral: true } });
    const unsupported = (await parse(INBOUND_FIXTURES.unsupported(), "instagram")).messages[0]!;
    expect(unsupported.kind).toBe("unsupported");
    expect((await parse(INBOUND_FIXTURES.deleted(), "instagram")).messages).toEqual([]);
    expect((await parse(INBOUND_FIXTURES.adminText())).messages).toEqual([]);
  });

  it("reads reactions and their removal, with a stable id per event", async () => {
    const reaction = (await parse(INBOUND_FIXTURES.reaction("m_bot_1"))).messages[0]!;
    expect(reaction).toMatchObject({
      kind: "reaction",
      reaction: { targetExternalMessageId: "m_bot_1", emoji: "❤️", removed: false },
    });
    const again = (await parse(INBOUND_FIXTURES.reaction("m_bot_1"))).messages[0]!;
    expect(again.externalMessageId).toBe(reaction.externalMessageId);
    const removal = (await parse(INBOUND_FIXTURES.unreaction("m_bot_1"))).messages[0]!;
    expect(removal.reaction).toEqual({
      targetExternalMessageId: "m_bot_1",
      emoji: null,
      removed: true,
    });
    expect(removal.externalMessageId).not.toBe(reaction.externalMessageId);
  });

  it("marks messages that arrive while another app controls the conversation", async () => {
    const parsed = await parse(INBOUND_FIXTURES.text("hello", { standby: true }));
    expect(parsed.messages[0]!.metadata["standby"]).toBe(true);
  });

  it("reads several events of several entries in one delivery", async () => {
    const body = {
      object: "page",
      entry: [
        (INBOUND_FIXTURES.text("one") as { entry: unknown[] }).entry[0],
        (INBOUND_FIXTURES.text("two", { from: "999" }) as { entry: unknown[] }).entry[0],
      ],
    };
    expect((await parse(body)).messages.map((item) => item.text)).toEqual(["one", "two"]);
  });

  it("ignores the other platform's object and refuses what is not a webhook", async () => {
    expect((await parse(INBOUND_FIXTURES.text(), "instagram")).messages).toEqual([]);
    expect((await parse(INBOUND_FIXTURES.storyReply(), "messenger")).messages).toEqual([]);
    const { messenger } = adapters();
    await expect(messenger.parseWebhook(signedMetaRequest(APP_SECRET, "not json"))).rejects.toThrow(
      /not JSON/,
    );
    await expect(
      messenger.parseWebhook(signedMetaRequest(APP_SECRET, { hello: "world" })),
    ).rejects.toThrow(/Messenger Platform/);
  });
});

describe("echoes: our sends versus a person in Meta's inbox", () => {
  it("skips Messenger echoes of our own app", async () => {
    const parsed = await parse(
      echoMessage({ mid: mid(), text: "Hi!", app_id: Number(FIXTURE_APP_ID) }),
    );
    expect(parsed.signals).toEqual([]);
    expect(parsed.messages).toEqual([]);
  });

  it("turns a reply from the Page inbox into a human-agent signal", async () => {
    const id = mid();
    const parsed = await parse(
      echoMessage({ mid: id, text: "Sam here", app_id: PAGE_INBOX_APP_ID }),
    );
    expect(parsed.signals).toEqual([
      {
        type: "human_agent_replied",
        channel: "messenger",
        externalAccountId: FIXTURE_PAGE_ID,
        contactExternalId: FIXTURE_PSID,
        externalMessageId: id,
        text: "Sam here",
        occurredAt: new Date(FIXTURE_TIME_MS).toISOString(),
        attribution: "external",
      },
    ]);
  });

  it("treats another app's id as external, even with our marker", async () => {
    const parsed = await parse(
      echoMessage({ mid: mid(), text: "x", app_id: "555", metadata: "hsrb:spoofed" }),
    );
    expect(parsed.signals[0]).toMatchObject({ attribution: "external" });
  });

  it("leaves an Instagram echo without app id for the pipeline to match", async () => {
    const parsed = await parse(
      echoMessage({ mid: mid(), text: "On my way" }, { channel: "instagram" }),
      "instagram",
    );
    expect(parsed.signals[0]).toMatchObject({
      type: "human_agent_replied",
      channel: "instagram",
      contactExternalId: FIXTURE_IGSID,
      attribution: "unverified",
    });
    // Our marker came back: ours.
    const ours = await parse(
      echoMessage({ mid: mid(), text: "Hi", metadata: "hsrb:msg-1:0" }, { channel: "instagram" }),
      "instagram",
    );
    expect(ours.signals).toEqual([]);
  });

  it("cannot tell our app from another without META_APP_ID, except the Page inbox", async () => {
    const other = await parse(echoMessage({ mid: mid(), app_id: "555" }), "messenger", null);
    expect(other.signals[0]).toMatchObject({ attribution: "unverified" });
    const inbox = await parse(
      echoMessage({ mid: mid(), app_id: PAGE_INBOX_APP_ID }),
      "messenger",
      null,
    );
    expect(inbox.signals[0]).toMatchObject({ attribution: "external" });
  });
});

describe("statuses and account events", () => {
  it("reads deliveries by id and by watermark", async () => {
    const parsed = await parse(deliveryFixture(["m_a", "m_b"], FIXTURE_TIME_MS));
    expect(parsed.statuses.map((item) => [item.externalMessageId, item.status])).toEqual([
      ["m_a", "delivered"],
      ["m_b", "delivered"],
    ]);
    expect(parsed.signals).toEqual([
      expect.objectContaining({
        type: "delivery_watermark",
        contactExternalId: FIXTURE_PSID,
        status: "delivered",
        watermark: new Date(FIXTURE_TIME_MS).toISOString(),
      }),
    ]);
    const noMids = await parse(deliveryFixture(null, FIXTURE_TIME_MS));
    expect(noMids.statuses).toEqual([]);
    expect(noMids.signals).toHaveLength(1);
  });

  it("reads Messenger reads by watermark and Instagram's seen by message id", async () => {
    const messenger = await parse(readFixture({ watermark: FIXTURE_TIME_MS }));
    expect(messenger.signals[0]).toMatchObject({ type: "delivery_watermark", status: "read" });
    const instagram = await parse(
      readFixture({ mid: "aWdf_1" }, { channel: "instagram" }),
      "instagram",
    );
    expect(instagram.statuses).toEqual([
      expect.objectContaining({ externalMessageId: "aWdf_1", status: "read" }),
    ]);
  });

  it("reports policy enforcement on the Page as an account event", async () => {
    const parsed = await parse(policyFixture("block"));
    expect(parsed.signals).toEqual([
      expect.objectContaining({
        type: "provider_event",
        externalAccountId: FIXTURE_PAGE_ID,
        event: "policy_enforcement",
        data: { action: "block", reason: "The bot violated our Platform Policies." },
      }),
    ]);
  });

  it("ignores events without a customer and events it does not know", async () => {
    const parsed = await parse(
      metaEnvelope([
        { recipient: { id: FIXTURE_PAGE_ID }, timestamp: FIXTURE_TIME_MS, optin: { ref: "x" } },
      ]),
    );
    expect(parsed).toEqual({ messages: [], statuses: [], signals: [] });
  });
});

function target(
  overrides: Partial<SendTarget> & { channel?: "messenger" | "instagram" } = {},
): SendTarget {
  const instagram = overrides.channel === "instagram";
  const connection: ChannelConnectionContext = {
    connectionId: "c0000000-0000-4000-8000-000000000001" as ChannelConnectionId,
    businessId: "b0000000-0000-4000-8000-000000000001" as BusinessId,
    externalAccountId: instagram ? FIXTURE_IG_ACCOUNT_ID : FIXTURE_PAGE_ID,
    credentials: { pageAccessToken: "EAAPage-token" },
    config: {
      pageId: FIXTURE_PAGE_ID,
      pageName: "Summit",
      instagramAccountId: instagram ? FIXTURE_IG_ACCOUNT_ID : null,
    },
  };
  return {
    connection,
    conversationId: "d0000000-0000-4000-8000-000000000001" as ConversationId,
    recipientExternalId: instagram ? FIXTURE_IGSID : FIXTURE_PSID,
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: "2026-11-13T09:00:00.000Z" },
    email: null,
    idempotencyKey: "msg-1:0",
    sentByHuman: false,
    ...overrides,
  };
}

describe("sending", () => {
  it("sends the bot's text as a RESPONSE from the Page, with our marker", async () => {
    const { graph, messenger } = adapters();
    const result = await messenger.send(
      { kind: "text", text: "Thanks! When did it start?" },
      target(),
    );
    expect(result).toEqual({ ok: true, externalMessageId: "m_SENT-1", sentAt: NOW.toISOString() });
    const call = graph.calls.at(-1)!;
    expect(call.path).toBe(`/${FIXTURE_PAGE_ID}/messages`);
    expect(call.token).toBe("EAAPage-token");
    expect(call.url.search).toBe("");
    expect(call.json).toEqual({
      recipient: { id: FIXTURE_PSID },
      messaging_type: "RESPONSE",
      message: { text: "Thanks! When did it start?", metadata: "hsrb:msg-1:0" },
    });
  });

  it("dates a send from before its request, so Meta's watermark of it covers it", async () => {
    // Meta stamps the message while our request is open; the watermark that reports it
    // delivered or read is that stamp. A time taken after the answer would be later.
    const graph = createFakeMetaGraph();
    let now = Date.parse("2026-11-12T10:00:00.000Z");
    const requested: number[] = [];
    const messenger = createMessengerAdapter({
      appSecret: APP_SECRET,
      verifyToken: "verify",
      graph: createGraphClient({
        fetch: async (input, init) => {
          requested.push(now);
          now += 1500;
          return graph.fetch(input, init);
        },
      }),
      appId: FIXTURE_APP_ID,
      clock: () => new Date(now),
      media: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "image/jpeg",
        fileName: "a.jpg",
      }),
    });
    const text = await messenger.send({ kind: "text", text: "Hi" }, target());
    expect(text.ok && Date.parse(text.sentAt)).toBe(requested[0]);
    const media = await messenger.send(
      {
        kind: "media",
        mediaKind: "image",
        storage: { bucket: "b", path: "p" },
        mimeType: "image/jpeg",
        caption: null,
      },
      target(),
    );
    // The upload comes first; the attachment message is the second request.
    expect(media.ok && Date.parse(media.sentAt)).toBe(requested[2]);
  });

  it("sends Instagram through the linked Page to the IGSID", async () => {
    const { graph, instagram } = adapters();
    await instagram.send({ kind: "text", text: "Hi" }, target({ channel: "instagram" }));
    const call = graph.calls.at(-1)!;
    expect(call.path).toBe(`/${FIXTURE_PAGE_ID}/messages`);
    expect((call.json as { recipient: unknown }).recipient).toEqual({ id: FIXTURE_IGSID });
  });

  it("offers quick replies as buttons when they fit, as text otherwise", async () => {
    const { graph, messenger } = adapters();
    await messenger.send(
      { kind: "text", text: "When would suit you?", quickReplies: ["This week", "Next week"] },
      target(),
    );
    expect((graph.sent().at(-1)!["message"] as Record<string, unknown>)["quick_replies"]).toEqual([
      { content_type: "text", title: "This week", payload: "qr_1" },
      { content_type: "text", title: "Next week", payload: "qr_2" },
    ]);
    await messenger.send(
      {
        kind: "text",
        text: "Which?",
        quickReplies: ["An option far longer than twenty characters"],
      },
      target(),
    );
    const message = graph.sent().at(-1)!["message"] as Record<string, unknown>;
    expect(message["quick_replies"]).toBeUndefined();
    expect(message["text"]).toBe("Which?\n\n• An option far longer than twenty characters");
  });

  describe("messaging window and the human-agent tag", () => {
    it("tags a person's reply after the standard window with HUMAN_AGENT", async () => {
      const { graph, messenger } = adapters();
      await messenger.send(
        { kind: "text", text: "Sorry for the wait, Sam here" },
        target({ sentByHuman: true, standardWindowOpen: false }),
      );
      expect(graph.sent().at(-1)).toMatchObject({
        messaging_type: "MESSAGE_TAG",
        tag: "HUMAN_AGENT",
      });
    });

    it("sends a person's reply inside the standard window as a plain RESPONSE", async () => {
      const { graph, instagram } = adapters();
      await instagram.send(
        { kind: "text", text: "Sam here" },
        target({ channel: "instagram", sentByHuman: true, standardWindowOpen: true }),
      );
      const body = graph.sent().at(-1)!;
      expect(body["messaging_type"]).toBe("RESPONSE");
      expect(body["tag"]).toBeUndefined();
    });

    it("never tags the bot's messages", async () => {
      const { graph, messenger } = adapters();
      await messenger.send({ kind: "text", text: "Hi" }, target({ standardWindowOpen: false }));
      expect(graph.sent().at(-1)!["tag"]).toBeUndefined();
    });

    it("works the standard window out from the human-agent window when not told", () => {
      const lastInbound = Date.parse("2026-11-10T10:00:00.000Z");
      const human = (now: string) =>
        messagingTypeFor(
          target({
            sentByHuman: true,
            window: { open: true, closesAt: new Date(lastInbound + 168 * 3_600_000).toISOString() },
          }),
          new Date(now),
        );
      expect(human("2026-11-11T09:00:00.000Z")).toEqual(RESPONSE);
      expect(human("2026-11-11T11:00:00.000Z")).toEqual(HUMAN_AGENT_TAG);
    });

    it("reports Meta's window refusal as window_closed, final", async () => {
      const { graph, messenger } = adapters();
      graph.failNext(/\/messages$/, { code: 10, subcode: 2018278 });
      const result = await messenger.send({ kind: "text", text: "Hi" }, target());
      expect(result).toMatchObject({
        ok: false,
        error: { code: "meta_10_2018278", windowClosed: true, retryable: false },
      });
    });
  });

  it("retries rate limits with Meta's wait and fails other errors for good", async () => {
    const { graph, messenger } = adapters();
    graph.failNext(/\/messages$/, { code: 613 });
    expect(await messenger.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { retryable: true, retryAfterSeconds: 300 },
    });
    graph.failNext(/\/messages$/, { code: 551 });
    expect(await messenger.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_551", retryable: false },
    });
    graph.failNext(/\/messages$/, { code: 10, subcode: 2018300 });
    expect(await messenger.send({ kind: "text", text: "Hi" }, target())).toMatchObject({
      ok: false,
      error: { code: "meta_10_2018300", retryable: false, windowClosed: false },
    });
  });

  it("uploads media from our storage, sends it by attachment id, then the caption", async () => {
    const { graph, instagram } = adapters();
    const result = await instagram.send(
      {
        kind: "media",
        mediaKind: "image",
        storage: { bucket: "b", path: "a/b/c/d/roof.jpg" },
        mimeType: "image/jpeg",
        caption: "Here is the roof we did last week",
      },
      target({ channel: "instagram" }),
    );
    expect(result).toMatchObject({ ok: true, externalMessageId: "m_SENT-1" });
    const upload = graph.calls.find((call) => call.path.endsWith("/message_attachments"))!;
    expect(upload.form?.get("platform")).toBe("instagram");
    const [attachment, caption] = graph.sent();
    expect(attachment!["message"]).toEqual({
      attachment: { type: "image", payload: { attachment_id: expect.stringMatching(/^att-/) } },
      metadata: "hsrb:msg-1:0",
    });
    expect((caption!["message"] as { text: string }).text).toBe(
      "Here is the roof we did last week",
    );
  });

  it("refuses templates, emails and connections without a token", async () => {
    const { messenger } = adapters();
    expect(
      await messenger.send(
        { kind: "template", templateName: "x", languageCode: "en_US", variables: [] },
        target(),
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported_message" } });
    const noToken = target();
    expect(
      await messenger.send(
        { kind: "text", text: "Hi" },
        { ...noToken, connection: { ...noToken.connection, credentials: {} } },
      ),
    ).toMatchObject({ ok: false, error: { code: "missing_credentials" } });
  });

  it("shows typing and marks messages seen with sender actions", async () => {
    const { graph, messenger } = adapters();
    await messenger.markRead!(target(), "m_1");
    await messenger.sendTyping!(target(), "on");
    await messenger.sendTyping!(target(), "off");
    expect(graph.actions()).toEqual([
      { recipient: { id: FIXTURE_PSID }, sender_action: "mark_seen" },
      { recipient: { id: FIXTURE_PSID }, sender_action: "typing_on" },
      { recipient: { id: FIXTURE_PSID }, sender_action: "typing_off" },
    ]);
  });

  it("downloads attachments from Meta's CDN without a token, and nothing else", async () => {
    const { graph, messenger } = adapters();
    const connection = target().connection;
    const file = await messenger.fetchAttachment!(connection, {
      type: "url",
      url: "https://scontent.xx.fbcdn.net/v/t1/roof.jpg",
    });
    expect(file.mimeType).toBe("image/jpeg");
    expect(graph.calls.at(-1)!.token).toBeNull();
    await expect(
      messenger.fetchAttachment!(connection, {
        type: "url",
        url: "https://169.254.169.254/latest",
      }),
    ).rejects.toThrow(/Meta's hosts/);
    await expect(
      messenger.fetchAttachment!(connection, { type: "provider_media", mediaId: "1" }),
    ).rejects.toThrow(/link/);
  });
});

describe("text limits", () => {
  it("keeps Instagram text within 1,000 bytes", () => {
    const text = "🙂".repeat(600);
    const fitted = fitText(text, "instagram");
    expect(new TextEncoder().encode(fitted).byteLength).toBeLessThanOrEqual(1000);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitText("plain", "instagram")).toBe("plain");
    expect([...fitText("a".repeat(2500), "messenger")]).toHaveLength(2000);
  });
});
