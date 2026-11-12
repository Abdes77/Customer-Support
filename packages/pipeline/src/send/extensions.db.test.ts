import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationId, MessageId, TraceId } from "@repo/core";
import { conversations, deadLetters, eq, messages, sql, takeoverLocks } from "@repo/db";
import { jobEvent } from "@repo/jobs";

import type { OutboundComposer, SendThrottle } from "../deps";
import { sendEventId } from "../event-ids";
import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";

/*
 * The send step's channel extension points added for email (C11): a composer that turns the
 * stored text into what the channel sends, and a throttle that holds a send back while the
 * account is at its limit. Exercised here on the test channel.
 */

const throttleCalls: { author: string }[] = [];
let refusals = 0;
const throttle: SendThrottle = {
  channel: "test",
  async acquire(_ctx, input) {
    throttleCalls.push({ author: input.author });
    if (refusals > 0) {
      refusals -= 1;
      return { ok: false, retryAfterSeconds: 1, reason: "hourly_limit" };
    }
    return { ok: true };
  },
};
const composed: { subject: string; author: string }[] = [];
const composer: OutboundComposer = {
  channel: "test",
  async compose(_ctx, input) {
    composed.push({ subject: input.subject, author: input.author });
    return {
      kind: "email",
      subject: input.subject,
      text: `${input.text}\n\n-- signed`,
      html: "<div>x</div>",
      cc: [],
      fromName: "Sam",
    };
  },
};

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ sendThrottles: [throttle], outboundComposers: [composer] });
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

function sendEvent(tenant: TestTenant, conversationId: ConversationId, messageId: MessageId) {
  return jobEvent("message.send_requested", sendEventId(messageId), {
    traceId: crypto.randomUUID() as TraceId,
    ...tenant.tenant,
    conversationId,
    messageId,
    channel: "test",
  });
}

describe("outbound composer", () => {
  it("lets the channel turn a stored text into the message it sends", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "composed please");
    await h.events.send([sendEvent(tenant, conversationId, id)]);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toContain("composed please\n\n-- signed");
    expect(composed.at(-1)).toEqual({ subject: "", author: "bot" });
  });
});

describe("send throttle", () => {
  it("waits while the account is at its limit, then sends once", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "held back once");
    const attempts = h.transport.attempts;
    const calls = throttleCalls.length;
    refusals = 1;
    await h.events.send([sendEvent(tenant, conversationId, id)]);
    await h.idle();
    expect(throttleCalls.length - calls).toBe(2);
    expect(h.transport.attempts - attempts).toBe(1);
    const [row] = await h.t.admin.select().from(messages).where(eq(messages.id, id));
    expect(row?.status).toBe("sent");
  });

  it("fails the message when the limit outlasts the retries, never silently (I7)", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const id = await queue(tenant, conversationId, "never allowed");
    const attempts = h.transport.attempts;
    refusals = 10;
    await h.events.send([sendEvent(tenant, conversationId, id)]);
    await h.idle();
    refusals = 0;
    expect(h.transport.attempts - attempts).toBe(0);
    const [row] = await h.t.admin.select().from(messages).where(eq(messages.id, id));
    expect(row?.status).toBe("failed");
    expect(
      await h.t.admin.select().from(deadLetters).where(eq(deadLetters.messageId, id)),
    ).toHaveLength(1);
  });
});

describe("takeover exemption (C13 review)", () => {
  async function lockWithExemption(
    tenant: TestTenant,
    conversationId: ConversationId,
    throughSeq: number,
  ) {
    await h.t.admin.insert(takeoverLocks).values({
      ...tenant.tenant,
      conversationId,
      source: "rule",
      reason: "The bot handed the conversation to a person.",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      exemptThroughSeq: throughSeq,
    });
  }

  it("lets the bot's handoff message out, unless the person has written after it", async () => {
    const tenant = await h.newTenant();
    const conversationId = await conversationFor(tenant);
    const handoff = await queue(tenant, conversationId, "A member of the team will pick up here.");
    const [row] = await h.t.admin.select().from(messages).where(eq(messages.id, handoff));
    await lockWithExemption(tenant, conversationId, row!.sequence);
    await h.events.send([sendEvent(tenant, conversationId, handoff)]);
    await h.idle();
    // (The harness's composer signs every text.)
    expect(
      h.transport
        .textsFor(conversationId)
        .some((text) => text.startsWith("A member of the team will pick up here.")),
    ).toBe(true);

    // Another conversation: the handoff message was held, and the person replied first.
    const other = await h.newTenant();
    const second = await conversationFor(other);
    const stale = await queue(other, second, "A member of the team will pick up here.");
    const [staleRow] = await h.t.admin.select().from(messages).where(eq(messages.id, stale));
    await lockWithExemption(other, second, staleRow!.sequence);
    const [counter] = await h.t.admin
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, second))
      .returning({ sequence: conversations.messageSeq });
    await h.t.admin.insert(messages).values({
      ...other.tenant,
      conversationId: second,
      channelConnectionId: other.connectionId as never,
      direction: "outbound",
      author: "human_agent",
      kind: "text",
      text: "Hi, this is Sam from the office.",
      sequence: counter!.sequence,
      status: "sent",
    });
    await h.events.send([sendEvent(other, second, stale)]);
    await h.idle();
    const [after] = await h.t.admin.select().from(messages).where(eq(messages.id, stale));
    expect(after).toMatchObject({ status: "superseded", errorCode: "takeover" });
  });
});
