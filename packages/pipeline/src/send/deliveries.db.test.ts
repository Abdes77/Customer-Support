import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationId, MessageId, SendResult, TraceId } from "@repo/core";
import { conversations, eq, messageParts, messages, pendingDeliveryStatuses, sql } from "@repo/db";
import { jobEvent } from "@repo/jobs";

import { sendEventId } from "../event-ids";
import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";
import { aggregateStatus } from "./deliveries";
import { sendPart } from "./job";
import type { SendTargetInfo } from "./prepare";

/*
 * Delivery statuses (C9 closing the C3 review's gaps): a status that arrives before the send
 * step recorded the provider id, a status that arrives while the send run is still going, and
 * statuses of every part of a split message.
 */

let h: Harness;
/** Runs while the provider "accepts" a message, before the pipeline records its id. */
let duringSend: ((externalMessageId: string, tenant: TestTenant) => Promise<void>) | null = null;
let currentTenant: TestTenant | null = null;
/** Every call of the adapter's send (the test transport itself is idempotent per key). */
let sendCalls = 0;

beforeAll(async () => {
  h = await createHarness({
    wrapAdapter: (adapter) => ({
      ...adapter,
      async send(outbound, target): Promise<SendResult> {
        sendCalls += 1;
        const result = await adapter.send(outbound, target);
        if (result.ok && duringSend !== null && currentTenant !== null) {
          await duringSend(result.externalMessageId, currentTenant);
        }
        return result;
      },
    }),
  });
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

async function queue(
  tenant: TestTenant,
  conversationId: ConversationId,
  text: string,
): Promise<MessageId> {
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
      author: "bot",
      kind: "text",
      text,
      sequence: counter!.sequence,
      status: "queued",
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function send(tenant: TestTenant, conversationId: ConversationId, messageId: MessageId) {
  await h.events.send([
    jobEvent("message.send_requested", sendEventId(messageId), {
      traceId: crypto.randomUUID() as TraceId,
      ...tenant.tenant,
      conversationId,
      messageId,
      channel: "test",
    }),
  ]);
  await h.idle();
}

function status(id: string, value: "sent" | "delivered" | "read" | "failed", at = new Date()) {
  return {
    type: "status" as const,
    messageId: id,
    status: value,
    occurredAt: at.toISOString(),
    error: value === "failed" ? { code: "meta_131026", message: "Undeliverable" } : null,
  };
}

async function row(id: MessageId) {
  const [found] = await h.t.admin.select().from(messages).where(eq(messages.id, id));
  return found!;
}

async function parts(id: MessageId) {
  return h.t.admin
    .select()
    .from(messageParts)
    .where(eq(messageParts.messageId, id))
    .orderBy(messageParts.partIndex);
}

describe("aggregateStatus", () => {
  it("is the lowest status every part reached, failed when one failed", () => {
    expect(aggregateStatus([])).toBeNull();
    expect(aggregateStatus(["read"])).toBe("read");
    expect(aggregateStatus(["read", "delivered"])).toBe("delivered");
    expect(aggregateStatus(["delivered", "sent"])).toBe("sent");
    expect(aggregateStatus(["read", "failed"])).toBe("failed");
  });
});

describe("statuses that arrive before the id is recorded", () => {
  it("holds a status sent while the send run is still going, and applies it when it finishes", async () => {
    const tenant = await h.newTenant();
    currentTenant = tenant;
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "Your estimate is ready.");
    duringSend = async (externalId, target) => {
      // The provider's webhooks overtake our own bookkeeping.
      const response = await h.deliver(target, [status(externalId, "delivered")]);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ statuses: 0 });
    };
    try {
      await send(tenant, conversationId, id);
    } finally {
      duringSend = null;
    }
    const stored = await row(id);
    expect(stored.status).toBe("delivered");
    expect(stored.deliveredAt).not.toBeNull();
    expect((await parts(id)).map((part) => part.status)).toEqual(["delivered"]);
    const held = await h.t.admin
      .select()
      .from(pendingDeliveryStatuses)
      .where(eq(pendingDeliveryStatuses.businessId, tenant.tenant.businessId));
    expect(held).toEqual([]);
  });

  it("never lets a provider failure overtake the run that is sending: it is applied after", async () => {
    const tenant = await h.newTenant();
    currentTenant = tenant;
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "We can come Tuesday.");
    let seenDuringSend: string | null = null;
    duringSend = async (externalId, target) => {
      await h.deliver(target, [status(externalId, "failed")]);
      seenDuringSend = (await row(id)).status;
    };
    try {
      await send(tenant, conversationId, id);
    } finally {
      duringSend = null;
    }
    // While the run was going the message stayed "sending"; the run then recorded "sent" and
    // the provider's verdict came last.
    expect(seenDuringSend).toBe("sending");
    const stored = await row(id);
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("meta_131026");
    expect((await parts(id))[0]?.status).toBe("failed");
  });

  it("holds a status for an id nobody knows, and the sweeper drops it after two days", async () => {
    const tenant = await h.newTenant();
    const response = await h.deliver(tenant, [status("sent-by-another-tool", "read")]);
    expect(response.status).toBe(200);
    const held = () =>
      h.t.admin
        .select()
        .from(pendingDeliveryStatuses)
        .where(eq(pendingDeliveryStatuses.businessId, tenant.tenant.businessId));
    expect((await held()).map((item) => [item.externalMessageId, item.status])).toEqual([
      ["sent-by-another-tool", "read"],
    ]);
    // A redelivery of the same status is held once.
    await h.deliver(tenant, [status("sent-by-another-tool", "read")]);
    expect(await held()).toHaveLength(1);
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    expect(await held()).toHaveLength(1);
    await h.t.admin
      .update(pendingDeliveryStatuses)
      .set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
      .where(eq(pendingDeliveryStatuses.businessId, tenant.tenant.businessId));
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    expect(await held()).toEqual([]);
  });
});

describe("split messages", () => {
  it("records every part and counts each part's statuses", async () => {
    const tenant = await h.newTenant();
    currentTenant = tenant;
    const conversationId = await conversationFor(tenant);
    // Longer than the test channel's 2,000 characters: two provider messages.
    const long = `${"The crew will check the flashing first. ".repeat(40)}\n\n${"Then the decking. ".repeat(40)}`;
    const id = await queue(tenant, conversationId, long);
    await send(tenant, conversationId, id);
    const recorded = await parts(id);
    expect(recorded).toHaveLength(2);
    expect((await row(id)).externalMessageId).toBe(recorded[0]!.externalMessageId);
    const [first, second] = recorded.map((part) => part.externalMessageId);

    await h.deliver(tenant, [status(first!, "delivered")]);
    expect((await row(id)).status).toBe("sent");
    await h.deliver(tenant, [status(second!, "delivered")]);
    expect((await row(id)).status).toBe("delivered");
    await h.deliver(tenant, [status(second!, "read")]);
    expect((await row(id)).status).toBe("delivered");
    await h.deliver(tenant, [status(first!, "read")]);
    expect((await row(id)).status).toBe("read");
    // A late failure never undoes a read.
    await h.deliver(tenant, [status(first!, "failed")]);
    expect((await row(id)).status).toBe("read");
    expect((await parts(id)).map((part) => part.status)).toEqual(["read", "read"]);
    // The send steps' journal is dropped once the parts are recorded.
    expect((await row(id)).payload).not.toHaveProperty("sendJournal");
  });

  it("fails the message when a later part fails before delivery", async () => {
    const tenant = await h.newTenant();
    currentTenant = tenant;
    const conversationId = await conversationFor(tenant);
    const long = `${"Asphalt shingles last about twenty years. ".repeat(40)}\n\n${"Metal lasts longer. ".repeat(40)}`;
    const id = await queue(tenant, conversationId, long);
    await send(tenant, conversationId, id);
    const [first, second] = (await parts(id)).map((part) => part.externalMessageId);
    await h.deliver(tenant, [status(first!, "delivered"), status(second!, "failed")]);
    const stored = await row(id);
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("meta_131026");
  });
});

describe("a send step that runs again", () => {
  it("returns what the provider already accepted instead of sending the part twice", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "See you Tuesday at nine.");
    await h.t.admin.update(messages).set({ status: "sending" }).where(eq(messages.id, id));
    const data = {
      traceId: crypto.randomUUID() as TraceId,
      ...tenant.tenant,
      conversationId,
      messageId: id,
      channel: "test" as const,
    };
    const info: SendTargetInfo = {
      channel: "test",
      connectionId: tenant.connectionId,
      conversationId,
      recipientExternalId: "visitor-1",
      externalThreadId: null,
      replyToExternalMessageId: null,
      window: { open: true, closesAt: null },
      email: null,
      sentByHuman: false,
    };
    const part = { kind: "text" as const, text: "See you Tuesday at nine." };
    const before = sendCalls;

    const first = await sendPart(h.pipeline.context, data, info, part, 0, "run-a");
    expect(first.ok).toBe(true);
    // The step's memoized result was lost and the platform runs it again.
    const again = await sendPart(h.pipeline.context, data, info, part, 0, "run-a");
    expect(again).toEqual(first);
    expect(sendCalls).toBe(before + 1);

    // Another run (the message was queued again) sends it anew.
    const other = await sendPart(h.pipeline.context, data, info, part, 0, "run-b");
    expect(other.ok).toBe(true);
    expect(sendCalls).toBe(before + 2);
  });
});
