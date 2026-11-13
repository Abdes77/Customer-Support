import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEngine, type ModelMessageParam } from "@repo/ai";
import {
  createScriptedModelClient,
  type ScriptedModelClient,
  scriptedResponse,
  text,
  toolUse,
} from "@repo/ai/testing";
import type { LeadEventName } from "@repo/core";
import { asc, conversations, eq, leadEvents, leadReports, leads, routingDecisions } from "@repo/db";

import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";

/**
 * Lead scoring and routing (C5) in the real turn: the engine with a scripted model calls
 * `update_lead_fields`, the handler stores and scores the lead, the routing decision comes
 * back in the tool result the model reads before it writes the reply, and the `lead.*`
 * events go out once, after the turn commits.
 */

let h: Harness;
let model: ScriptedModelClient;

beforeAll(async () => {
  model = createScriptedModelClient();
  h = await createHarness({ model });
  const engine = createEngine({ model });
  h.engine.respond = (input, ports) => engine.respond(input, ports);
});

afterAll(async () => {
  await h?.dispose();
});

function lastText(messageParam: ModelMessageParam | undefined): string {
  if (messageParam === undefined) return "";
  if (typeof messageParam.content === "string") return messageParam.content;
  return (messageParam.content ?? [])
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "tool_result" && typeof block.content === "string"
          ? block.content
          : "",
    )
    .join("\n");
}

const field = (key: string, value: string | number | boolean | null, evidence = "said so") => ({
  key,
  value,
  confidence: 1,
  evidence,
});

const QUALIFYING_FIELDS = [
  field("service_type", "Roof replacement", "need a new roof"),
  field("job_scope", "Full replacement of an old shingle roof", "the whole roof"),
  field("service_area", "80215", "ZIP 80215"),
  field("timeline", "this_month", "this month"),
  field("decision_maker", "homeowner", "my house"),
  field("contact_name", "Dana Ruiz", "I'm Dana Ruiz"),
];

async function leadOf(tenant: TestTenant) {
  const [lead] = await h.t.admin
    .select()
    .from(leads)
    .where(eq(leads.businessId, tenant.tenant.businessId));
  return lead;
}

async function eventsOf(tenant: TestTenant) {
  return h.t.admin
    .select()
    .from(leadEvents)
    .where(eq(leadEvents.businessId, tenant.tenant.businessId))
    .orderBy(asc(leadEvents.createdAt), asc(leadEvents.name));
}

function sentFor<TName extends LeadEventName>(tenant: TestTenant, name: TName) {
  return h.events.named(name).filter((event) => event.data.businessId === tenant.tenant.businessId);
}

describe("lead scoring in the reply turn", () => {
  it("scores the lead, hands the decision to the model in the same turn and emits the events once", async () => {
    const tenant = await h.newTenant();
    const before = model.requests.length;
    model.push(
      scriptedResponse([toolUse("update_lead_fields", { fields: QUALIFYING_FIELDS })]),
      scriptedResponse([text("Thanks Dana! Let me find a time for an estimate.")]),
    );
    await h.deliver(tenant, [
      message("I'm Dana Ruiz, I need a new roof on my house in 80215 this month"),
    ]);
    await h.idle();

    // 75 known + 20 unknown at 50 % = 85 of 95 → 89: hot, book a meeting.
    const toolResult = lastText(model.requests[before + 1]?.messages.at(-1));
    expect(toolResult).toContain("status: applied");
    expect(toolResult).toContain("Routing decision: book_meeting.");
    expect(toolResult).not.toContain("89");

    const lead = await leadOf(tenant);
    expect(lead).toMatchObject({
      status: "meeting_requested",
      score: 89,
      band: "hot",
      routingOutcome: "book_meeting",
    });
    expect(lead?.qualifiedAt).not.toBeNull();
    const decisions = await h.t.admin
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.leadId, lead!.id));
    expect(decisions.map((row) => [row.sequence, row.outcome, row.score, row.band])).toEqual([
      [1, "book_meeting", 89, "hot"],
    ]);
    const reports = await h.t.admin
      .select()
      .from(leadReports)
      .where(eq(leadReports.leadId, lead!.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.summary).toMatch(
      /^Hot lead, score 89, "Roof replacement", in "80215", this month\./,
    );
    expect(reports[0]?.markdown).toContain('Name: "Dana Ruiz".');
    expect(reports[0]?.sections).toMatchObject({
      outcome: "book_meeting",
      status: "meeting_requested",
    });

    // The events went out with the turn and are marked sent.
    expect(sentFor(tenant, "lead.qualified").map((event) => event.data.routing)).toEqual([
      "book_meeting",
    ]);
    expect(
      sentFor(tenant, "lead.meeting_requested").map((event) => event.data.bookingMode),
    ).toEqual(["manual"]);
    const rows = await eventsOf(tenant);
    expect(rows.map((row) => row.name).sort()).toEqual([
      "lead.meeting_requested",
      "lead.qualified",
    ]);
    expect(rows.every((row) => row.emittedAt !== null)).toBe(true);
    const qualified = sentFor(tenant, "lead.qualified")[0]!;
    expect(qualified.id).toBe(`lead-${qualified.data.eventId}`);
    expect(qualified.data).toMatchObject({
      leadId: lead!.id,
      score: 89,
      band: "hot",
      channel: "test",
    });
    // Ids and classifications only.
    expect(JSON.stringify(qualified.data)).not.toContain("Dana");

    // The same facts again: no new decision, report or event.
    model.push(
      scriptedResponse([toolUse("update_lead_fields", { fields: QUALIFYING_FIELDS })]),
      scriptedResponse([text("Got it.")]),
    );
    await h.deliver(tenant, [message("Yes, as I said")]);
    await h.idle();
    expect(
      await h.t.admin.select().from(routingDecisions).where(eq(routingDecisions.leadId, lead!.id)),
    ).toHaveLength(1);
    expect(
      await h.t.admin.select().from(leadReports).where(eq(leadReports.leadId, lead!.id)),
    ).toHaveLength(1);
    expect(await eventsOf(tenant)).toHaveLength(2);
    expect(sentFor(tenant, "lead.qualified")).toHaveLength(1);
  });

  it("gives every conversation a scored lead and a report, even without a saved field", async () => {
    const tenant = await h.newTenant();
    model.push(scriptedResponse([text("Hi! What can we help you with?")]));
    await h.deliver(tenant, [message("hello")]);
    await h.idle();
    const lead = await leadOf(tenant);
    // Nothing known: half of every weight.
    expect(lead).toMatchObject({ status: "new", score: 50, band: "warm", routingOutcome: null });
    const reports = await h.t.admin
      .select()
      .from(leadReports)
      .where(eq(leadReports.leadId, lead!.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.markdown).toContain("Still qualifying: the bot is finding out service type");
    expect(await eventsOf(tenant)).toEqual([]);
  });

  it("turns spam away and emits lead.disqualified", async () => {
    const tenant = await h.newTenant();
    const before = model.requests.length;
    model.push(
      scriptedResponse([
        toolUse("mark_not_a_fit", { category: "spam", reason: "Offers cheap SEO services" }),
      ]),
      scriptedResponse([text("Thanks, but we're not interested.")]),
    );
    await h.deliver(tenant, [message("Boost your Google ranking today! Cheap SEO")]);
    await h.idle();
    expect(lastText(model.requests[before + 1]?.messages.at(-1))).toContain(
      "Close the conversation politely",
    );
    const lead = await leadOf(tenant);
    expect(lead).toMatchObject({
      status: "disqualified",
      disqualifyReason: "spam",
      routingOutcome: "disqualify",
    });
    expect(sentFor(tenant, "lead.disqualified").map((event) => event.data.reasonCode)).toEqual([
      "spam",
    ]);
    expect(sentFor(tenant, "lead.qualified")).toEqual([]);
  });

  it("records an escalated emergency and a handoff from the turn's actions", async () => {
    const tenant = await h.newTenant();
    model.push(
      scriptedResponse([
        toolUse("escalate_emergency", {
          emergency_class: "gas_leak",
          summary: "Customer smells gas in the kitchen",
        }),
        toolUse("handoff_to_human", {
          reason: "The customer asked to talk to a person",
          urgency: "high",
        }),
      ]),
      scriptedResponse([
        text("Please leave the house now. Someone from our team will call you right away."),
      ]),
    );
    await h.deliver(tenant, [message("I smell gas in my kitchen, can I talk to a real person?")]);
    await h.idle();

    const lead = await leadOf(tenant);
    // The emergency makes the timeline "right now" (15 of 15), the rest earns half:
    // 55 of 95 → 58, plus 15 for the emergency.
    expect(lead).toMatchObject({ status: "handed_off", score: 73 });
    expect(lead?.handedOffAt).not.toBeNull();
    expect(sentFor(tenant, "lead.emergency").map((event) => event.data.emergencyClass)).toEqual([
      "gas_leak",
    ]);
    expect(
      sentFor(tenant, "lead.handoff").map((event) => [event.data.trigger, event.data.urgency]),
    ).toEqual([["customer_request", "high"]]);
    const [report] = await h.t.admin
      .select()
      .from(leadReports)
      .where(eq(leadReports.leadId, lead!.id))
      .orderBy(asc(leadReports.version))
      .limit(1);
    expect(report?.markdown).toContain("EMERGENCY: Gas smell or gas leak was escalated");
  });
});

describe("a failing turn observer", () => {
  it("is rolled back and logged; the turn still commits and the reply goes out", async () => {
    const failing = await createHarness({
      model,
      observers: [
        {
          name: "broken",
          committed: async (ctx, turn) => {
            // A write that must be undone, then a failing query whose text must not be logged.
            await ctx.tx
              .update(conversations)
              .set({ subject: "observer was here" })
              .where(eq(conversations.id, turn.conversationId));
            await ctx.tx.insert(leads).values({
              ...ctx.tenant,
              contactId: "Dana Ruiz" as never,
              conversationId: turn.conversationId,
            });
            return [];
          },
        },
      ],
    });
    try {
      const tenant = await failing.newTenant();
      await failing.deliver(tenant, [message("hello")]);
      await failing.idle();
      const rows = await failing.messagesOf(tenant);
      expect(rows.map((row) => [row.direction, row.status])).toEqual([
        ["inbound", "received"],
        ["outbound", "sent"],
      ]);
      const failure = failing.logs.find((record) => record.msg === "turn.observer_failed");
      expect(failure).toBeDefined();
      expect(JSON.stringify(failure)).not.toContain("Dana Ruiz");
      expect(JSON.stringify(failure)).not.toContain("insert into");
      const [conversation] = await failing.t.admin
        .select({ subject: conversations.subject })
        .from(conversations)
        .where(eq(conversations.businessId, tenant.tenant.businessId));
      expect(conversation?.subject).not.toBe("observer was here");
    } finally {
      await failing.dispose();
    }
  });
});
