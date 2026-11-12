import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineTurnInput, EngineTurnResult } from "@repo/core";
import {
  and,
  businesses,
  contacts,
  conversations,
  conversationTurns,
  deadLetters,
  eq,
  isNull,
  takeoverLocks,
} from "@repo/db";

import { createEchoEngine } from "../echo-engine";
import {
  createHarness,
  type Harness,
  message,
  pendingTexts,
  reply,
  result,
} from "../testing/harness";
import { claimTurn, planTurn } from "./claim";

let h: Harness;
const echo = createEchoEngine();

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

function useEngine(respond: (input: EngineTurnInput) => Promise<EngineTurnResult>) {
  h.engine.respond = (input) => respond(input);
}

function useEcho() {
  h.engine.respond = (input, ports) => echo.respond(input, ports);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function turnsOf(conversationId: string) {
  return h.t.admin
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversationId as never))
    .orderBy(conversationTurns.ordinal);
}

describe("debounce (I3)", () => {
  it("answers several quick messages with one reply, each message restarting the wait", async () => {
    useEngine(async (input) => reply(`Got: ${pendingTexts(input)}`));
    const tenant = await h.newTenant({ "conversation.reply_wait_seconds.widget": 3 });
    // Five messages 0.9 s apart: together they span longer than the 3 s wait, but each one
    // arrives well before the wait after the previous one runs out (2 s of slack for a slow
    // machine).
    const texts = ["Hi", "my roof leaks", "near the chimney", "since the storm", "can you help?"];
    for (const [index, text] of texts.entries()) {
      if (index > 0) await sleep(900);
      await h.deliver(tenant, [message(text)]);
    }
    await h.idle();

    const [conversation] = await h.conversationsOf(tenant);
    expect(h.transport.textsFor(conversation!.id)).toEqual([`Got: ${texts.join(" + ")}`]);
    const turns = await turnsOf(conversation!.id);
    expect(turns.map((turn) => [turn.status, turn.pendingCount])).toEqual([["replied", 5]]);
    expect(conversation?.handledThroughSeq).toBe(5);
    // Runs for the earlier messages gave way to the newer ones instead of answering.
    const runs = h.runner.history.filter(
      (run) => run.functionId === "pipeline-reply" && run.eventId !== null,
    );
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });

  it("answers at the longest wait even when the customer keeps typing", async () => {
    useEngine(async (input) => reply(`Got: ${pendingTexts(input)}`));
    const tenant = await h.newTenant({
      "conversation.reply_wait_seconds.widget": 2,
      "conversation.max_wait_seconds": 5,
    });
    // A message every 0.6 s for about 6 s: the reply wait never runs out, the longest wait does.
    for (let index = 1; index <= 10; index += 1) {
      await h.deliver(tenant, [message(`part ${index}`)]);
      await sleep(600);
    }
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    const texts = h.transport.textsFor(conversation!.id);
    // Answered before the customer stopped (the longest wait), and in few replies.
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(texts.length).toBeLessThanOrEqual(5);
    // Every message is answered exactly once, in order.
    const answered = texts.flatMap((text) => text.replace("Got: ", "").split(" + "));
    expect(answered).toEqual(Array.from({ length: 10 }, (_unused, index) => `part ${index + 1}`));
  }, 30_000);

  it("starts a new turn for a message that comes after the reply", async () => {
    useEcho();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("first")]);
    await h.idle();
    await h.deliver(tenant, [message("second")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: first", "You said: second"]);
    const turns = await turnsOf(conversation!.id);
    expect(turns.map((turn) => [turn.ordinal, turn.status, turn.throughSeq])).toEqual([
      [1, "replied", 1],
      [2, "replied", 3],
    ]);
  });
});

describe("turn lease and order (I4)", () => {
  it("lets exactly one claim take the turn lease", async () => {
    useEcho();
    const tenant = await h.newTenant();
    h.events.failures = 0;
    // Store a message without letting the runner answer it.
    const stopped = h.runner;
    await h.deliver(tenant, [message("lease me")]);
    await stopped.idle();
    const [conversation] = await h.conversationsOf(tenant);
    // A fresh message to claim for.
    await h.t.admin
      .update(conversations)
      .set({ handledThroughSeq: 0, turnLeaseOwner: null, turnLeaseExpiresAt: null })
      .where(eq(conversations.id, conversation!.id));
    const [inbound] = (await h.messagesOf(tenant)).filter((row) => row.direction === "inbound");
    const data = {
      traceId: inbound!.traceId,
      agencyId: tenant.tenant.agencyId,
      businessId: tenant.tenant.businessId,
      conversationId: conversation!.id,
      messageId: inbound!.id,
      channel: "test" as const,
      receivedAt: inbound!.createdAt.toISOString(),
    };
    const p = h.pipeline.context;
    const claims = await Promise.all(
      [1, 2, 3, 4, 5].map(async (index) => {
        const plan = await h.t.db
          .forBusiness(tenant.tenant.businessId)
          .run((ctx) => planTurn(ctx, p, data));
        if (plan.kind !== "wait") throw new Error("expected a plan");
        return h.t.db
          .forBusiness(tenant.tenant.businessId)
          .run((ctx) => claimTurn(ctx, p, data, plan, `run-${index}`));
      }),
    );
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "busy")).toHaveLength(4);
  });

  it("sends a turn's replies in order, part by part", async () => {
    useEngine(async () =>
      result([
        { kind: "text", text: "First, thanks for the details." },
        { kind: "text", text: `Second: ${"long sentence here. ".repeat(150)}` },
        {
          kind: "text",
          text: "Third: when works for a visit?",
          quickReplies: ["Today", "Tomorrow"],
        },
      ]),
    );
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("Need a roof inspection")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    const delivered = h.transport.deliveries.filter(
      (delivery) => delivery.conversationId === conversation!.id,
    );
    const texts = delivered.map((delivery) =>
      delivery.message.kind === "text" ? delivery.message.text : "",
    );
    expect(texts[0]).toBe("First, thanks for the details.");
    expect(texts.at(-1)).toBe("Third: when works for a visit?");
    // The 3,000-character draft was split at the test channel's 2,000 characters.
    expect(texts.length).toBe(4);
    expect(texts.every((text) => text.length <= 2000)).toBe(true);
    expect(delivered.at(-1)?.message).toMatchObject({ quickReplies: ["Today", "Tomorrow"] });
    const outbound = (await h.messagesOf(tenant)).filter((row) => row.direction === "outbound");
    expect(outbound.map((row) => [row.sequence, row.status])).toEqual([
      [2, "sent"],
      [3, "sent"],
      [4, "sent"],
    ]);
    expect(
      (outbound[1]?.payload as { delivery?: { parts?: string[] } }).delivery?.parts,
    ).toHaveLength(2);
  });
});

describe("stale check", () => {
  it("supersedes a draft once when the customer writes during generation, never twice in a row", async () => {
    const gates: (() => void)[] = [];
    const started: string[] = [];
    const histories: string[][] = [];
    useEngine(async (input) => {
      const texts = pendingTexts(input);
      started.push(texts);
      histories.push(input.history.map((turn) => `${turn.author}: ${turn.text ?? ""}`));
      if (started.length <= 2) await new Promise<void>((resolve) => gates.push(resolve));
      return reply(`Answer to: ${texts}`);
    });
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("one")]);
    while (started.length < 1) await sleep(20);
    // While the first turn is writing, the customer writes again.
    await h.deliver(tenant, [message("two")]);
    gates.shift()?.();
    while (started.length < 2) await sleep(20);
    // And again while the second turn writes: this time the draft goes out regardless.
    await h.deliver(tenant, [message("three")]);
    gates.shift()?.();
    await h.idle();

    const [conversation] = await h.conversationsOf(tenant);
    expect(started).toEqual(["one", "one + two", "three"]);
    expect(h.transport.textsFor(conversation!.id)).toEqual([
      "Answer to: one + two",
      "Answer to: three",
    ]);
    const turns = await turnsOf(conversation!.id);
    expect(turns.map((turn) => turn.status)).toEqual(["superseded", "replied", "replied"]);
    const superseded = (await h.messagesOf(tenant)).filter((row) => row.status === "superseded");
    expect(superseded.map((row) => [row.text, row.errorCode])).toEqual([
      ["Answer to: one", "newer_message"],
    ]);
    // The last turn sees the reply that went out, although it is numbered after "three",
    // and never the superseded draft.
    expect(histories[2]).toEqual(["customer: one", "customer: two", "bot: Answer to: one + two"]);
  });
});

describe("guards", () => {
  it("stays silent while a person holds the conversation (I5)", async () => {
    useEcho();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("hello")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    await h.t.admin.insert(takeoverLocks).values({
      ...tenant.tenant,
      conversationId: conversation!.id,
      source: "admin_panel",
    });
    await h.deliver(tenant, [message("are you there?")]);
    await h.idle();
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: hello"]);
    const turns = await turnsOf(conversation!.id);
    expect(turns.map((turn) => [turn.status, turn.skipReason])).toEqual([
      ["replied", null],
      ["skipped", "takeover"],
    ]);
    // The message the person saw is handled; after release the bot does not answer it.
    const [after] = await h.conversationsOf(tenant);
    expect(after?.handledThroughSeq).toBe(3);
    expect(after?.turnLeaseOwner).toBeNull();
  });

  it("stays silent for a customer who opted out, and for a paused business", async () => {
    useEcho();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("first")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    await h.t.admin
      .update(contacts)
      .set({ optedOutAt: new Date() })
      .where(eq(contacts.id, conversation!.contactId));
    await h.deliver(tenant, [message("stop texting me")]);
    await h.idle();
    const turns = await turnsOf(conversation!.id);
    expect(turns.at(-1)?.skipReason).toBe("opted_out");
    expect(h.transport.textsFor(conversation!.id)).toEqual(["You said: first"]);

    const paused = await h.newTenant();
    await h.t.admin
      .update(businesses)
      .set({ status: "paused" })
      .where(eq(businesses.id, paused.tenant.businessId));
    await h.deliver(paused, [message("hello?")]);
    await h.idle();
    const [pausedConversation] = await h.conversationsOf(paused);
    expect((await turnsOf(pausedConversation!.id)).map((turn) => turn.skipReason)).toEqual([
      "business_inactive",
    ]);
    expect(h.transport.textsFor(pausedConversation!.id)).toEqual([]);
  });

  it("runs guards registered by other chunks", async () => {
    const guarded = await createHarness({
      guards: [{ name: "limits", check: async () => "rate_limited" }],
    });
    try {
      const tenant = await guarded.newTenant();
      await guarded.deliver(tenant, [message("hi")]);
      await guarded.idle();
      const [conversation] = await guarded.conversationsOf(tenant);
      const turns = await guarded.t.admin
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.conversationId, conversation!.id));
      expect(turns.map((turn) => turn.skipReason)).toEqual(["limits:rate_limited"]);
      expect(guarded.transport.deliveries).toEqual([]);
    } finally {
      await guarded.dispose();
    }
  });
});

describe("engine outcomes", () => {
  it("hands the conversation to a person when the model refuses", async () => {
    useEngine(async () => result([], { outcome: "refused" }));
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("something the model will not answer")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    const locks = await h.t.admin
      .select()
      .from(takeoverLocks)
      .where(
        and(eq(takeoverLocks.conversationId, conversation!.id), isNull(takeoverLocks.releasedAt)),
      );
    expect(locks.map((lock) => lock.source)).toEqual(["rule"]);
    expect(
      h.events
        .named("conversation.takeover_started")
        .some((event) => event.data.conversationId === conversation!.id),
    ).toBe(true);
    expect((await turnsOf(conversation!.id)).map((turn) => turn.status)).toEqual(["refused"]);
  });

  it("records nothing to send when the engine stays silent", async () => {
    useEngine(async () => result([]));
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("spam spam spam")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    expect((await turnsOf(conversation!.id)).map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(conversation?.handledThroughSeq).toBe(1);
    expect(h.transport.textsFor(conversation!.id)).toEqual([]);
  });

  it("frees the conversation and leaves a dead letter when the turn fails for good", async () => {
    let calls = 0;
    useEngine(async () => {
      calls += 1;
      throw new Error("model unavailable");
    });
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("hello?")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    expect(calls).toBe(3); // first attempt plus two retries
    expect(conversation?.turnLeaseOwner).toBeNull();
    expect(conversation?.handledThroughSeq).toBe(0);
    expect((await turnsOf(conversation!.id)).map((turn) => turn.status)).toEqual(["failed"]);
    const letters = await h.t.admin
      .select()
      .from(deadLetters)
      .where(eq(deadLetters.conversationId, conversation!.id));
    expect(letters.map((letter) => [letter.source, letter.errorMessage])).toEqual([
      ["pipeline-reply", "model unavailable"],
    ]);

    // The next message is answered at once, together with the unanswered one.
    useEngine(async (input) => reply(`Got: ${pendingTexts(input)}`));
    await h.deliver(tenant, [message("anyone?")]);
    await h.idle();
    expect(h.transport.textsFor(conversation!.id)).toEqual(["Got: hello? + anyone?"]);
  });

  it("passes the engine the history, the pending messages and the channel", async () => {
    const inputs: EngineTurnInput[] = [];
    useEngine(async (input) => {
      inputs.push(input);
      return reply(`Reply ${inputs.length}`);
    });
    const tenant = await h.newTenant({ "limits.max_inbound_characters": 500 });
    await h.deliver(tenant, [message("first question")]);
    await h.idle();
    await h.deliver(tenant, [message(`second ${"x".repeat(600)}`)]);
    await h.idle();
    const second = inputs[1]!;
    expect(second.history.map((turn) => [turn.author, turn.text])).toEqual([
      ["customer", "first question"],
      ["bot", "Reply 1"],
    ]);
    expect(second.pending).toHaveLength(1);
    expect(second.pending[0]?.text).toHaveLength(500);
    expect(second.channel.id).toBe("test");
    expect(second.business.segment.slug).toBe("roofing");
    expect(second.mode).toBe("live");
    // The first turn left a scored lead behind (C5), with nothing recorded yet.
    expect(second.lead).toMatchObject({ status: "new", fields: {}, routing: null });
    expect(second.lead.id).not.toBeNull();
    expect(second.settings.values["limits.max_inbound_characters"]).toBe(500);
  });
});
