import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedInboundMessage } from "@repo/core";
import { channelConnections, eq, messages } from "@repo/db";

import { enqueueBotMessage } from "../outbound";
import { createHarness, type Harness, type TestTenant } from "../testing/harness";

/*
 * `channels.meta.reactions` = "treat_as_reply" (C17: the option existed and did nothing).
 */
let h: Harness;

afterEach(async () => {
  await h.dispose();
});

const PAGE = "page-1";

function messengerMessage(overrides: Partial<NormalizedInboundMessage>): NormalizedInboundMessage {
  return {
    channel: "messenger",
    externalAccountId: PAGE,
    externalMessageId: `mid.${randomUUID()}`,
    externalThreadId: null,
    sender: { externalId: "psid-1", displayName: "Pat", phone: null, email: null },
    sentAt: new Date().toISOString(),
    kind: "text",
    text: "Hi, my AC stopped working",
    attachments: [],
    location: null,
    interactiveReply: null,
    reaction: null,
    replyToExternalMessageId: null,
    email: null,
    metadata: {},
    ...overrides,
  };
}

async function setup(setting: "ignore" | "treat_as_reply", botText: string) {
  h = await createHarness({ runJobs: false });
  const tenant: TestTenant = await h.newTenant({ "channels.meta.reactions": setting });
  await h.t.admin.insert(channelConnections).values({
    ...tenant.tenant,
    channel: "messenger",
    externalAccountId: PAGE,
    status: "active",
  });
  await h.pipeline.ingest({ messages: [messengerMessage({})], statuses: [], signals: [] });
  const [conversation] = (await h.conversationsOf(tenant)).filter(
    (row) => row.channel === "messenger",
  );
  // The bot's question, as the send step leaves it: sent, with its provider id.
  const queued = await h.t.db.forBusiness(tenant.tenant.businessId).run((ctx) =>
    enqueueBotMessage(ctx, {
      conversationId: conversation!.id,
      text: botText,
      traceId: randomUUID(),
      purpose: "test",
    }),
  );
  const providerId = `mid.bot-${randomUUID()}`;
  await h.t.admin
    .update(messages)
    .set({ status: "sent", externalMessageId: providerId })
    .where(eq(messages.id, queued!.messageId as never));
  return { tenant, providerId };
}

const reaction = (target: string, emoji = "👍", removed = false) =>
  messengerMessage({
    kind: "reaction",
    text: null,
    reaction: { targetExternalMessageId: target, emoji, removed },
  });

async function lastInbound(tenant: TestTenant) {
  const rows = (await h.messagesOf(tenant)).filter((row) => row.direction === "inbound");
  return rows.at(-1)!;
}

describe("reactions as replies", () => {
  it("answers a thumbs-up on the bot's question as the customer's yes", async () => {
    const { tenant, providerId } = await setup("treat_as_reply", "Are you the homeowner?");
    const before = h.events.named("message.received").length;
    await h.pipeline.ingest({ messages: [reaction(providerId)], statuses: [], signals: [] });
    const stored = await lastInbound(tenant);
    expect(stored).toMatchObject({ kind: "text", text: "👍" });
    expect(stored.payload).toMatchObject({ reactionAsAnswer: true, reaction: { emoji: "👍" } });
    // It starts a turn like any message.
    expect(h.events.named("message.received").length).toBe(before + 1);
  });

  it("keeps a reaction a reaction when the setting is off, the message asked nothing, the emoji is not a yes, or it was removed", async () => {
    const cases: [Parameters<typeof setup>[0], string, ReturnType<typeof reaction> | null][] = [
      ["ignore", "Are you the homeowner?", null],
      ["treat_as_reply", "Thanks, we will be in touch.", null],
    ];
    for (const [setting, text] of cases) {
      const { tenant, providerId } = await setup(setting, text);
      const before = h.events.named("message.received").length;
      await h.pipeline.ingest({ messages: [reaction(providerId)], statuses: [], signals: [] });
      expect((await lastInbound(tenant)).kind).toBe("reaction");
      expect(h.events.named("message.received").length).toBe(before);
      await h.dispose();
    }
    const { tenant, providerId } = await setup("treat_as_reply", "Are you the homeowner?");
    await h.pipeline.ingest({
      messages: [
        reaction(providerId, "😡"),
        reaction(providerId, "👍", true),
        reaction("mid.other"),
      ],
      statuses: [],
      signals: [],
    });
    const rows = (await h.messagesOf(tenant)).filter((row) => row.direction === "inbound");
    expect(rows.slice(-3).map((row) => row.kind)).toEqual(["reaction", "reaction", "reaction"]);
  });
});
