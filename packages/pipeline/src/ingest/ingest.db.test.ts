import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachments, contacts, eq, messages, sql } from "@repo/db";
import { tenantPrefix } from "@repo/db/storage";

import { createHarness, type Harness, message } from "../testing/harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

describe("handleWebhook", () => {
  it("rejects a bad signature with 401 and never reaches storage (I1)", async () => {
    const tenant = await h.newTenant();
    const before = h.events.sent.length;
    const response = await h.deliver(tenant, [message("Hello")], {
      secret: "not-the-channel-secret-012345",
    });
    expect(response).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await h.messagesOf(tenant)).toEqual([]);
    const stored = await h.t.admin
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.businessId, tenant.tenant.businessId));
    expect(stored).toEqual([]);
    expect(h.events.sent.length).toBe(before);
    // The rejection is logged without the body.
    const rejected = h.logs.filter((record) => record.msg === "webhook.rejected");
    expect(rejected.at(-1)).toMatchObject({ reason: "bad_signature", channel: "test" });
    expect(JSON.stringify(rejected)).not.toContain("Hello");
  });

  it("answers 404 for an unknown channel or one without an adapter", async () => {
    const request = {
      method: "POST" as const,
      url: "http://x",
      headers: {},
      query: {},
      rawBody: "{}",
    };
    expect((await h.pipeline.handleWebhook("fax", request)).status).toBe(404);
    expect((await h.pipeline.handleWebhook("whatsapp", request)).status).toBe(404);
  });

  it("answers 400 for a signed body that does not match the schema, 413 when too large", async () => {
    const tenant = await h.newTenant();
    const bad = await h.deliver(tenant, [{ type: "message" } as never]);
    expect(bad.status).toBe(400);
    const huge = await h.deliver(tenant, [message("x".repeat(20_000))]);
    expect(huge.status).toBe(200);
    const tooLarge = await h.pipeline.handleWebhook("test", {
      method: "POST",
      url: "http://x",
      headers: {},
      query: {},
      rawBody: "x".repeat(4 * 1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    await h.idle();
  });

  it("acknowledges an unknown account with 200 and stores nothing", async () => {
    const tenant = await h.newTenant();
    const response = await h.deliver({ ...tenant, accountId: "test-unknown-account" }, [
      message("Hello?"),
    ]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ stored: 0, ignored: 1 });
    expect(await h.messagesOf(tenant)).toEqual([]);
  });
});

describe("ingest", () => {
  it("stores a message once and answers once, however often it is delivered (I2)", async () => {
    const tenant = await h.newTenant();
    const once = message("My roof leaks", { id: "provider-msg-1" });
    const first = await h.deliver(tenant, [once]);
    expect(first.body).toMatchObject({ stored: 1, duplicates: 0, emitted: 1 });
    // Again, one after the other and all at the same moment.
    const again = await h.deliver(tenant, [once]);
    expect(again.body).toMatchObject({ stored: 0, duplicates: 1, emitted: 0 });
    const parallel = await Promise.all([1, 2, 3, 4].map(() => h.deliver(tenant, [once])));
    expect(parallel.every((response) => response.status === 200)).toBe(true);
    await h.idle();

    const rows = await h.messagesOf(tenant);
    const inbound = rows.filter((row) => row.direction === "inbound");
    const outbound = rows.filter((row) => row.direction === "outbound");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ sequence: 1, status: "received", text: "My roof leaks" });
    expect(inbound[0]?.enqueuedAt).not.toBeNull();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ status: "sent", author: "bot", sequence: 2 });
    expect(h.transport.textsFor(inbound[0]!.conversationId)).toEqual(["You said: My roof leaks"]);
    expect(
      h.events.named("message.received").filter((event) => event.data.messageId === inbound[0]!.id),
    ).toHaveLength(1);
  });

  it("stores and answers a new message once when its first deliveries arrive at the same moment (I2)", async () => {
    // A new customer, so the deliveries also race to create the contact and the conversation.
    for (let round = 0; round < 3; round += 1) {
      const tenant = await h.newTenant();
      const once = message(`First words ${round}`, { id: `provider-race-${round}` });
      const responses = await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.deliver(tenant, [once])));
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(responses.filter((response) => response.body["stored"] === 1)).toHaveLength(1);
      await h.idle();
      const rows = await h.messagesOf(tenant);
      expect(rows.map((row) => [row.direction, row.sequence, row.status])).toEqual([
        ["inbound", 1, "received"],
        ["outbound", 2, "sent"],
      ]);
      expect(await h.conversationsOf(tenant)).toHaveLength(1);
      const people = await h.t.admin
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.businessId, tenant.tenant.businessId));
      expect(people).toHaveLength(1);
    }
  });

  it("answers 500 when the event cannot be emitted, and the redelivery emits it", async () => {
    const tenant = await h.newTenant();
    const once = message("Are you open today?");
    h.events.failures = 1;
    const failed = await h.deliver(tenant, [once]);
    expect(failed).toEqual({ status: 500, body: { error: "internal" } });
    const [stored] = await h.messagesOf(tenant);
    expect(stored?.enqueuedAt).toBeNull();

    const retried = await h.deliver(tenant, [once]);
    expect(retried.body).toMatchObject({ stored: 0, duplicates: 1, emitted: 1 });
    await h.idle();
    const rows = await h.messagesOf(tenant);
    expect(rows.filter((row) => row.direction === "inbound")).toHaveLength(1);
    expect(rows.find((row) => row.direction === "inbound")?.enqueuedAt).not.toBeNull();
    expect(rows.filter((row) => row.status === "sent")).toHaveLength(1);
  });

  it("keeps one contact and one open conversation per customer, and fills contact details", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("one", { from: "visitor-a" })]);
    await h.deliver(tenant, [
      {
        type: "message",
        id: "m-details",
        from: { id: "visitor-a", name: "Alex", phone: "+15125550100", email: "alex@example.com" },
        text: "two",
        sentAt: new Date().toISOString(),
      },
    ]);
    await h.deliver(tenant, [message("other", { from: "visitor-b" })]);
    await h.idle();
    const people = await h.t.admin
      .select()
      .from(contacts)
      .where(eq(contacts.businessId, tenant.tenant.businessId));
    expect(people).toHaveLength(2);
    expect(people.find((person) => person.phone !== null)).toMatchObject({
      displayName: "Pat",
      phone: "+15125550100",
      email: "alex@example.com",
    });
    const threads = await h.conversationsOf(tenant);
    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.status)).toEqual(["open", "open"]);
  });

  it("stores a reaction without starting a turn", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("Hello")]);
    await h.idle();
    const before = h.runner.history.length;
    const reaction = await h.deliver(tenant, [
      {
        type: "reaction",
        id: "r-1",
        from: { id: "visitor-1" },
        targetMessageId: "whatever",
        emoji: "👍",
        sentAt: new Date().toISOString(),
      },
    ]);
    expect(reaction.body).toMatchObject({ stored: 1, emitted: 0 });
    await h.idle();
    expect(h.runner.history.length).toBe(before);
    const rows = await h.messagesOf(tenant);
    expect(rows.map((row) => [row.kind, row.direction])).toEqual([
      ["text", "inbound"],
      ["text", "outbound"],
      ["reaction", "inbound"],
    ]);
    expect(rows[2]?.enqueuedAt).not.toBeNull();
  });

  it("downloads provider media into the tenant's storage before the turn", async () => {
    const tenant = await h.newTenant();
    h.transport.media.set("media-roof", {
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: "image/jpeg",
    });
    await h.deliver(tenant, [
      message(null, {
        attachments: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            fileName: "../../roof photo.jpg",
            sizeBytes: 3,
            source: { type: "provider_media", mediaId: "media-roof" },
          },
          {
            kind: "image",
            mimeType: "image/jpeg",
            fileName: "theirs.jpg",
            sizeBytes: 3,
            source: {
              type: "storage",
              bucket: "attachments",
              path: "00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001/x/y/z.jpg",
            },
          },
        ],
      }),
    ]);
    await h.idle();
    const files = await h.t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.businessId, tenant.tenant.businessId))
      .orderBy(attachments.createdAt, sql`${attachments.storagePath} nulls last`);
    const downloaded = files.find((file) => file.fileName === "../../roof photo.jpg");
    expect(downloaded?.status).toBe("stored");
    expect(downloaded?.storagePath?.startsWith(tenantPrefix(tenant.tenant))).toBe(true);
    expect(downloaded?.storagePath).toMatch(/roof_photo\.jpg$/);
    // A webhook cannot point the bot at another business's files.
    const foreign = files.find((file) => file.fileName === "theirs.jpg");
    expect(foreign).toMatchObject({ status: "failed", storagePath: null });

    const [inbound] = await h.t.admin
      .select()
      .from(messages)
      .where(eq(messages.businessId, tenant.tenant.businessId))
      .orderBy(messages.sequence);
    expect(inbound?.kind).toBe("media");
    expect(h.transport.textsFor(inbound!.conversationId)).toEqual(["(2 attachments received)"]);
  });
});
