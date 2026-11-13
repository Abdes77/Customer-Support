import { describe, expect, it } from "vitest";

import {
  type BusinessId,
  type ChannelConnectionId,
  type ConversationId,
  ParsedWebhook,
  type SendTarget,
  type WebhookRequest,
} from "@repo/core";

import { createTestChannelAdapter } from "./adapter";
import { MemoryTestTransport } from "./transport";
import {
  buildTestWebhookRequest,
  TEST_SIGNATURE_HEADER,
  TEST_TIMESTAMP_HEADER,
  testAccountIdFor,
  type TestWebhookBody,
} from "./webhook";

const SECRET = "test-channel-secret-0123456789";
const NOW = new Date("2026-11-11T18:30:00.000Z");
const ACCOUNT = testAccountIdFor("9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03");

const body: TestWebhookBody = {
  accountId: ACCOUNT,
  events: [
    {
      type: "message",
      id: "m-1",
      from: { id: "visitor-1", name: "Pat" },
      text: "My roof leaks",
      sentAt: NOW.toISOString(),
    },
  ],
};

function adapter(transport = new MemoryTestTransport(() => NOW)) {
  return createTestChannelAdapter({ secret: SECRET, transport, now: () => NOW });
}

function signed(
  payload: TestWebhookBody = body,
  options: { secret?: string; now?: Date } = {},
): WebhookRequest {
  return buildTestWebhookRequest({
    secret: options.secret ?? SECRET,
    body: payload,
    now: options.now ?? NOW,
  });
}

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh request", async () => {
    expect(await adapter().verifyWebhook(signed())).toEqual({ outcome: "verified" });
  });

  it.each([
    [
      "a wrong secret",
      () => signed(body, { secret: "another-secret-0123456789" }),
      "bad_signature",
    ],
    [
      "a body changed after signing",
      () => ({ ...signed(), rawBody: signed().rawBody.replace("leaks", "leak!") }),
      "bad_signature",
    ],
    [
      "a stale timestamp",
      () => signed(body, { now: new Date(NOW.getTime() - 301_000) }),
      "stale_timestamp",
    ],
    [
      "a timestamp from the future",
      () => signed(body, { now: new Date(NOW.getTime() + 301_000) }),
      "stale_timestamp",
    ],
    [
      "no signature",
      () => {
        const request = signed();
        const headers = { ...request.headers };
        delete headers[TEST_SIGNATURE_HEADER];
        return { ...request, headers };
      },
      "missing_signature",
    ],
    [
      "a malformed timestamp",
      () => {
        const request = signed();
        return { ...request, headers: { ...request.headers, [TEST_TIMESTAMP_HEADER]: "soon" } };
      },
      "bad_timestamp",
    ],
    [
      "a truncated signature",
      () => {
        const request = signed();
        return {
          ...request,
          headers: {
            ...request.headers,
            [TEST_SIGNATURE_HEADER]: request.headers[TEST_SIGNATURE_HEADER]!.slice(0, 20),
          },
        };
      },
      "bad_signature",
    ],
    ["a GET request", () => ({ ...signed(), method: "GET" as const }), "method_not_allowed"],
  ])("rejects %s", async (_label, build, reason) => {
    expect(await adapter().verifyWebhook(build())).toEqual({ outcome: "rejected", reason });
  });
});

describe("parseWebhook", () => {
  it("turns every event type into the normalized shapes", async () => {
    const parsed = await adapter().parseWebhook(
      signed({
        accountId: ACCOUNT,
        events: [
          ...body.events,
          {
            type: "message",
            id: "m-2",
            from: { id: "visitor-1" },
            text: null,
            sentAt: NOW.toISOString(),
            attachments: [
              {
                kind: "image",
                mimeType: "image/jpeg",
                fileName: "roof.jpg",
                sizeBytes: 1234,
                source: { type: "provider_media", mediaId: "media-1" },
              },
            ],
          },
          {
            type: "reaction",
            id: "r-1",
            from: { id: "visitor-1" },
            targetMessageId: "out-1",
            emoji: "👍",
            sentAt: NOW.toISOString(),
          },
          { type: "status", messageId: "out-1", status: "read", occurredAt: NOW.toISOString() },
          {
            type: "human_reply",
            contactId: "visitor-1",
            messageId: "h-1",
            text: "This is Sam from the office",
            occurredAt: NOW.toISOString(),
          },
          { type: "revoked", reason: "uninstalled", occurredAt: NOW.toISOString() },
        ],
      }),
    );

    // The pipeline re-validates with the contract schema; it must pass.
    expect(ParsedWebhook.safeParse(parsed).success).toBe(true);
    expect(parsed.messages.map((message) => [message.externalMessageId, message.kind])).toEqual([
      ["m-1", "text"],
      ["m-2", "media"],
      ["r-1", "reaction"],
    ]);
    expect(parsed.messages[0]).toMatchObject({
      channel: "test",
      externalAccountId: ACCOUNT,
      sender: { externalId: "visitor-1", displayName: "Pat", phone: null, email: null },
      text: "My roof leaks",
    });
    expect(parsed.messages[2]?.reaction).toEqual({
      targetExternalMessageId: "out-1",
      emoji: "👍",
      removed: false,
    });
    expect(parsed.statuses).toEqual([
      expect.objectContaining({ externalMessageId: "out-1", status: "read", error: null }),
    ]);
    expect(parsed.signals.map((signal) => signal.type)).toEqual([
      "human_agent_replied",
      "connection_revoked",
    ]);
  });

  it("refuses a body that is not JSON or does not match the schema", async () => {
    await expect(adapter().parseWebhook({ ...signed(), rawBody: "{nope" })).rejects.toThrow(
      "not JSON",
    );
    await expect(
      adapter().parseWebhook({ ...signed(), rawBody: JSON.stringify({ accountId: ACCOUNT }) }),
    ).rejects.toThrow("does not match");
  });
});

describe("send", () => {
  const target: SendTarget = {
    connection: {
      connectionId: "1c3e5a7b-9d1f-4b3d-a5f7-6a8c0e2f4b06" as ChannelConnectionId,
      businessId: "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03" as BusinessId,
      externalAccountId: ACCOUNT,
      credentials: null,
      config: {},
    },
    conversationId: "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04" as ConversationId,
    recipientExternalId: "visitor-1",
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: null },
    email: null,
    idempotencyKey: "out-1:0",
    sentByHuman: false,
  };

  it("delivers once per idempotency key and reports injected failures", async () => {
    const transport = new MemoryTestTransport(() => NOW);
    const channel = adapter(transport);
    const first = await channel.send({ kind: "text", text: "Hello" }, target);
    const again = await channel.send({ kind: "text", text: "Hello" }, target);
    expect(first.ok && again.ok && first.externalMessageId === again.externalMessageId).toBe(true);
    expect(transport.textsFor(target.conversationId)).toEqual(["Hello"]);

    transport.failNext(1, { code: "window", retryable: false, windowClosed: true });
    const failed = await channel.send(
      { kind: "text", text: "Late" },
      { ...target, idempotencyKey: "out-2:0" },
    );
    expect(failed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "window", retryable: false, windowClosed: true }),
    });
  });

  it("records typing and read signals and serves provider media", async () => {
    const transport = new MemoryTestTransport(() => NOW);
    const channel = adapter(transport);
    await channel.sendTyping?.(target, "on");
    await channel.markRead?.(target, "m-1");
    expect(transport.signals.map((signal) => signal.type)).toEqual(["typing_on", "read"]);

    transport.media.set("media-1", { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    const media = await channel.fetchAttachment?.(target.connection, {
      type: "provider_media",
      mediaId: "media-1",
    });
    expect(media?.mimeType).toBe("image/png");
    await expect(
      channel.fetchAttachment?.(target.connection, { type: "url", url: "https://example.com/a" }),
    ).rejects.toThrow("cannot download");
  });

  it("refuses a short secret", () => {
    expect(() => createTestChannelAdapter({ secret: "short" })).toThrow("at least 16");
  });
});
