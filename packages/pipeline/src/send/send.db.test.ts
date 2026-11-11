import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationId, MessageId, TraceId } from "@repo/core";
import { alerts, conversations, deadLetters, eq, messages, sql, takeoverLocks } from "@repo/db";
import { jobEvent } from "@repo/jobs";

import { sendEventId } from "../event-ids";
import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

/** A conversation with one answered customer message, to hang outbound messages on. */
async function conversationFor(tenant: TestTenant): Promise<ConversationId> {
  await h.deliver(tenant, [message("hello")]);
  await h.idle();
  const [conversation] = await h.conversationsOf(tenant);
  return conversation!.id;
}

/** Stores queued outbound messages directly, as a turn's commit would. */
async function queue(
  tenant: TestTenant,
  conversationId: ConversationId,
  texts: string[],
  author: "bot" | "human_agent" = "bot",
): Promise<MessageId[]> {
  const ids: MessageId[] = [];
  for (const text of texts) {
    const [counter] = await h.t.admin
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, conversationId))
      .returning({ sequence: conversations.messageSeq });
    const [row] = await h.t.admin
      .insert(messages)
      .values({
        ...tenant.tenant,
        conversationId,
        channelConnectionId: tenant.connectionId as never,
        direction: "outbound",
        author,
        kind: "text",
        text,
        sequence: counter!.sequence,
        status: "queued",
      })
      .returning({ id: messages.id });
    ids.push(row!.id);
  }
  return ids;
}

function sendEvent(tenant: TestTenant, conversationId: ConversationId, messageId: MessageId) {
  return jobEvent("message.send_requested", sendEventId(messageId), {
    traceId: crypto.randomUUID() as TraceId,
    ...tenant.tenant,
    conversationId,
    messageId,
    channel: "test",
  });
}

async function rowsById(ids: readonly MessageId[]) {
  const rows = await h.t.admin
    .select()
    .from(messages)
    .where(sql`${messages.id} in ${ids}`);
  return ids.map((id) => rows.find((row) => row.id === id)!);
}

describe("order (I4)", () => {
  it("delivers a conversation's messages in sequence even when their events arrive reversed", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const ids = await queue(tenant, conversationId, ["one", "two", "three", "four"]);
    await h.events.send([...ids].reverse().map((id) => sendEvent(tenant, conversationId, id)));
    await h.idle();
    expect(h.transport.textsFor(conversationId).slice(1)).toEqual(["one", "two", "three", "four"]);
    expect((await rowsById(ids)).map((row) => row.status)).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
    ]);
  });

  it("sends a message once even when its event is delivered again", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const [id] = await queue(tenant, conversationId, ["only once"]);
    const event = sendEvent(tenant, conversationId, id!);
    // The same event id is dropped; a different id (a sweeper re-emit) finds the row sent.
    await h.events.send([event, event, { ...event, id: `${event.id}-again` }]);
    await h.idle();
    await h.events.send([{ ...event, id: `${event.id}-later` }]);
    await h.idle();
    expect(
      h.transport.textsFor(conversationId).filter((text) => text === "only once"),
    ).toHaveLength(1);
  });
});

describe("takeover at send time (I5)", () => {
  it("withholds a queued bot message while a person holds the conversation", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const [botId, humanId] = [
      ...(await queue(tenant, conversationId, ["from the bot"])),
      ...(await queue(tenant, conversationId, ["from a person"], "human_agent")),
    ];
    await h.t.admin
      .insert(takeoverLocks)
      .values({ ...tenant.tenant, conversationId, source: "admin_panel" });
    await h.events.send([
      sendEvent(tenant, conversationId, botId!),
      sendEvent(tenant, conversationId, humanId!),
    ]);
    await h.idle();
    const [bot, human] = await rowsById([botId!, humanId!]);
    expect([bot?.status, bot?.errorCode]).toEqual(["superseded", "takeover"]);
    expect(human?.status).toBe("sent");
    const delivered = h.transport.deliveries.filter(
      (delivery) => delivery.conversationId === conversationId,
    );
    expect(
      delivered.map((delivery) => [
        delivery.message.kind === "text" ? delivery.message.text : "",
        delivery.sentByHuman,
      ]),
    ).toEqual([
      ["You said: hello", false],
      ["from a person", true],
    ]);
  });
});

describe("failures (I7)", () => {
  it("retries a failed send and delivers it once", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const [id] = await queue(tenant, conversationId, ["retry me"]);
    const attemptsBefore = h.transport.attempts;
    h.transport.failNext(2);
    await h.events.send([sendEvent(tenant, conversationId, id!)]);
    await h.idle();
    expect(h.transport.attempts - attemptsBefore).toBe(3);
    expect(h.transport.textsFor(conversationId).filter((text) => text === "retry me")).toHaveLength(
      1,
    );
    const [row] = await rowsById([id!]);
    expect(row?.status).toBe("sent");
    expect(row?.externalMessageId).toMatch(/^test-out-/);
  });

  it("surfaces a permanent failure: failed row, event, dead letter and alert", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const [id] = await queue(tenant, conversationId, ["cannot be delivered"]);
    h.transport.failNext(1, { code: "recipient_blocked", retryable: false });
    await h.events.send([sendEvent(tenant, conversationId, id!)]);
    await h.idle();
    const [row] = await rowsById([id!]);
    expect([row?.status, row?.errorCode]).toEqual(["failed", "recipient_blocked"]);
    expect(h.events.named("message.send_failed").some((event) => event.data.messageId === id)).toBe(
      true,
    );
    const letters = await h.t.admin
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.messageId, id!));
    expect(letters.map((letter) => [letter.source, letter.errorCode])).toEqual([
      ["pipeline-send", "recipient_blocked"],
    ]);
    const raised = await h.t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.conversationId, conversationId));
    expect(raised.map((alert) => [alert.kind, alert.channel])).toEqual([["send_failed", "in_app"]]);
  });

  it("gives up after the retries and surfaces the failure", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const [id, next] = await queue(tenant, conversationId, ["never gets through", "after it"]);
    h.transport.failNext(3); // the first attempt and both retries
    await h.events.send([
      sendEvent(tenant, conversationId, id!),
      sendEvent(tenant, conversationId, next!),
    ]);
    await h.idle();
    const [row, after] = await rowsById([id!, next!]);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("external_service_failed");
    // A failed message does not block the ones after it.
    expect(after?.status).toBe("sent");
    const letters = await h.t.admin
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.messageId, id!));
    expect(letters).toHaveLength(1);
  });
});
