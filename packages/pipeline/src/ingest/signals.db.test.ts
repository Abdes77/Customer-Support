import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  alerts,
  and,
  channelConnections,
  conversations,
  conversationTurns,
  deadLetters,
  eq,
  isNull,
  messages,
  sql,
  takeoverLocks,
} from "@repo/db";

import { createLocalJobRunner } from "@repo/jobs";

import { createPipeline } from "../pipeline";
import { createHarness, type Harness, message } from "../testing/harness";
import { nextOutboundStatus } from "./signals";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

const now = () => new Date().toISOString();

describe("nextOutboundStatus", () => {
  it.each([
    ["sent", "delivered", "delivered"],
    ["delivered", "read", "read"],
    ["read", "delivered", null],
    ["delivered", "sent", null],
    ["sent", "failed", "failed"],
    ["sending", "failed", "failed"],
    ["delivered", "failed", null],
    ["superseded", "read", null],
    ["failed", "delivered", null],
    ["received", "read", null],
  ] as const)("%s + %s → %s", (current, update, expected) => {
    expect(nextOutboundStatus(current, update)).toBe(expected);
  });
});

describe("delivery statuses", () => {
  it("move outbound messages forward only", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("hi")]);
    await h.idle();
    const outbound = (await h.messagesOf(tenant)).find((row) => row.direction === "outbound")!;
    const status = (value: "delivered" | "read" | "failed") => ({
      type: "status" as const,
      messageId: outbound.externalMessageId!,
      status: value,
      occurredAt: now(),
    });
    const first = await h.deliver(tenant, [status("read")]);
    expect(first.body).toMatchObject({ statuses: 1 });
    await h.deliver(tenant, [status("delivered"), status("failed")]);
    const [row] = await h.t.admin.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row?.status).toBe("read");
    expect(row?.readAt).not.toBeNull();
  });
});

describe("signals", () => {
  it("stores a reply from the provider inbox and hands the conversation over", async () => {
    // A reply wait long enough that the person surely answers before the bot would.
    const tenant = await h.newTenant({ "conversation.reply_wait_seconds.widget": 2 });
    await h.deliver(tenant, [message("Is anyone there?", { from: "visitor-9" })]);
    await h.idle();
    await h.deliver(tenant, [message("Hello??", { from: "visitor-9" })]);
    // A person answers in the provider's own app before the bot does.
    const response = await h.deliver(tenant, [
      {
        type: "human_reply",
        contactId: "visitor-9",
        messageId: "inbox-reply-1",
        text: "Hi, this is Sam from the office.",
        occurredAt: now(),
      },
    ]);
    expect(response.body).toMatchObject({ signals: 1 });
    // The same reply delivered again is not stored twice.
    await h.deliver(tenant, [
      {
        type: "human_reply",
        contactId: "visitor-9",
        messageId: "inbox-reply-1",
        text: "Hi, this is Sam from the office.",
        occurredAt: now(),
      },
    ]);
    await h.idle();

    const [conversation] = await h.conversationsOf(tenant);
    const rows = await h.messagesOf(tenant);
    expect(rows.filter((row) => row.author === "human_agent").map((row) => row.text)).toEqual([
      "Hi, this is Sam from the office.",
    ]);
    const locks = await h.t.admin
      .select()
      .from(takeoverLocks)
      .where(
        and(eq(takeoverLocks.conversationId, conversation!.id), isNull(takeoverLocks.releasedAt)),
      );
    expect(locks.map((lock) => lock.source)).toEqual(["provider_inbox"]);
    expect(
      h.events
        .named("conversation.takeover_started")
        .filter((event) => event.data.conversationId === conversation!.id),
    ).toHaveLength(1);
    // The bot did not answer the second message: the person did.
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: Is anyone there?"]);
  });

  it("does not take over when the setting is off, but still counts the reply as an answer", async () => {
    const tenant = await h.newTenant({ "handoff.provider_inbox_takeover": false });
    await h.deliver(tenant, [message("Quote please", { from: "visitor-7" })]);
    await h.idle();
    await h.deliver(tenant, [
      {
        type: "human_reply",
        contactId: "visitor-7",
        messageId: "inbox-reply-7",
        text: "Sending one now.",
        occurredAt: now(),
      },
    ]);
    const [conversation] = await h.conversationsOf(tenant);
    const locks = await h.t.admin
      .select()
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, conversation!.id));
    expect(locks).toEqual([]);
    expect(conversation?.handledThroughSeq).toBe(1);
  });

  it("revokes the connection and ignores what arrives for it afterwards", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [{ type: "revoked", reason: "App removed", occurredAt: now() }]);
    const [connection] = await h.t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.businessId, tenant.tenant.businessId));
    expect([connection?.status, connection?.lastError]).toEqual(["revoked", "App removed"]);
    const after = await h.deliver(tenant, [message("still there?")]);
    expect(after.body).toMatchObject({ stored: 0, ignored: 1 });
  });
});

describe("echoes and watermarks (C10)", () => {
  const echo = (
    tenant: { accountId: string },
    id: string,
    text: string | null,
    attribution: "external" | "unverified" = "unverified",
  ) => ({
    messages: [],
    statuses: [],
    signals: [
      {
        type: "human_agent_replied" as const,
        channel: "test" as const,
        externalAccountId: tenant.accountId,
        contactExternalId: "visitor-echo",
        externalMessageId: id,
        text,
        occurredAt: now(),
        attribution,
      },
    ],
  });

  async function humanRows(tenant: Awaited<ReturnType<Harness["newTenant"]>>) {
    return (await h.messagesOf(tenant)).filter((row) => row.author === "human_agent");
  }

  async function activeLocks(conversationId: string) {
    return h.t.admin
      .select()
      .from(takeoverLocks)
      .where(
        and(
          eq(takeoverLocks.conversationId, conversationId as never),
          isNull(takeoverLocks.releasedAt),
        ),
      );
  }

  it("takes an unattributed echo of the bot's own words for ours, and a person's for theirs", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("my gutter is loose", { from: "visitor-echo" })]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    // The echo of the bot's reply arrives before (or without) its provider id being known.
    await h.pipeline.ingest(echo(tenant, "echo-unknown-1", "You said: my gutter is loose"));
    expect(await humanRows(tenant)).toEqual([]);
    expect(await activeLocks(conversation!.id)).toEqual([]);
    // Words the bot never sent: a person replied from the provider's app.
    await h.pipeline.ingest(echo(tenant, "echo-unknown-2", "Hi, Sam here. I can come Tuesday."));
    expect((await humanRows(tenant)).map((row) => row.text)).toEqual([
      "Hi, Sam here. I can come Tuesday.",
    ]);
    expect((await activeLocks(conversation!.id)).map((lock) => lock.source)).toEqual([
      "provider_inbox",
    ]);
  });

  it("takes a person's reply that is only a piece of the bot's message for theirs", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("thanks a lot", { from: "visitor-echo" })]);
    await h.idle();
    // The bot wrote "You said: thanks a lot"; a person answers "thanks a lot" in the inbox.
    await h.pipeline.ingest(echo(tenant, "echo-piece-1", "thanks a lot"));
    expect((await humanRows(tenant)).map((row) => row.text)).toEqual(["thanks a lot"]);
  });

  it("matches an unattributed echo to one part of a split message, and one delivered late", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("tell me everything", { from: "visitor-echo" })]);
    await h.idle();
    const outbound = (await h.messagesOf(tenant)).find((row) => row.direction === "outbound")!;
    const first = "The first paragraph has plenty of words in it. ".repeat(40).trim();
    const second = "The second one follows after a blank line. ".repeat(10).trim();
    // Sent three hours ago; Meta redelivers the echoes of that send only now.
    const sentAt = new Date(Date.now() - 3 * 3_600_000);
    await h.t.admin
      .update(messages)
      .set({ text: `${first}\n\n${second}`, sentAt, createdAt: sentAt })
      .where(eq(messages.id, outbound.id));
    const late = (id: string, text: string) => {
      const body = echo(tenant, id, text);
      body.signals[0]!.occurredAt = new Date(sentAt.getTime() + 2000).toISOString();
      return body;
    };
    await h.pipeline.ingest(late("echo-split-2", second));
    await h.pipeline.ingest(late("echo-split-1", first));
    expect(await humanRows(tenant)).toEqual([]);
  });

  it("never treats an attributed echo as ours by its text", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("hello", { from: "visitor-echo" })]);
    await h.idle();
    await h.pipeline.ingest(echo(tenant, "echo-ext-1", "You said: hello", "external"));
    expect((await humanRows(tenant)).map((row) => row.text)).toEqual(["You said: hello"]);
  });

  it("knows the parts a send step noted in its journal", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("first", { from: "visitor-echo" })]);
    await h.idle();
    const outbound = (await h.messagesOf(tenant)).find((row) => row.direction === "outbound")!;
    await h.t.admin
      .update(messages)
      .set({
        payload: sql`${messages.payload} || ${JSON.stringify({
          sendJournal: {
            "1": { runId: "r", externalMessageId: "journaled-part-2", sentAt: now() },
          },
        })}::jsonb`,
      })
      .where(eq(messages.id, outbound.id));
    await h.pipeline.ingest(echo(tenant, "journaled-part-2", "Some words nobody sent", "external"));
    expect(await humanRows(tenant)).toEqual([]);
  });

  it("applies a read watermark to what was sent before it, and only that", async () => {
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("watermark please", { from: "visitor-echo" })]);
    await h.idle();
    const outbound = (await h.messagesOf(tenant)).find((row) => row.direction === "outbound")!;
    expect(outbound.status).toBe("sent");
    const watermark = (at: Date, status: "delivered" | "read") => ({
      messages: [],
      statuses: [],
      signals: [
        {
          type: "delivery_watermark" as const,
          channel: "test" as const,
          externalAccountId: tenant.accountId,
          contactExternalId: "visitor-echo",
          status,
          watermark: at.toISOString(),
          occurredAt: now(),
        },
      ],
    });
    // Before the message went out: nothing changes.
    await h.pipeline.ingest(watermark(new Date(outbound.sentAt!.getTime() - 60_000), "read"));
    let [row] = await h.t.admin.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row?.status).toBe("sent");
    await h.pipeline.ingest(watermark(new Date(Date.now() + 1000), "delivered"));
    [row] = await h.t.admin.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row?.status).toBe("delivered");
    const result = await h.pipeline.ingest(watermark(new Date(Date.now() + 1000), "read"));
    expect(result.signals).toBe(1);
    [row] = await h.t.admin.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row?.status).toBe("read");
    // Another contact's watermark touches nothing here.
    const other = watermark(new Date(Date.now() + 1000), "read");
    (other.signals[0] as { contactExternalId: string }).contactExternalId = "someone-else";
    expect((await h.pipeline.ingest(other)).signals).toBe(0);
  });
});

describe("sweeper", () => {
  it("re-emits a message whose event was lost, and frees expired leases", async () => {
    const tenant = await h.newTenant();
    h.events.failures = 1;
    expect((await h.deliver(tenant, [message("lost event")])).status).toBe(500);
    const [conversation] = await h.conversationsOf(tenant);
    // Pretend the webhook was long ago and a crashed turn left a lease behind.
    await h.t.admin
      .update(messages)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(messages.conversationId, conversation!.id));
    await h.t.admin.insert(conversationTurns).values({
      id: "0c9f3d1e-52a7-4c1b-9e7a-6f1d2b3c4d5e",
      ...tenant.tenant,
      conversationId: conversation!.id,
      ordinal: 1,
      trigger: "inbound_message",
      runId: "crashed-run",
      traceId: crypto.randomUUID() as never,
      throughSeq: 1,
    });
    await h.t.admin
      .update(conversations)
      .set({
        turnLeaseOwner: "0c9f3d1e-52a7-4c1b-9e7a-6f1d2b3c4d5e",
        turnLeaseExpiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(conversations.id, conversation!.id));

    const swept = await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    expect(swept).toEqual({ reEnqueued: 1, reSent: 0, leasesReleased: 1 });
    await h.idle();
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: lost event"]);
    const turns = await h.t.admin
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, conversation!.id))
      .orderBy(conversationTurns.ordinal);
    expect(turns.map((turn) => [turn.status, turn.errorCode])).toEqual([
      ["failed", "lease_expired"],
      ["replied", null],
    ]);
    // The stuck turn is flagged, not dropped silently.
    const letters = await h.t.admin
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.conversationId, conversation!.id));
    expect(letters.map((letter) => [letter.source, letter.errorCode])).toEqual([
      ["pipeline-sweeper", "lease_expired"],
    ]);
    const raised = await h.t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.conversationId, conversation!.id));
    expect(raised.map((alert) => alert.kind)).toEqual(["turn_failed"]);
    // A second sweep finds nothing to do.
    expect(await h.pipeline.sweep({ ...tenant.tenant, status: "active" })).toEqual({
      reEnqueued: 0,
      reSent: 0,
      leasesReleased: 0,
    });
  });

  it("sweeps the other businesses when one business's sweep fails", async () => {
    const tenant = await h.newTenant();
    h.events.failures = 1;
    expect((await h.deliver(tenant, [message("lost again")])).status).toBe(500);
    const [conversation] = await h.conversationsOf(tenant);
    await h.t.admin
      .update(messages)
      .set({ createdAt: sql`now() - interval '5 minutes'` })
      .where(eq(messages.conversationId, conversation!.id));
    // A business listed before it whose sweep throws (it is not in the agency it claims).
    const other = await h.newTenant();
    const broken = {
      agencyId: crypto.randomUUID() as never,
      businessId: other.tenant.businessId,
      status: "active" as const,
    };
    const db = {
      ...h.t.db,
      directory: {
        ...h.t.db.directory,
        listBusinesses: async () => [broken, { ...tenant.tenant, status: "active" as const }],
      },
    };
    const runner = createLocalJobRunner({ retryDelayMs: () => 5 });
    const { adapters, engine, storage, logger, options } = h.pipeline.context;
    const pipeline = createPipeline({
      db,
      adapters,
      engine,
      storage,
      logger,
      options,
      events: h.events,
    });
    runner.register(pipeline.jobs());
    await runner.runCron("pipeline-sweeper");
    expect(runner.history.at(-1)).toMatchObject({
      functionId: "pipeline-sweeper",
      status: "completed",
    });
    await h.idle();
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: lost again"]);
  });

  it("runs as a cron job over every business", async () => {
    await h.runner.runCron("pipeline-sweeper");
    const last = h.runner.history.filter((run) => run.functionId === "pipeline-sweeper").at(-1);
    expect(last?.status).toBe("completed");
  });
});
