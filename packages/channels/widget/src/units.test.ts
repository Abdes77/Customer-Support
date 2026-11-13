import { describe, expect, it, vi } from "vitest";

import type { BusinessId, ChannelConnectionId, ConversationId, SendTarget } from "@repo/core";

import { createWidgetAdapter } from "./adapter";
import { isOriginAllowed, normalizeOrigin } from "./origins";
import { createRealtimeNotifier, visitorTopic, type WidgetNotifier } from "./realtime";
import { generateWidgetKey, isWidgetKey } from "./server/connection";
import { normalizePhone } from "./server/service";
import { hashIp, signWidgetToken, verifyWidgetToken } from "./token";
import { photoFileName, sniffImage } from "./uploads";

const SECRET = "widget-secret-0123456789-0123456789-abcdef";
const NOW = new Date("2026-11-12T15:00:00.000Z");
const claims = {
  sid: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40",
  cid: "1c2d3e4f-5061-4b72-9c83-ad9e8f7a6b51",
  bid: "2d3e4f50-6172-4c83-ad94-be0f9a8b7c62",
  aid: "3e4f5061-7283-4d94-be05-cf1a0b9c8d73",
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
};

describe("session tokens", () => {
  it("round-trips the claims of a genuine token", () => {
    const token = signWidgetToken(SECRET, claims);
    expect(verifyWidgetToken(SECRET, token, NOW)).toEqual({ v: 1, ...claims });
  });

  it("refuses tampered, foreign, expired and malformed tokens", () => {
    const token = signWidgetToken(SECRET, claims);
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ v: 1, ...claims, bid: "4f506172-8394-4ea5-8f16-d02b1cad9e84" }),
    ).toString("base64url");
    expect(verifyWidgetToken(SECRET, `${forged}.${signature}`, NOW)).toBeNull();
    expect(verifyWidgetToken("another-secret-0123456789-0123456789-xyz", token, NOW)).toBeNull();
    expect(verifyWidgetToken(SECRET, token, new Date(claims.exp * 1000))).toBeNull();
    expect(verifyWidgetToken(SECRET, `${payload}.`, NOW)).toBeNull();
    expect(verifyWidgetToken(SECRET, `${payload}.${signature}.x`, NOW)).toBeNull();
    expect(verifyWidgetToken(SECRET, "not a token", NOW)).toBeNull();
    expect(verifyWidgetToken(SECRET, "a".repeat(3000), NOW)).toBeNull();
  });

  it("needs a long secret", () => {
    expect(() => signWidgetToken("short", claims)).toThrow("at least 32");
    expect(() => createWidgetAdapter({ secret: "short", notifier: { notify: vi.fn() } })).toThrow(
      "at least 32",
    );
  });

  it("hashes addresses with the secret, never storing them", () => {
    const hashed = hashIp(SECRET, "203.0.113.7");
    expect(hashed).not.toContain("203");
    expect(hashed).toHaveLength(32);
    expect(hashIp(SECRET, "203.0.113.7")).toBe(hashed);
    expect(hashIp(SECRET, "203.0.113.8")).not.toBe(hashed);
  });
});

describe("allowed origins", () => {
  it.each([
    ["https://Example.com", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com:443", "https://example.com"],
    ["http://localhost:4173", "http://localhost:4173"],
    ["https://example.com/page", null],
    ["https://user:pw@example.com", null],
    ["ftp://example.com", null],
    ["javascript:alert(1)", null],
    ["null", null],
    ["", null],
    [null, null],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it("matches scheme, host and port exactly", () => {
    const allowed = ["https://example.com", "https://www.example.com/"];
    expect(isOriginAllowed("https://example.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://www.example.com", allowed)).toBe(true);
    expect(isOriginAllowed("http://example.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://shop.example.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://example.com.evil.test", allowed)).toBe(false);
    expect(isOriginAllowed("https://example.com:8443", allowed)).toBe(false);
    expect(isOriginAllowed(null, allowed)).toBe(false);
    expect(isOriginAllowed("https://example.com", [])).toBe(false);
  });
});

describe("photo checks", () => {
  const pad = (head: number[]) => new Uint8Array([...head, ...new Array<number>(16).fill(0)]);
  const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

  it.each([
    ["JPEG", pad([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["PNG", pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["GIF", pad(ascii("GIF89a")), "image/gif"],
    ["WebP", pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]), "image/webp"],
    ["HEIC", pad([0, 0, 0, 24, ...ascii("ftypheic")]), "image/heic"],
    ["HEIF", pad([0, 0, 0, 24, ...ascii("ftypmif1")]), "image/heif"],
  ])("recognizes %s by its bytes", (_label, bytes, mimeType) => {
    expect(sniffImage(bytes)?.mimeType).toBe(mimeType);
  });

  it("refuses anything else, whatever its name", () => {
    expect(sniffImage(pad(ascii("<script>alert(1)</script>")))).toBeNull();
    expect(sniffImage(pad(ascii("%PDF-1.7")))).toBeNull();
    expect(sniffImage(pad([0, 0, 0, 24, ...ascii("ftypmp42")]))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("names the stored file after its real type", () => {
    expect(photoFileName("roof.png", { mimeType: "image/jpeg", extension: "jpg" })).toBe(
      "roof.jpg",
    );
    expect(photoFileName(null, { mimeType: "image/png", extension: "png" })).toBe("photo.png");
    expect(
      photoFileName("C:\\Users\\me\\My Roof (1).HEIC", {
        mimeType: "image/heic",
        extension: "heic",
      }),
    ).toBe("My_Roof_1.heic");
    expect(photoFileName("../../.jpg", { mimeType: "image/jpeg", extension: "jpg" })).toBe(
      "photo.jpg",
    );
  });
});

describe("public keys and phone numbers", () => {
  it("generates well-formed, distinct keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateWidgetKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(isWidgetKey(key)).toBe(true);
    expect(isWidgetKey("wpk_short")).toBe(false);
    expect(isWidgetKey("wpk_AAAAAAAAAAAAAAAAAAAAAAA!")).toBe(false);
  });

  it.each([
    ["(303) 555-0142", "+13035550142"],
    ["303.555.0142", "+13035550142"],
    ["1 303 555 0142", "+13035550142"],
    ["+1 303 555 0142", "+13035550142"],
    ["+44 20 7946 0958", "+442079460958"],
    ["555-0142", null],
    ["+1 303 555", null],
    ["call me", null],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe("adapter", () => {
  const target: SendTarget = {
    connection: {
      connectionId: claims.cid as ChannelConnectionId,
      businessId: claims.bid as BusinessId,
      externalAccountId: "wpk_AAAAAAAAAAAAAAAAAAAAAAAA",
      credentials: null,
      config: {},
    },
    conversationId: "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04" as ConversationId,
    recipientExternalId: "v_visitor",
    externalThreadId: null,
    replyToExternalMessageId: null,
    window: { open: true, closesAt: null },
    email: null,
    idempotencyKey: "msg-1:0",
    sentByHuman: false,
  };

  it("has no webhooks", async () => {
    const adapter = createWidgetAdapter({ secret: SECRET, notifier: { notify: vi.fn() } });
    expect(
      await adapter.verifyWebhook({
        method: "POST",
        url: "https://app.test/api/webhooks/widget",
        headers: {},
        query: {},
        rawBody: "{}",
      }),
    ).toMatchObject({ outcome: "rejected" });
    await expect(
      adapter.parseWebhook({ method: "POST", url: "", headers: {}, query: {}, rawBody: "{}" }),
    ).rejects.toThrow("no webhooks");
  });

  it("pokes the visitor's topic and reports a stable id", async () => {
    const notify = vi.fn<WidgetNotifier["notify"]>(async () => {});
    const adapter = createWidgetAdapter({ secret: SECRET, notifier: { notify }, now: () => NOW });
    const first = await adapter.send({ kind: "text", text: "Hi" }, target);
    const again = await adapter.send({ kind: "text", text: "Hi" }, target);
    expect(first).toEqual({
      ok: true,
      externalMessageId: "widget:msg-1:0",
      sentAt: NOW.toISOString(),
    });
    expect(again).toEqual(first);
    await adapter.sendTyping?.(target, "on");
    const topic = visitorTopic(SECRET, claims.cid, "v_visitor");
    expect(notify.mock.calls).toEqual([
      [topic, "message"],
      [topic, "message"],
      [topic, "typing"],
    ]);
    expect(topic).toMatch(/^widget-[0-9a-f]{40}$/);
    expect(visitorTopic(SECRET, claims.cid, "v_other")).not.toBe(topic);
  });

  it("still succeeds when the poke fails, and refuses kinds it cannot show", async () => {
    const warn = vi.fn();
    const adapter = createWidgetAdapter({
      secret: SECRET,
      notifier: {
        notify: async () => {
          throw new Error("down");
        },
      },
      logger: { warn } as never,
    });
    expect((await adapter.send({ kind: "text", text: "Hi" }, target)).ok).toBe(true);
    expect(warn).toHaveBeenCalledWith("widget.poke_failed", expect.any(Object));
    const template = await adapter.send(
      { kind: "template", templateName: "x", languageCode: "en", variables: [] },
      target,
    );
    expect(template).toMatchObject({ ok: false, error: { retryable: false } });
  });
});

describe("Realtime notifier", () => {
  it("broadcasts a content-free poke with the service key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 202 }));
    const notifier = createRealtimeNotifier({
      url: "https://project.supabase.co/",
      serviceRoleKey: "service-role",
      fetch: fetchMock,
    });
    await notifier.notify("widget-abc", "message");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://project.supabase.co/realtime/v1/api/broadcast");
    expect(init?.headers).toMatchObject({ apikey: "service-role" });
    expect(JSON.parse(init?.body as string)).toEqual({
      messages: [
        { topic: "widget-abc", event: "poke", payload: { kind: "message" }, private: false },
      ],
    });
  });

  it("reports a failed broadcast", async () => {
    const notifier = createRealtimeNotifier({
      url: "https://project.supabase.co",
      serviceRoleKey: "service-role",
      fetch: async () => new Response("no", { status: 503 }),
    });
    await expect(notifier.notify("widget-abc", "typing")).rejects.toThrow("503");
  });
});
