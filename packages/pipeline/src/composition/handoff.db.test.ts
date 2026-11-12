import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ConversationId,
  EngineAction,
  EngineTurnInput,
  ExecutedAction,
  ToolExecutionContext,
  TraceId,
} from "@repo/core";
import {
  alerts,
  contacts,
  conversations,
  conversationTurns,
  eq,
  escalations,
  messages,
  scheduledJobs,
  takeoverLocks,
} from "@repo/db";
import { OPTED_OUT_NOTICE, releaseTakeover, startTakeover } from "@repo/handoff";
import { jobEvent } from "@repo/jobs";
import { loadSettings } from "@repo/settings/server";

import { enqueueBotMessage, enqueueHumanMessage } from "../outbound";
import { sendEventId } from "../event-ids";
import {
  createHarness,
  type Harness,
  message,
  pendingTexts,
  reply,
  result,
  type TestTenant,
} from "../testing/harness";
import type { SendGate } from "../deps";

/**
 * C13 through the pipeline: a takeover pauses the bot (I5) and its release gives the
 * conversation back; the bot's own handoff message goes out and nothing after it; an opt-out
 * word is confirmed once and silences every automated message; a follow-up is a turn of the
 * pipeline (trigger `follow_up`), planned after a reply; a send gate's hold lets a person's
 * message pass the held one.
 */

/** Holds each bot message once, for a moment, so the test can send a person's reply past it. */
const heldOnce = new Set<string>();
const testGate: SendGate = {
  name: "test_hold",
  check: (_ctx, message) => {
    if (message.payload["purpose"] !== "held_for_test" || heldOnce.has(message.messageId)) {
      return Promise.resolve({ kind: "send" });
    }
    heldOnce.add(message.messageId);
    return Promise.resolve({
      kind: "hold",
      until: new Date(Date.now() + 400).toISOString(),
      reason: "test",
    });
  },
};

let h: Harness;
const triggers: string[] = [];

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.dispose();
});

function context(input: EngineTurnInput, toolCallId: string): ToolExecutionContext {
  return {
    trace: input.trace,
    mode: input.mode,
    toolCallId,
    now: input.now,
    settings: input.settings,
    channel: input.channel,
    business: input.business,
  };
}

function echoWithTrigger(): void {
  h.engine.respond = async (input) => {
    triggers.push(input.trigger);
    if (input.trigger === "follow_up") return reply("Still thinking about that water heater?");
    return reply(`You said: ${pendingTexts(input)}`);
  };
}

async function conversationOf(tenant: TestTenant): Promise<ConversationId> {
  const [conversation] = await h.conversationsOf(tenant);
  return conversation!.id;
}

async function turnsOf(conversationId: ConversationId) {
  return turnsIn(h, conversationId);
}

async function turnsIn(g: Harness, conversationId: ConversationId) {
  return g.t.admin
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, conversationId))
    .orderBy(conversationTurns.ordinal);
}

describe("takeover through the pipeline", () => {
  it("keeps the bot silent while a person holds the conversation and resumes after the release", async () => {
    echoWithTrigger();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("Hello")]);
    await h.idle();
    const conversationId = await conversationOf(tenant);
    const scope = h.t.db.forBusiness(tenant.tenant.businessId, {
      agencyId: tenant.tenant.agencyId,
    });
    await scope.run((ctx) =>
      startTakeover(ctx, {
        conversationId,
        source: "admin_panel",
        userId: null,
        reason: "test",
        traceId: "0e000000-0000-4000-8000-0000000000e1",
        now: new Date(),
      }),
    );
    await h.deliver(tenant, [message("Is anyone there?")]);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toEqual(["You said: Hello"]);
    expect((await turnsOf(conversationId)).at(-1)).toMatchObject({
      status: "skipped",
      skipReason: "takeover",
    });
    // A person's reply goes out under the lock.
    const queued = await scope.run(async (ctx) =>
      enqueueHumanMessage(ctx, {
        conversationId,
        text: "Hi, this is Sam.",
        traceId: "0e000000-0000-4000-8000-0000000000e2",
        userId: (await h.t.db.localAuth.upsertUser({ email: "sam@pipeline.test" })).id,
      }),
    );
    await h.events.send(queued!.events);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toEqual(["You said: Hello", "Hi, this is Sam."]);

    const released = await scope.run(async (ctx) =>
      releaseTakeover(ctx, {
        conversationId,
        reason: "manual",
        userId: null,
        traceId: "0e000000-0000-4000-8000-0000000000e3",
        now: new Date(),
        values: (await loadSettings(ctx, tenant.tenant)).values,
      }),
    );
    expect(released).not.toBeNull();
    await h.deliver(tenant, [message("Thanks")]);
    await h.idle();
    expect(h.transport.textsFor(conversationId).at(-1)).toBe("You said: Thanks");
  });

  it("sends the bot's own handoff message and nothing after it", async () => {
    const tenant = await h.newTenant();
    h.engine.respond = async (input, ports) => {
      if (input.pending.some((turn) => turn.text === "A person, please")) {
        const action: EngineAction = {
          type: "handoff_to_human",
          reason: "The customer asked for a person",
          urgency: "normal",
        };
        const outcome = await ports.tools.execute(action, context(input, "tool-handoff"));
        const executed: ExecutedAction = { toolCallId: "tool-handoff", action, outcome };
        return reply("I'm bringing in a member of our team; they'll pick up right here.", {
          actions: [executed],
        });
      }
      return reply(`You said: ${pendingTexts(input)}`);
    };
    await h.deliver(tenant, [message("A person, please")]);
    await h.idle();
    const conversationId = await conversationOf(tenant);
    const [lock] = await h.t.admin
      .select()
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, conversationId));
    expect(lock).toMatchObject({ source: "rule", releasedAt: null });
    expect(lock?.exemptThroughSeq).toBe(2);
    expect(h.transport.textsFor(conversationId)).toEqual([
      "I'm bringing in a member of our team; they'll pick up right here.",
    ]);
    expect(h.events.named("conversation.takeover_started").at(-1)?.data).toMatchObject({
      conversationId,
      source: "rule",
    });
    // A bot message after the handoff (a reminder, say) is withheld.
    const scope = h.t.db.forBusiness(tenant.tenant.businessId, {
      agencyId: tenant.tenant.agencyId,
    });
    const later = await scope.run((ctx) =>
      enqueueBotMessage(ctx, {
        conversationId,
        text: "Reminder: your visit is tomorrow.",
        traceId: "0e000000-0000-4000-8000-0000000000e4",
        purpose: "reminder",
      }),
    );
    await h.events.send(later!.events);
    await h.deliver(tenant, [message("Hello?")]);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toHaveLength(1);
    const [withheld] = await h.t.admin
      .select()
      .from(messages)
      .where(eq(messages.id, later!.messageId as never));
    expect(withheld).toMatchObject({ status: "superseded", errorCode: "takeover" });
  });
});

describe("opt-out through the pipeline", () => {
  it("confirms once, never answers the opt-out word, and withholds every automated message after it", async () => {
    echoWithTrigger();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("Hi there")]);
    await h.idle();
    const conversationId = await conversationOf(tenant);
    await h.deliver(tenant, [message("STOP")]);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toEqual([
      "You said: Hi there",
      "You won't get any more messages from us. Reply START if you change your mind.",
    ]);
    // The opt-out word alone is not answered: the opt-out guard stops the turn.
    expect((await turnsOf(conversationId)).at(-1)).toMatchObject({
      status: "skipped",
      skipReason: "opt_out:opted_out",
    });
    const [contact] = await h.t.admin
      .select()
      .from(contacts)
      .where(eq(contacts.businessId, tenant.tenant.businessId));
    expect(contact?.optedOutAt).not.toBeNull();
    expect(contact?.metadata["optOut"]).toMatchObject({ source: "keyword", keyword: "stop" });
    // The nudge planned after the first reply is cancelled.
    const plans = await h.t.admin
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.conversationId, conversationId));
    expect(plans.map((row) => row.status)).toEqual(["cancelled"]);

    // Another "stop" gets nothing; a reminder is withheld.
    await h.deliver(tenant, [message("stop")]);
    const scope = h.t.db.forBusiness(tenant.tenant.businessId, {
      agencyId: tenant.tenant.agencyId,
    });
    const reminder = await scope.run((ctx) =>
      enqueueBotMessage(ctx, {
        conversationId,
        text: "Reminder: your visit is tomorrow.",
        traceId: "0e000000-0000-4000-8000-0000000000e5",
        purpose: "reminder",
      }),
    );
    await h.events.send(reminder!.events);
    await h.idle();
    expect(h.transport.textsFor(conversationId)).toHaveLength(2);
    // Opting back in: the bot answers again.
    await h.deliver(tenant, [message("START")]);
    await h.idle();
    await h.deliver(tenant, [message("Can you come Friday?")]);
    await h.idle();
    expect(h.transport.textsFor(conversationId).at(-1)).toBe("You said: Can you come Friday?");
  });
});

/** Tuesday 10 November 2026, noon in New York: outside quiet hours everywhere in the US. */
const OPT_OUT_START = Date.parse("2026-11-10T17:00:00.000Z");

/**
 * The engine of the opt-out tests: escalates a gas smell (through the real handler) and answers
 * with the safety instructions; answers anything else by echoing it, unless the turn is
 * restricted to an emergency answer. It records what it saw.
 */
function emergencyAwareEngine(
  g: Harness,
  seen: EngineTurnInput[],
  options: { ignoreRestriction?: boolean } = {},
): void {
  g.engine.respond = async (input, ports) => {
    seen.push(input);
    const text = pendingTexts(input);
    if (/gas/i.test(text)) {
      const action: EngineAction = {
        type: "escalate_emergency",
        emergencyClass: "gas_leak",
        summary: "The customer smells gas in the kitchen.",
      };
      const outcome = await ports.tools.execute(action, context(input, "tool-gas"));
      return reply("Leave the house now and call the gas company from outside.", {
        actions: [{ toolCallId: "tool-gas", action, outcome }],
      });
    }
    // As the real engine does: a restricted turn without an emergency sends nothing.
    if (input.restriction?.kind === "emergency_only" && options.ignoreRestriction !== true) {
      return result([]);
    }
    return reply(`You said: ${text}`);
  };
}

/**
 * Before this was fixed, every message of an opted-out customer was skipped at the claim
 * (`opted_out`): the engine never ran, so a gas smell got no answer, no escalation and no
 * alert, and only the inbox's unread count showed it. These tests pin what happens now.
 */
describe("an opted-out customer who writes again", () => {
  /** A harness on a clock the test moves, with a customer who wrote, was answered and opted out. */
  async function optedOutConversation(
    settings: Parameters<Harness["newTenant"]>[0] = {},
    engine: { ignoreRestriction?: boolean } = {},
  ) {
    let now = OPT_OUT_START;
    const g = await createHarness({ clock: () => new Date(now) });
    const seen: EngineTurnInput[] = [];
    emergencyAwareEngine(g, seen, engine);
    const tenant = await g.newTenant(settings);
    await g.deliver(tenant, [message("Hi, I need a roof quote")]);
    await g.idle();
    now += 60_000;
    await g.deliver(tenant, [message("STOP")]);
    await g.idle();
    const [conversation] = await g.conversationsOf(tenant);
    const conversationId = conversation!.id;
    expect(g.transport.textsFor(conversationId)).toEqual([
      "You said: Hi, I need a roof quote",
      "You won't get any more messages from us. Reply START if you change your mind.",
    ]);
    now += 3_600_000;
    seen.length = 0;
    return {
      g,
      tenant,
      conversationId,
      seen,
      advance: (ms: number) => {
        now += ms;
      },
      scope: () =>
        g.t.db.forBusiness(tenant.tenant.businessId, { agencyId: tenant.tenant.agencyId }),
      alertRows: () =>
        g.t.admin.select().from(alerts).where(eq(alerts.businessId, tenant.tenant.businessId)),
    };
  }

  it("answers an emergency with the safety instructions and starts the escalation (default scope)", async () => {
    const o = await optedOutConversation({
      "emergency.escalation_chain": [
        { name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms"] },
      ],
    });
    try {
      await o.g.deliver(o.tenant, [message("There's a strong gas smell in my kitchen")]);
      await o.g.idle();

      // The turn ran, told that only an emergency may be answered.
      expect(o.seen.map((input) => input.restriction)).toEqual([
        { kind: "emergency_only", reason: "opted_out" },
      ]);
      expect(o.g.transport.textsFor(o.conversationId).at(-1)).toBe(
        "Leave the house now and call the gas company from outside.",
      );
      expect((await turnsIn(o.g, o.conversationId)).at(-1)).toMatchObject({
        trigger: "inbound_message",
        status: "replied",
      });
      // The escalation is recorded and the chain and the emergency alerts are started, as for
      // any customer.
      const chains = await o.g.t.admin
        .select()
        .from(escalations)
        .where(eq(escalations.conversationId, o.conversationId));
      expect(chains).toHaveLength(1);
      expect(chains[0]).toMatchObject({ emergencyClass: "gas_leak", status: "active" });
      expect(o.g.events.named("handoff.escalation_started").at(-1)?.data).toMatchObject({
        escalationId: chains[0]!.id,
      });
      expect(o.g.events.named("lead.emergency").at(-1)?.data).toMatchObject({
        conversationId: o.conversationId,
        emergencyClass: "gas_leak",
      });
      // The customer stays opted out of everything else.
      const [contact] = await o.g.t.admin
        .select()
        .from(contacts)
        .where(eq(contacts.businessId, o.tenant.tenant.businessId));
      expect(contact?.optedOutAt).not.toBeNull();

      // While the emergency is running, what the customer writes about it is answered too.
      o.advance(60_000);
      await o.g.deliver(o.tenant, [message("The address is 12 Elm Street")]);
      await o.g.idle();
      expect(o.seen.at(-1)?.restriction).toBeNull();
      expect(o.g.transport.textsFor(o.conversationId).at(-1)).toBe(
        "You said: The address is 12 Elm Street",
      );
    } finally {
      await o.g.dispose();
    }
  });

  it("answers an emergency sent together with the opt-out word", async () => {
    let now = OPT_OUT_START;
    const g = await createHarness({ clock: () => new Date(now) });
    try {
      const seen: EngineTurnInput[] = [];
      emergencyAwareEngine(g, seen);
      const tenant = await g.newTenant({ "follow_up.opt_out_scope": "proactive_only" });
      await g.deliver(tenant, [message("Hi")]);
      await g.idle();
      now += 60_000;
      await g.deliver(tenant, [message("STOP"), message("wait, I smell gas in the basement")]);
      await g.idle();
      const [conversation] = await g.conversationsOf(tenant);
      // One turn answers both: the opt-out word alone does not stop it, and with the word in
      // it the turn is limited to an emergency answer whatever the scope.
      expect(seen.at(-1)?.restriction).toEqual({ kind: "emergency_only", reason: "opted_out" });
      expect(g.transport.textsFor(conversation!.id)).toEqual([
        "You said: Hi",
        "You won't get any more messages from us. Reply START if you change your mind.",
        "Leave the house now and call the gas company from outside.",
      ]);
      expect(g.events.named("lead.emergency")).toHaveLength(1);
    } finally {
      await g.dispose();
    }
  });

  it("does not answer anything else by default, and tells the team the customer wrote", async () => {
    const o = await optedOutConversation();
    try {
      const before = o.g.transport.textsFor(o.conversationId);
      await o.g.deliver(o.tenant, [message("How much is a new roof?")]);
      await o.g.idle();

      expect(o.seen.map((input) => input.restriction)).toEqual([
        { kind: "emergency_only", reason: "opted_out" },
      ]);
      expect(o.g.transport.textsFor(o.conversationId)).toEqual(before);
      expect((await turnsIn(o.g, o.conversationId)).at(-1)).toMatchObject({
        status: "no_reply",
      });
      // Unread in the inbox, an in-app warning, and the "needs a person" alert path.
      const [conversation] = await o.g.conversationsOf(o.tenant);
      expect(conversation?.unreadCount).toBe(3);
      expect(conversation?.handledThroughSeq).toBe(5);
      const inApp = await o.alertRows();
      expect(inApp).toHaveLength(1);
      expect(inApp[0]).toMatchObject({
        kind: "opted_out_customer_wrote",
        channel: "in_app",
        severity: "warning",
        conversationId: o.conversationId,
        subject: OPTED_OUT_NOTICE,
      });
      const attention = o.g.events.named("handoff.attention_needed");
      expect(attention.map((event) => event.data)).toEqual([
        expect.objectContaining({
          conversationId: o.conversationId,
          reason: "opted_out_customer_wrote",
          day: "2026-11-10",
        }),
      ]);

      // Writing again the same day: still unread, no second alert (same event id).
      o.advance(600_000);
      await o.g.deliver(o.tenant, [message("Hello??")]);
      await o.g.idle();
      expect(o.g.transport.textsFor(o.conversationId)).toEqual(before);
      expect(await o.alertRows()).toHaveLength(1);
      const ids = new Set(o.g.events.named("handoff.attention_needed").map((event) => event.id));
      expect(ids.size).toBe(1);
      const [later] = await o.g.conversationsOf(o.tenant);
      expect(later?.unreadCount).toBe(4);
    } finally {
      await o.g.dispose();
    }
  });

  it("withholds a non-emergency reply at the send step even if the engine wrote one", async () => {
    const o = await optedOutConversation({}, { ignoreRestriction: true });
    try {
      const before = o.g.transport.textsFor(o.conversationId);
      await o.g.deliver(o.tenant, [message("How much is a new roof?")]);
      await o.g.idle();
      expect(o.g.transport.textsFor(o.conversationId)).toEqual(before);
      const [withheld] = await o.g.t.admin
        .select()
        .from(messages)
        .where(eq(messages.text, "You said: How much is a new roof?"));
      expect(withheld).toMatchObject({ status: "superseded", errorCode: "opted_out" });
    } finally {
      await o.g.dispose();
    }
  });

  it('answers as usual with "proactive_only", and still sends nothing the bot starts itself', async () => {
    const o = await optedOutConversation({ "follow_up.opt_out_scope": "proactive_only" });
    try {
      await o.g.deliver(o.tenant, [message("How much is a new roof?")]);
      await o.g.idle();
      expect(o.seen.map((input) => input.restriction)).toEqual([null]);
      expect(o.g.transport.textsFor(o.conversationId).at(-1)).toBe(
        "You said: How much is a new roof?",
      );
      expect(await o.alertRows()).toEqual([]);
      expect(o.g.events.named("handoff.attention_needed")).toEqual([]);
      // No nudge is planned after that reply.
      const plans = await o.g.t.admin
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.conversationId, o.conversationId));
      expect(plans.filter((row) => row.status === "scheduled")).toEqual([]);

      // A reminder is withheld; a follow-up turn is skipped.
      const sent = o.g.transport.textsFor(o.conversationId).length;
      const reminder = await o.scope().run((ctx) =>
        enqueueBotMessage(ctx, {
          conversationId: o.conversationId,
          text: "Reminder: your visit is tomorrow.",
          traceId: "0e000000-0000-4000-8000-0000000000f1",
          purpose: "reminder",
        }),
      );
      await o.g.events.send(reminder!.events);
      await o.g.events.send([
        jobEvent("conversation.turn_requested", "turn-follow-up-opted-out", {
          traceId: "0e000000-0000-4000-8000-0000000000f2" as TraceId,
          ...o.tenant.tenant,
          conversationId: o.conversationId,
          trigger: "follow_up",
          requestId: "follow-up-opted-out",
        }),
      ]);
      await o.g.idle();
      expect(o.g.transport.textsFor(o.conversationId)).toHaveLength(sent);
      const [withheld] = await o.g.t.admin
        .select()
        .from(messages)
        .where(eq(messages.id, reminder!.messageId as never));
      expect(withheld).toMatchObject({ status: "superseded", errorCode: "opted_out" });
      expect((await turnsIn(o.g, o.conversationId)).at(-1)).toMatchObject({
        trigger: "follow_up",
        status: "skipped",
        skipReason: "opted_out",
      });
    } finally {
      await o.g.dispose();
    }
  });
});

describe("follow-ups through the pipeline", () => {
  it("plans a nudge after a reply and runs it as a follow-up turn", async () => {
    echoWithTrigger();
    const tenant = await h.newTenant({
      "hours.quiet_hours": { enabled: false, start: "21:00", end: "08:00" },
    });
    await h.deliver(tenant, [message("How much is a water heater?")]);
    await h.idle();
    const conversationId = await conversationOf(tenant);
    const [plan] = await h.t.admin
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.conversationId, conversationId));
    expect(plan).toMatchObject({ kind: "follow_up", status: "scheduled" });
    expect(plan?.payload).toMatchObject({ reason: "cadence", nudge: 1, inboundSeq: 1 });
    expect(h.events.named("handoff.follow_up_planned").at(-1)?.data).toMatchObject({
      conversationId,
      followUpId: plan!.id,
    });

    await h.events.send([
      jobEvent("conversation.turn_requested", `turn-follow-up-${plan!.id}`, {
        traceId: "0e000000-0000-4000-8000-0000000000e6" as TraceId,
        ...tenant.tenant,
        conversationId,
        trigger: "follow_up",
        requestId: `follow-up-${plan!.id}`,
      }),
    ]);
    await h.idle();
    expect(triggers.at(-1)).toBe("follow_up");
    expect(h.transport.textsFor(conversationId).at(-1)).toBe(
      "Still thinking about that water heater?",
    );
    const turns = await turnsOf(conversationId);
    expect(turns.at(-1)).toMatchObject({
      trigger: "follow_up",
      status: "replied",
      pendingCount: 0,
    });
    // The website chat allows one nudge: none is planned after it.
    const after = await h.t.admin
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.conversationId, conversationId));
    expect(after.filter((row) => row.status === "scheduled")).toEqual([]);
  });

  it("gives way to a customer message that is still unanswered", async () => {
    echoWithTrigger();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("Hi")]);
    await h.idle();
    const conversationId = await conversationOf(tenant);
    // A customer message stored without its event yet (the reply run will answer it).
    const [conversation] = await h.t.admin
      .update(conversations)
      .set({ messageSeq: 3 })
      .where(eq(conversations.id, conversationId))
      .returning();
    await h.t.admin.insert(messages).values({
      ...tenant.tenant,
      conversationId,
      channelConnectionId: conversation!.channelConnectionId,
      direction: "inbound",
      author: "customer",
      kind: "text",
      text: "One more thing",
      externalMessageId: "late-1",
      sequence: 3,
      status: "received",
      sentAt: new Date(),
    });
    const before = (await turnsOf(conversationId)).length;
    await h.events.send([
      jobEvent("conversation.turn_requested", "turn-follow-up-give-way", {
        traceId: "0e000000-0000-4000-8000-0000000000e7" as TraceId,
        ...tenant.tenant,
        conversationId,
        trigger: "follow_up",
        requestId: "follow-up-give-way",
      }),
    ]);
    await h.idle();
    expect(await turnsOf(conversationId)).toHaveLength(before);
    expect(
      h.runner.history.filter((run) => run.functionId === "pipeline-requested-turn").at(-1),
    ).toMatchObject({ status: "completed" });
    expect(h.transport.textsFor(conversationId)).toEqual(["You said: Hi"]);
  });
});

describe("send gates", () => {
  it("lets a person's reply pass a bot message a gate holds, and sends the held one after", async () => {
    const g = await createHarness({ sendGates: [testGate] });
    try {
      const tenant = await g.newTenant();
      g.engine.respond = async (input) => reply(`You said: ${pendingTexts(input)}`);
      await g.deliver(tenant, [message("Hi")]);
      await g.idle();
      const [conversation] = await g.conversationsOf(tenant);
      const conversationId = conversation!.id;
      const scope = g.t.db.forBusiness(tenant.tenant.businessId, {
        agencyId: tenant.tenant.agencyId,
      });
      const held = await scope.run((ctx) =>
        enqueueBotMessage(ctx, {
          conversationId,
          text: "A held bot message",
          traceId: "0e000000-0000-4000-8000-0000000000e8",
          purpose: "held_for_test",
        }),
      );
      await g.events.send(held!.events);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const user = await g.t.db.localAuth.upsertUser({ email: "lee@pipeline.test" });
      const human = await scope.run((ctx) =>
        enqueueHumanMessage(ctx, {
          conversationId,
          text: "A person's reply",
          traceId: "0e000000-0000-4000-8000-0000000000e9",
          userId: user.id,
        }),
      );
      await g.events.send(human!.events);
      await g.idle();
      expect(g.transport.textsFor(conversationId)).toEqual([
        "You said: Hi",
        "A person's reply",
        "A held bot message",
      ]);
      const [row] = await g.t.admin
        .select()
        .from(messages)
        .where(eq(messages.id, held!.messageId as never));
      expect(row?.status).toBe("sent");
      expect(row?.payload["heldUntil"]).toBeUndefined();
      expect(sendEventId(held!.messageId)).toBe(held!.events[0]?.id);
    } finally {
      await g.dispose();
    }
  });
});
