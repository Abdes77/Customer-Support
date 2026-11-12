import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BusinessId,
  ChannelConnectionId,
  ContactId,
  ConversationId,
  ParsedWebhook,
  WidgetSession,
} from "@repo/core";
import {
  businesses,
  channelConnections,
  contactIdentities,
  contacts,
  conversations,
  eq,
  messages,
  segments,
  takeoverLocks,
  widgetSessions,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { type SettingChange } from "@repo/settings";
import { applySettingChanges } from "@repo/settings/server";

import {
  createWidgetService,
  ensureWidgetConnection,
  rotateWidgetKey,
  setWidgetEnabled,
  type WidgetRequestInfo,
  type WidgetService,
  widgetEmbedInfo,
} from "./server-entry";
import { signWidgetToken, verifyWidgetToken } from "./token";

const SECRET = "widget-secret-0123456789-0123456789-abcdef";
const SITE = "https://www.summit-roofing.test";
const OTHER_SITE = "https://evil.test";
const request: WidgetRequestInfo = { origin: SITE, ip: "203.0.113.7", userAgent: "vitest" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(60).fill(7)]);
const system = { type: "system", label: "widget tests" } as const;

let t: TestDatabase;
let store: MemoryObjectStore;
let ingested: ParsedWebhook[];
let now: Date;
let service: WidgetService;
let tenant: { agencyId: string; businessId: BusinessId };
let other: { agencyId: string; businessId: BusinessId };
let key: string;
let otherKey: string;

async function setSettings(target: typeof tenant, changes: SettingChange[]): Promise<void> {
  await t.db.forBusiness(target.businessId).run(async (ctx) => {
    await applySettingChanges(ctx, {
      target: { scope: "business", agencyId: ctx.tenant.agencyId, businessId: target.businessId },
      changes,
      actor: system,
    });
  });
}

async function newBusiness(slug: string, agencyId: string) {
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId: agencyId as never, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId: agencyId as never,
      segmentId: segment!.id,
      name: slug === "summit" ? "Summit Roofing Co." : "Other Co",
      slug,
      status: "active",
      timezone: "America/Denver",
    })
    .returning({ id: businesses.id });
  return { agencyId, businessId: business!.id };
}

beforeAll(async () => {
  t = await createTestDatabase();
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const { id: otherAgency } = await t.db.platform.createAgency({ name: "Other", slug: "other" });
  tenant = await newBusiness("summit", agencyId);
  other = await newBusiness("other", otherAgency);
  key = (
    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => ensureWidgetConnection(ctx, { actor: system }))
  ).publicKey;
  otherKey = (
    await t.db
      .forBusiness(other.businessId)
      .run((ctx) => ensureWidgetConnection(ctx, { actor: system }))
  ).publicKey;
  await setSettings(tenant, [
    { key: "channels.widget.allowed_origins", value: [SITE] },
    { key: "channels.widget.title", value: "Chat with {{business_name}}" },
    { key: "limits.widget_messages_per_minute", value: 5 },
    { key: "limits.widget_sessions_per_ip_per_hour", value: 3 },
    { key: "channels.widget.max_upload_mb", value: 1 },
    // Open every day, so the closed notice below depends only on the clock.
    {
      key: "hours.weekly",
      value: {
        monday: [{ open: "08:00", close: "17:00" }],
        tuesday: [{ open: "08:00", close: "17:00" }],
        wednesday: [{ open: "08:00", close: "17:00" }],
        thursday: [{ open: "08:00", close: "17:00" }],
        friday: [{ open: "08:00", close: "17:00" }],
        saturday: [{ open: "08:00", close: "17:00" }],
        sunday: [{ open: "08:00", close: "17:00" }],
      },
    },
    { key: "hours.us_federal_holidays", value: false },
  ]);
  await setSettings(other, [{ key: "channels.widget.allowed_origins", value: [OTHER_SITE] }]);
});

afterAll(async () => {
  await t?.dispose();
});

beforeEach(() => {
  store = new MemoryObjectStore("attachments");
  ingested = [];
  // 10:00 in Denver on a Thursday: open.
  now = new Date("2026-11-12T17:00:00.000Z");
  service = createWidgetService({
    db: t.db,
    ingest: async (parsed) => {
      ingested.push(parsed);
    },
    storage: (scope) => createTenantStorage(store, scope),
    secret: SECRET,
    realtime: null,
    clock: () => now,
  });
});

async function session(
  info: WidgetRequestInfo = request,
  token: string | null = null,
): Promise<WidgetSession> {
  const result = await service.startSession({ key, token }, info);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

describe("config", () => {
  it("serves the business's appearance to an allowed site", async () => {
    const result = await service.config(key, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      key,
      businessName: "Summit Roofing Co.",
      appearance: { title: "Chat with Summit Roofing Co.", primaryColor: "#1d4ed8" },
      // The name ends in a period: no "Co.." in the greeting.
      greeting: "Hi! Thanks for stopping by Summit Roofing Co. What can we help you with today?",
      photos: { enabled: true, maxBytes: 1024 * 1024 },
      hours: { open: true, notice: null },
    });
    // Nothing secret or staff-only in it.
    expect(JSON.stringify(result.value)).not.toMatch(/business_?id|agency|secret|token/i);
  });

  it("shows when the office is closed", async () => {
    now = new Date("2026-11-13T05:00:00.000Z"); // 22:00 in Denver
    const result = await service.config(key, request);
    expect(result.ok && result.value.hours).toEqual({
      open: false,
      notice:
        "Our office is closed right now and opens tomorrow (Friday) at 8:00 AM. Leave a message and the team will get back to you.",
    });
  });

  it("refuses sites that are not on the list, missing origins and unknown keys", async () => {
    for (const origin of [OTHER_SITE, "http://www.summit-roofing.test", null, "null"]) {
      expect(await service.config(key, { ...request, origin })).toMatchObject({
        ok: false,
        status: 403,
        body: { error: "origin_not_allowed" },
      });
    }
    // Another business's key on this site: that business does not allow it.
    expect(await service.config(otherKey, request)).toMatchObject({ ok: false, status: 403 });
    expect(await service.config("wpk_AAAAAAAAAAAAAAAAAAAAAAAA", request)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await service.config("../../etc", request)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("sessions", () => {
  it("starts a session and resumes it with the kept token", async () => {
    const first = await session();
    expect(first).toMatchObject({ resumed: false, needsProfile: [], realtime: null });
    const resumed = await session(request, first.token);
    expect(resumed.resumed).toBe(true);
    const rows = await t.admin
      .select()
      .from(widgetSessions)
      .where(eq(widgetSessions.businessId, tenant.businessId));
    const row = rows.find((candidate) => candidate.origin === SITE);
    expect(row?.ipHash).not.toContain("203");
    expect(row?.ipHash).toHaveLength(32);
  });

  it("does not resume a session on another site, after expiry or once revoked", async () => {
    const first = await session({ ...request, ip: "198.51.100.1" });
    await setSettings(tenant, [
      { key: "channels.widget.allowed_origins", value: [SITE, "https://summit-roofing.test"] },
    ]);
    const elsewhere = await session(
      { ...request, origin: "https://summit-roofing.test", ip: "198.51.100.1" },
      first.token,
    );
    expect(elsewhere.resumed).toBe(false);
    await setSettings(tenant, [{ key: "channels.widget.allowed_origins", value: [SITE] }]);

    await t.admin
      .update(widgetSessions)
      .set({ revokedAt: now })
      .where(eq(widgetSessions.origin, "https://summit-roofing.test"));
    expect(
      await service.listMessages(elsewhere.token, null, {
        ...request,
        origin: "https://summit-roofing.test",
      }),
    ).toMatchObject({ ok: false });

    now = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    const later = await session({ ...request, ip: "198.51.100.1" }, first.token);
    expect(later.resumed).toBe(false);
  });

  it("limits new sessions per network address", async () => {
    const info = { ...request, ip: "192.0.2.50" };
    for (let index = 0; index < 3; index += 1) await session(info);
    const refused = await service.startSession({ key, token: null }, info);
    expect(refused).toMatchObject({ ok: false, status: 429, body: { error: "rate_limited" } });
    // Another address is not affected.
    await session({ ...request, ip: "192.0.2.51" });
  });

  it("refuses a token for another business, a forged one and one used from another site", async () => {
    const mine = await session({ ...request, ip: "192.0.2.60" });
    expect(
      await service.listMessages(mine.token, null, { ...request, origin: OTHER_SITE }),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    const [connection] = await t.admin
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(eq(channelConnections.externalAccountId, otherKey));
    // Signed with another secret: worthless.
    const forged = signWidgetToken("someone-elses-secret-0123456789-abcdefgh", {
      sid: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40",
      cid: connection!.id,
      bid: other.businessId,
      aid: other.agencyId,
      exp: Math.floor(now.getTime() / 1000) + 600,
    });
    expect(await service.listMessages(forged, null, request)).toMatchObject({ status: 401 });
    // Genuinely signed, but naming a business outside the agency it claims.
    const mismatched = signWidgetToken(SECRET, {
      sid: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40",
      cid: connection!.id,
      bid: other.businessId,
      aid: tenant.agencyId,
      exp: Math.floor(now.getTime() / 1000) + 600,
    });
    expect(await service.listMessages(mismatched, null, request)).toMatchObject({ status: 401 });
    expect(await service.listMessages(null, null, request)).toMatchObject({ status: 401 });
  });

  it("stops working when the business removes the site from its list", async () => {
    const mine = await session({ ...request, ip: "192.0.2.70" });
    await setSettings(tenant, [{ key: "channels.widget.allowed_origins", value: [] }]);
    try {
      expect(await service.listMessages(mine.token, null, request)).toMatchObject({ status: 403 });
      expect(await service.config(key, request)).toMatchObject({ status: 403 });
    } finally {
      await setSettings(tenant, [{ key: "channels.widget.allowed_origins", value: [SITE] }]);
    }
  });
});

describe("pre-chat details and messages", () => {
  it("requires the pre-chat details the settings ask for, then sends them with every message", async () => {
    await setSettings(tenant, [
      { key: "channels.widget.pre_chat_fields", value: ["name", "phone", "email"] },
    ]);
    try {
      const visitor = await session({ ...request, ip: "192.0.2.80" });
      expect(visitor.needsProfile).toEqual(["name", "phone", "email"]);
      const blocked = await service.postMessage(
        visitor.token,
        { id: "msg-00000001", text: "Hello", photo: null },
        request,
      );
      expect(blocked).toMatchObject({
        ok: false,
        status: 409,
        body: { error: "profile_required" },
      });

      expect(
        await service.saveProfile(visitor.token, { phone: "not a phone" }, request),
      ).toMatchObject({ ok: false, status: 400 });
      expect(await service.saveProfile(visitor.token, { email: "nobody" }, request)).toMatchObject({
        ok: false,
        status: 400,
      });
      const saved = await service.saveProfile(
        visitor.token,
        { name: "Pat  Lee", phone: "(303) 555-0142", email: "Pat@Example.com" },
        request,
      );
      expect(saved).toEqual({ ok: true, value: { needsProfile: [] } });

      const sent = await service.postMessage(
        visitor.token,
        { id: "msg-00000002", text: "  My roof leaks  ", photo: null },
        request,
      );
      expect(sent).toEqual({ ok: true, value: { accepted: true, duplicate: false } });
      const message = ingested[0]!.messages[0]!;
      expect(message).toMatchObject({
        channel: "widget",
        externalAccountId: key,
        kind: "text",
        text: "My roof leaks",
        sender: { displayName: "Pat Lee", phone: "+13035550142", email: "pat@example.com" },
        attachments: [],
      });
      expect(message.externalMessageId).toMatch(/:msg-00000002$/);
      expect(message.sender.externalId).toMatch(/^v_/);
    } finally {
      await setSettings(tenant, [{ key: "channels.widget.pre_chat_fields", value: [] }]);
    }
  });

  it("stores a photo inside the business's folder and checks its type and size", async () => {
    const visitor = await session({ ...request, ip: "192.0.2.90" });
    const sent = await service.postMessage(
      visitor.token,
      { id: "photo-0001", text: null, photo: { bytes: JPEG, fileName: "../../leak.png" } },
      request,
    );
    expect(sent.ok).toBe(true);
    const message = ingested[0]!.messages[0]!;
    expect(message.kind).toBe("media");
    const attachment = message.attachments[0]!;
    expect(attachment).toMatchObject({
      kind: "image",
      mimeType: "image/jpeg",
      fileName: "leak.jpg",
    });
    expect(attachment.source.type).toBe("storage");
    const path = attachment.source.type === "storage" ? attachment.source.path : "";
    expect(path.startsWith(`${tenant.agencyId}/${tenant.businessId}/uploads/`)).toBe(true);
    expect(store.objects.get(path)?.contentType).toBe("image/jpeg");

    const script = new TextEncoder().encode("<script>alert(1)</script>.................");
    expect(
      await service.postMessage(
        visitor.token,
        { id: "photo-0002", text: null, photo: { bytes: script, fileName: "x.jpg" } },
        request,
      ),
    ).toMatchObject({ ok: false, status: 415 });
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(
      await service.postMessage(
        visitor.token,
        { id: "photo-0003", text: null, photo: { bytes: big, fileName: "big.jpg" } },
        request,
      ),
    ).toMatchObject({ ok: false, status: 413 });

    await setSettings(tenant, [{ key: "channels.widget.photo_upload", value: false }]);
    try {
      expect(
        await service.postMessage(
          visitor.token,
          { id: "photo-0004", text: null, photo: { bytes: JPEG, fileName: "a.jpg" } },
          request,
        ),
      ).toMatchObject({ ok: false, status: 403, body: { error: "photos_disabled" } });
    } finally {
      await setSettings(tenant, [{ key: "channels.widget.photo_upload", value: true }]);
    }
    expect(ingested).toHaveLength(1);
  });

  it("refuses empty, oversized and malformed messages", async () => {
    const visitor = await session({ ...request, ip: "192.0.2.91" });
    for (const input of [
      { id: "msg-00000010", text: "   ", photo: null },
      { id: "msg-00000011", text: "x".repeat(4001), photo: null },
      { id: "bad id!", text: "hi", photo: null },
      { id: "msg-00000012", text: 42, photo: null },
    ]) {
      expect(await service.postMessage(visitor.token, input, request)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("limits messages per visitor per minute", async () => {
    const visitor = await session({ ...request, ip: "192.0.2.92" });
    for (let index = 0; index < 5; index += 1) {
      const sent = await service.postMessage(
        visitor.token,
        { id: `burst-000${index}`, text: `message ${index}`, photo: null },
        request,
      );
      expect(sent.ok).toBe(true);
    }
    const refused = await service.postMessage(
      visitor.token,
      { id: "burst-0009", text: "one too many", photo: null },
      request,
    );
    expect(refused).toMatchObject({ ok: false, status: 429 });
    if (!refused.ok) expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
    now = new Date(now.getTime() + 61_000);
    expect(
      (
        await service.postMessage(
          visitor.token,
          { id: "burst-0010", text: "later", photo: null },
          request,
        )
      ).ok,
    ).toBe(true);
  });

  it("limits photos per visitor per hour", async () => {
    await setSettings(tenant, [{ key: "limits.widget_photos_per_visitor_per_hour", value: 2 }]);
    try {
      const visitor = await session({ ...request, ip: "192.0.2.93" });
      const photo = (id: string) =>
        service.postMessage(
          visitor.token,
          { id, text: null, photo: { bytes: JPEG, fileName: "roof.jpg" } },
          request,
        );
      expect((await photo("many-photo-1")).ok).toBe(true);
      expect((await photo("many-photo-2")).ok).toBe(true);
      expect(await photo("many-photo-3")).toMatchObject({
        ok: false,
        status: 429,
        body: { error: "rate_limited" },
      });
      // Text still goes through.
      expect(
        (
          await service.postMessage(
            visitor.token,
            { id: "many-text-1", text: "and the gutter", photo: null },
            request,
          )
        ).ok,
      ).toBe(true);
      expect(store.objects.size).toBe(2);
      now = new Date(now.getTime() + 61 * 60_000);
      expect((await photo("many-photo-4")).ok).toBe(true);
    } finally {
      await setSettings(tenant, [{ key: "limits.widget_photos_per_visitor_per_hour", value: 20 }]);
    }
  });

  it("limits how often one session polls", async () => {
    const visitor = await session({ ...request, ip: "192.0.2.94" });
    for (let index = 0; index < 120; index += 1) {
      const page = await service.listMessages(visitor.token, null, request);
      if (!page.ok) throw new Error(`poll ${index} refused: ${JSON.stringify(page)}`);
    }
    const refused = await service.listMessages(visitor.token, null, request);
    expect(refused).toMatchObject({ ok: false, status: 429, body: { error: "rate_limited" } });
    // Another visitor is not affected.
    const neighbour = await session({ ...request, ip: "192.0.2.95" });
    expect((await service.listMessages(neighbour.token, null, request)).ok).toBe(true);
    now = new Date(now.getTime() + 61_000);
    expect((await service.listMessages(visitor.token, null, request)).ok).toBe(true);
  });
});

describe("history", () => {
  async function seedConversation(visitorId: string, connectionId: ChannelConnectionId) {
    const [contact] = await t.admin
      .insert(contacts)
      .values({ ...tenant, agencyId: tenant.agencyId as never, displayName: "Pat" })
      .returning({ id: contacts.id });
    await t.admin.insert(contactIdentities).values({
      agencyId: tenant.agencyId as never,
      businessId: tenant.businessId,
      contactId: contact!.id,
      channel: "widget",
      externalId: visitorId,
    });
    const [conversation] = await t.admin
      .insert(conversations)
      .values({
        agencyId: tenant.agencyId as never,
        businessId: tenant.businessId,
        contactId: contact!.id,
        channelConnectionId: connectionId,
        channel: "widget",
        messageSeq: 0,
      })
      .returning({ id: conversations.id });
    return { contactId: contact!.id, conversationId: conversation!.id };
  }

  async function addMessage(
    ids: { conversationId: ConversationId; contactId: ContactId },
    connectionId: ChannelConnectionId,
    sequence: number,
    fields: Partial<typeof messages.$inferInsert>,
  ) {
    await t.admin.insert(messages).values({
      agencyId: tenant.agencyId as never,
      businessId: tenant.businessId,
      conversationId: ids.conversationId,
      channelConnectionId: connectionId,
      direction: "outbound",
      author: "bot",
      status: "sent",
      text: `message ${sequence}`,
      sequence,
      createdAt: new Date(now.getTime() - 1000 + sequence),
      ...fields,
    });
    await t.admin
      .update(conversations)
      .set({ messageSeq: sequence })
      .where(eq(conversations.id, ids.conversationId));
  }

  it("shows the visitor their own conversation only, never a reply that was not sent", async () => {
    const visitor = await session({ ...request, ip: "192.0.2.100" });
    const sid = verifyWidgetToken(SECRET, visitor.token, now)!.sid;
    const [newest] = await t.admin.select().from(widgetSessions).where(eq(widgetSessions.id, sid));
    const connectionId = newest!.channelConnectionId;
    const ids = await seedConversation(newest!.visitorId, connectionId);

    await addMessage(ids, connectionId, 1, {
      direction: "inbound",
      author: "customer",
      status: "received",
      text: "My roof leaks",
      externalMessageId: `${newest!.id}:client-0001`,
    });
    await addMessage(ids, connectionId, 2, {
      text: "Sorry to hear that. Where is the leak?",
      payload: { quickReplies: ["Ceiling", "Attic"] },
    });
    await addMessage(ids, connectionId, 3, { status: "superseded", text: "draft that lost" });
    await addMessage(ids, connectionId, 4, { status: "failed", text: "failed send" });
    await addMessage(ids, connectionId, 5, {
      author: "human_agent",
      text: "This is Sam from the office.",
    });
    // Another visitor of the same business.
    const stranger = await seedConversation("v_stranger", connectionId);
    await addMessage(stranger, connectionId, 1, { text: "not yours" });

    // The bot has dealt with the visitor's first message.
    await t.admin
      .update(conversations)
      .set({ handledThroughSeq: 1 })
      .where(eq(conversations.id, ids.conversationId));
    const first = await service.listMessages(visitor.token, null, request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.messages.map((message) => [message.from, message.text])).toEqual([
      ["visitor", "My roof leaks"],
      ["bot", "Sorry to hear that. Where is the leak?"],
      ["team", "This is Sam from the office."],
    ]);
    expect(first.value.messages[0]!.clientId).toBe("client-0001");
    expect(first.value.messages[1]!.quickReplies).toEqual(["Ceiling", "Attic"]);
    expect(first.value.typing).toBe(false);
    expect(JSON.stringify(first.value)).not.toContain("not yours");

    // A queued reply and a later visitor message: typing, and the cursor waits for the reply.
    await addMessage(ids, connectionId, 6, { status: "queued", text: "queued reply" });
    await addMessage(ids, connectionId, 7, {
      direction: "inbound",
      author: "customer",
      status: "received",
      text: "Also the gutter",
      externalMessageId: `${newest!.id}:client-0002`,
    });
    const second = await service.listMessages(visitor.token, first.value.cursor, request);
    if (!second.ok) throw new Error("expected messages");
    expect(second.value.messages.map((message) => message.text)).toEqual(["Also the gutter"]);
    expect(second.value.typing).toBe(true);
    expect(second.value.cursor).toBe(`${ids.conversationId}:5`);

    await t.admin.update(messages).set({ status: "sent" }).where(eq(messages.text, "queued reply"));
    await t.admin
      .update(conversations)
      .set({ handledThroughSeq: 7 })
      .where(eq(conversations.id, ids.conversationId));
    const third = await service.listMessages(visitor.token, second.value.cursor, request);
    if (!third.ok) throw new Error("expected messages");
    expect(third.value.messages.map((message) => message.text)).toEqual([
      "queued reply",
      "Also the gutter",
    ]);
    expect(third.value.typing).toBe(false);
    expect(third.value.cursor).toBe(`${ids.conversationId}:7`);

    // A person holds the conversation: no typing dots for the bot.
    await addMessage(ids, connectionId, 8, {
      direction: "inbound",
      author: "customer",
      status: "received",
      text: "Hello?",
      externalMessageId: `${newest!.id}:client-0003`,
    });
    const typingNow = await service.listMessages(visitor.token, third.value.cursor, request);
    expect(typingNow.ok && typingNow.value.typing).toBe(true);
    await t.admin.insert(takeoverLocks).values({
      agencyId: tenant.agencyId as never,
      businessId: tenant.businessId,
      conversationId: ids.conversationId,
      source: "admin_panel",
    });
    const held = await service.listMessages(visitor.token, third.value.cursor, request);
    expect(held.ok && held.value.typing).toBe(false);
  });
});

describe("connection management", () => {
  it("creates one connection, rotates its key and switches it off", async () => {
    const info = await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => widgetEmbedInfo(ctx, { appUrl: "https://app.example.com/" }));
    expect(info).toMatchObject({
      publicKey: key,
      status: "active",
      scriptUrl: "https://app.example.com/api/widget/v1/widget.js",
      snippet: `<script src="https://app.example.com/api/widget/v1/widget.js" data-key="${key}" async></script>`,
      allowedOrigins: [SITE],
      needsOrigins: false,
    });
    const again = await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => ensureWidgetConnection(ctx, { actor: system }));
    expect(again.publicKey).toBe(key);

    const rotated = await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => rotateWidgetKey(ctx, { actor: system }));
    expect(rotated.publicKey).not.toBe(key);
    expect(await service.config(key, request)).toMatchObject({ status: 404 });
    expect((await service.config(rotated.publicKey, request)).ok).toBe(true);

    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => setWidgetEnabled(ctx, { enabled: false, actor: system }));
    expect(await service.config(rotated.publicKey, request)).toMatchObject({ status: 404 });
    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) => setWidgetEnabled(ctx, { enabled: true, actor: system }));
    key = rotated.publicKey;
    expect((await service.config(key, request)).ok).toBe(true);
  });
});
