import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationId } from "@repo/core";
import { eq, messages, takeoverLocks } from "@repo/db";

import { enqueueBotMessage, enqueueHumanMessage } from "./outbound";
import { createHarness, type Harness, message, type TestTenant } from "./testing/harness";

/*
 * Messages the bot sends on its own, written by code (C12: meeting reminders): stored as the
 * conversation's next outbound message and sent by the ordinary send function, so takeovers
 * and the channel's rules apply to them as to any reply.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

async function conversationFor(tenant: TestTenant): Promise<ConversationId> {
  await h.deliver(tenant, [message("hello")]);
  await h.idle();
  const [conversation] = await h.conversationsOf(tenant);
  return conversation!.id;
}

async function enqueue(tenant: TestTenant, conversationId: ConversationId, text: string) {
  const queued = await h.t.db
    .forBusiness(tenant.tenant.businessId, { agencyId: tenant.tenant.agencyId })
    .run((ctx) =>
      enqueueBotMessage(ctx, {
        conversationId,
        text,
        traceId: crypto.randomUUID(),
        purpose: "reminder",
      }),
    );
  await h.events.send(queued?.events ?? []);
  await h.idle();
  return queued;
}

describe("enqueueBotMessage", () => {
  it("stores the message after the conversation's others and sends it through the pipeline", async () => {
    const tenant = await conversationTenant();
    const conversationId = await conversationFor(tenant);
    const queued = await enqueue(tenant, conversationId, "Just a reminder of your visit tomorrow.");
    expect(queued?.events.map((event) => event.name)).toEqual(["message.send_requested"]);
    const rows = await h.messagesOf(tenant);
    const reminder = rows.find((row) => row.id === queued?.messageId);
    expect(reminder).toMatchObject({ author: "bot", direction: "outbound", status: "sent" });
    expect(reminder!.payload).toMatchObject({ purpose: "reminder" });
    expect(Math.max(...rows.map((row) => row.sequence))).toBe(reminder!.sequence);
    expect(h.transport.textsFor(conversationId)).toContain(
      "Just a reminder of your visit tomorrow.",
    );
  });

  it("is withheld while a person holds the conversation (I5)", async () => {
    const tenant = await conversationTenant();
    const conversationId = await conversationFor(tenant);
    await h.t.admin
      .insert(takeoverLocks)
      .values({ ...tenant.tenant, conversationId, source: "rule", reason: "test" });
    const queued = await enqueue(tenant, conversationId, "A reminder nobody should get.");
    const [row] = await h.t.admin
      .select()
      .from(messages)
      .where(eq(messages.id, queued!.messageId as never));
    expect(row?.status).toBe("superseded");
    expect(h.transport.textsFor(conversationId)).not.toContain("A reminder nobody should get.");
  });

  it("stores nothing for an empty text or an unknown conversation", async () => {
    const tenant = await conversationTenant();
    const conversationId = await conversationFor(tenant);
    expect(await enqueue(tenant, conversationId, "   ")).toBeNull();
    expect(await enqueue(tenant, crypto.randomUUID() as ConversationId, "x")).toBeNull();
  });
});

describe("enqueueHumanMessage (C16)", () => {
  it("sends a person's reply once for one idempotency key", async () => {
    const tenant = await conversationTenant();
    const conversationId = await conversationFor(tenant);
    await h.t.admin
      .insert(takeoverLocks)
      .values({ ...tenant.tenant, conversationId, source: "admin_panel", reason: "test" });
    const userId = (
      await h.t.db.localAuth.upsertUser({ email: `sam-${crypto.randomUUID()}@pipeline.test` })
    ).id;
    const send = (key: string) =>
      h.t.db
        .forBusiness(tenant.tenant.businessId, { agencyId: tenant.tenant.agencyId })
        .run((ctx) =>
          enqueueHumanMessage(ctx, {
            conversationId,
            text: "Hi, this is Sam from the office.",
            traceId: crypto.randomUUID(),
            userId,
            idempotencyKey: key,
          }),
        );
    // Two clicks at once, then a retry: one message.
    const [first, second] = await Promise.all([send("reply-1"), send("reply-1")]);
    const third = await send("reply-1");
    const events = [first, second, third].flatMap((result) => result?.events ?? []);
    expect(events).toHaveLength(1);
    expect(new Set([first?.messageId, second?.messageId, third?.messageId]).size).toBe(1);
    expect([first, second, third].filter((result) => result?.duplicate === true)).toHaveLength(2);
    await h.events.send(events);
    await h.idle();
    const texts = h.transport.textsFor(conversationId);
    expect(texts.filter((text) => text === "Hi, this is Sam from the office.")).toHaveLength(1);
    // A new key is a new message.
    const other = await send("reply-2");
    expect(other?.messageId).not.toBe(first?.messageId);
  });
});

function conversationTenant(): Promise<TestTenant> {
  return h.newTenant();
}
