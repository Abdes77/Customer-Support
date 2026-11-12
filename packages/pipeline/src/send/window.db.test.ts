import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CHANNEL_CAPABILITIES,
  type ConversationId,
  type MessageId,
  type TraceId,
  type WindowFallbackRequest,
  type WindowFallbackResult,
} from "@repo/core";
import { conversations, deadLetters, eq, messages, sql } from "@repo/db";
import { jobEvent } from "@repo/jobs";

import { sendEventId } from "../event-ids";
import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";

/*
 * Invariant I6 and the template fallback, on a test channel given WhatsApp's window rule
 * (24 hours, then templates only). The channel's own fallback is a stub here; the real
 * WhatsApp one is tested in @repo/channel-whatsapp and end to end in apps/web.
 */

let h: Harness;
let fallback: ((request: WindowFallbackRequest) => WindowFallbackResult) | null = null;
const asked: WindowFallbackRequest[] = [];

const TEMPLATE: WindowFallbackResult = {
  kind: "template",
  message: {
    kind: "template",
    templateName: "follow_up_check_in",
    languageCode: "en_US",
    variables: [],
    namedVariables: { first_name: "Pat" },
  },
  renderedText:
    "Hi Pat, just checking in about your roof. Reply here to pick up where we left off.",
};

beforeAll(async () => {
  h = await createHarness({
    wrapAdapter: (adapter) => ({
      ...adapter,
      send: adapter.send.bind(adapter),
      capabilities: {
        ...CHANNEL_CAPABILITIES.test,
        messagingWindow: CHANNEL_CAPABILITIES.whatsapp.messagingWindow,
      },
    }),
    windowFallbacks: [
      {
        channel: "test",
        resolve: async (request) => {
          asked.push(request);
          return fallback?.(request) ?? { kind: "none", reason: "no_template_configured" };
        },
      },
    ],
  });
});

afterAll(async () => {
  await h?.dispose();
});

async function conversationFor(tenant: TestTenant, hoursAgo: number): Promise<ConversationId> {
  await h.deliver(tenant, [message("hello")]);
  await h.idle();
  const [conversation] = await h.conversationsOf(tenant);
  await h.t.admin
    .update(conversations)
    .set({ lastInboundAt: new Date(Date.now() - hoursAgo * 3600 * 1000) })
    .where(eq(conversations.id, conversation!.id));
  return conversation!.id;
}

async function queue(
  tenant: TestTenant,
  conversationId: ConversationId,
  text: string,
  author: "bot" | "human_agent" = "bot",
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
      author,
      kind: "text",
      text,
      sequence: counter!.sequence,
      status: "queued",
    })
    .returning({ id: messages.id });
  await h.events.send([
    jobEvent("message.send_requested", sendEventId(row!.id), {
      traceId: crypto.randomUUID() as TraceId,
      ...tenant.tenant,
      conversationId,
      messageId: row!.id,
      channel: "test",
    }),
  ]);
  await h.idle();
  return row!.id;
}

async function row(id: MessageId) {
  const [found] = await h.t.admin.select().from(messages).where(eq(messages.id, id));
  return found!;
}

describe("messaging window (I6)", () => {
  it("sends free-form text inside the 24 hours", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 23);
    const before = asked.length;
    const id = await queue(tenant, conversationId, "Still there?");
    expect((await row(id)).status).toBe("sent");
    expect(h.transport.textsFor(conversationId).at(-1)).toBe("Still there?");
    expect(asked.length).toBe(before);
  });

  it("never sends free-form text after 24 hours: without a template the message fails", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 25);
    fallback = null;
    const sentBefore = h.transport.deliveries.length;
    const id = await queue(tenant, conversationId, "Still there?");
    const stored = await row(id);
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("window_closed");
    expect(h.transport.deliveries.length).toBe(sentBefore);
    const letters = await h.t.admin.select().from(deadLetters).where(eq(deadLetters.messageId, id));
    expect(letters).toHaveLength(1);
    expect(asked.at(-1)).toMatchObject({ messageId: id, author: "bot", conversationId });
  });

  it("replaces the message with the approved template the channel names, and records it", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 30);
    fallback = () => TEMPLATE;
    const id = await queue(tenant, conversationId, "Hi Pat, any news on the roof?");
    fallback = null;
    const stored = await row(id);
    expect(stored.status).toBe("sent");
    expect(stored.kind).toBe("template");
    expect(stored.text).toBe(
      "Hi Pat, just checking in about your roof. Reply here to pick up where we left off.",
    );
    expect(stored.payload).toMatchObject({
      template: {
        templateName: "follow_up_check_in",
        languageCode: "en_US",
        namedVariables: { first_name: "Pat" },
      },
      windowFallback: { originalKind: "text", originalText: "Hi Pat, any news on the roof?" },
    });
    const delivered = h.transport.deliveries.at(-1)!;
    expect(delivered.conversationId).toBe(conversationId);
    expect(delivered.message).toEqual(TEMPLATE.message);
  });

  it("asks for a template for a person's reply too, saying who wrote it", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 48);
    fallback = (request) =>
      request.author === "human_agent" ? TEMPLATE : { kind: "none", reason: "bot" };
    const id = await queue(tenant, conversationId, "Sorry for the delay!", "human_agent");
    fallback = null;
    expect((await row(id)).status).toBe("sent");
    expect(asked.at(-1)).toMatchObject({ messageId: id, author: "human_agent" });
  });

  it("checks the window again when sending: a window about to close takes the template", async () => {
    const tenant = await h.newTenant();
    // Open when the send is prepared, but closing within the send margin.
    const conversationId = await conversationFor(tenant, 24 - 30 / 3600);
    fallback = () => TEMPLATE;
    const sentBefore = h.transport.deliveries.length;
    const id = await queue(tenant, conversationId, "Did the photos come through?");
    fallback = null;
    const stored = await row(id);
    expect(stored.status).toBe("sent");
    expect(stored.kind).toBe("template");
    expect(h.transport.deliveries.length).toBe(sentBefore + 1);
    expect(h.transport.deliveries.at(-1)!.message).toEqual(TEMPLATE.message);
  });

  it("checks the window again when sending: without a template nothing free-form goes out", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 24 - 30 / 3600);
    fallback = null;
    const sentBefore = h.transport.deliveries.length;
    const id = await queue(tenant, conversationId, "Did the photos come through?");
    const stored = await row(id);
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("window_closed");
    expect(h.transport.deliveries.length).toBe(sentBefore);
  });

  it("falls back once when the provider says the window closed although we thought it open", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 2);
    h.transport.failNext(1, {
      code: "meta_131047",
      message: "Re-engagement message",
      retryable: false,
      windowClosed: true,
    });
    fallback = () => TEMPLATE;
    const id = await queue(tenant, conversationId, "One more question about the gutters");
    fallback = null;
    const stored = await row(id);
    expect(stored.status).toBe("sent");
    expect(stored.kind).toBe("template");
    expect(h.transport.deliveries.at(-1)!.message).toEqual(TEMPLATE.message);
  });

  it("fails when the provider refuses for the window and no template exists", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant, 2);
    h.transport.failNext(1, {
      code: "meta_131047",
      message: "Re-engagement message",
      retryable: false,
      windowClosed: true,
    });
    const id = await queue(tenant, conversationId, "Hello again");
    const stored = await row(id);
    expect(stored.status).toBe("failed");
    expect(stored.errorCode).toBe("window_closed");
  });
});
