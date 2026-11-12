import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CHANNEL_CAPABILITIES,
  type ConversationId,
  createLogger,
  type ToolExecutionContext,
  type TraceId,
} from "@repo/core";
import {
  asc,
  type BusinessTenant,
  businesses,
  channelConnections,
  contacts,
  conversations,
  eq,
  leadEvents,
  leadFields,
  leadReports,
  leads,
  routingDecisions,
  segments,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import type { AnyJobEvent, EventSender, StepTools } from "@repo/jobs";
import { settingsWith } from "@repo/settings";

import { markNotAFitHandler, updateLeadFieldsHandler } from "../handlers";
import { createLeadJobs } from "../jobs";
import { loadLeadSnapshot } from "../loader";
import { createLeadTurnObserver } from "../observer";
import { dispatchLeadEvents } from "./outbox";

const quiet = createLogger({ level: "error", sink: () => {} });
const TRACE = "0e000000-0000-4000-8000-0000000000c5" as TraceId;

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.dispose();
});

interface Fixture {
  readonly tenant: BusinessTenant;
  readonly conversationId: ConversationId;
}

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const { id: agencyId } = await t.db.platform.createAgency({
    name: `A ${suffix}`,
    slug: `a-${suffix}`,
  });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "hvac", name: "HVAC" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: `Cool Air ${suffix}`,
      slug: `cool-${suffix}`,
      status: "active",
    })
    .returning({ id: businesses.id });
  const tenant = { agencyId, businessId: business!.id };
  const [connection] = await t.admin
    .insert(channelConnections)
    .values({ ...tenant, channel: "test", externalAccountId: `test-${suffix}`, status: "active" })
    .returning({ id: channelConnections.id });
  const [contact] = await t.admin
    .insert(contacts)
    .values({ ...tenant, displayName: "Pat Lee", phone: "+15125550199" })
    .returning({ id: contacts.id });
  const [conversation] = await t.admin
    .insert(conversations)
    .values({
      ...tenant,
      contactId: contact!.id,
      channelConnectionId: connection!.id,
      channel: "test",
    })
    .returning({ id: conversations.id });
  return { tenant, conversationId: conversation!.id };
}

function context(
  f: Fixture,
  mode: "live" | "dry_run" = "live",
  overrides = {},
): ToolExecutionContext {
  return {
    trace: { traceId: TRACE, ...f.tenant, conversationId: f.conversationId },
    mode,
    toolCallId: `toolu_${randomUUID()}`,
    now: "2026-11-12T15:00:00.000Z",
    settings: settingsWith(overrides),
    channel: {
      id: "test",
      capabilities: CHANNEL_CAPABILITIES.test,
      window: { open: true, closesAt: null },
    },
    business: {
      id: f.tenant.businessId,
      agencyId: f.tenant.agencyId,
      name: "Cool Air",
      segment: { id: "00000000-0000-4000-8000-000000000001" as never, slug: "hvac", name: "HVAC" },
      timezone: "America/Chicago",
    },
  };
}

const deps = () => ({ db: t.db, logger: quiet });

const QUALIFIED = [
  { key: "service_type", value: "AC repair", confidence: 1, evidence: "AC is broken" },
  {
    key: "job_scope",
    value: "Central AC blowing warm air",
    confidence: 1,
    evidence: "blowing warm",
  },
  { key: "service_area", value: "78704", confidence: 1, evidence: "78704" },
  { key: "timeline", value: "this_week", confidence: 1, evidence: "this week" },
];

class RecordingSender implements EventSender {
  readonly sent: AnyJobEvent[] = [];
  fail = false;
  async send(events: readonly AnyJobEvent[]) {
    if (this.fail) throw new Error("down");
    this.sent.push(...events);
  }
}

const inlineSteps: StepTools = {
  run: async (_id, fn) => fn(),
  sleep: async () => {},
  sleepUntil: async () => {},
};

describe("update_lead_fields and mark_not_a_fit handlers", () => {
  it("stores the fields, scores, routes and writes the report and the outbox in one go", async () => {
    const f = await fixture();
    const outcome = await updateLeadFieldsHandler(deps()).handle(
      { type: "update_lead_fields", fields: QUALIFIED },
      context(f),
    );
    // 65 known + 30 × 50 % = 80 of 95 → 84: hot.
    expect(outcome).toMatchObject({
      status: "applied",
      routing: { outcome: "book_meeting", score: 84, band: "hot" },
    });

    const [lead] = await t.admin
      .select()
      .from(leads)
      .where(eq(leads.conversationId, f.conversationId));
    expect(lead).toMatchObject({
      status: "meeting_requested",
      score: 84,
      band: "hot",
      routingOutcome: "book_meeting",
    });
    const fields = await t.admin.select().from(leadFields).where(eq(leadFields.leadId, lead!.id));
    expect(fields.map((row) => [row.key, row.value]).sort()).toEqual(
      QUALIFIED.map((entry) => [entry.key, entry.value]).sort(),
    );
    // The channel's phone number reaches the report, not the score (the customer did not give it).
    const [report] = await t.admin
      .select()
      .from(leadReports)
      .where(eq(leadReports.leadId, lead!.id));
    expect(report?.markdown).toContain('Name: "Pat Lee". Phone: "+15125550199".');
    const events = await t.admin.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id));
    expect(events.map((row) => [row.name, row.dedupeKey, row.emittedAt]).sort()).toEqual([
      ["lead.meeting_requested", "meeting_requested", null],
      ["lead.qualified", "qualified", null],
    ]);

    // The snapshot the next turn's engine input gets.
    const snapshot = await t.db
      .forBusiness(f.tenant.businessId)
      .run((ctx) => loadLeadSnapshot(ctx, f.conversationId));
    expect(snapshot).toMatchObject({
      id: lead!.id,
      status: "meeting_requested",
      routing: { outcome: "book_meeting" },
    });
    expect(Object.keys(snapshot.fields).sort()).toEqual(QUALIFIED.map((entry) => entry.key).sort());
  });

  it("re-routes when the facts change and records each decision in order", async () => {
    const f = await fixture();
    const handler = updateLeadFieldsHandler(deps());
    await handler.handle({ type: "update_lead_fields", fields: QUALIFIED }, context(f));
    const second = await handler.handle(
      {
        type: "update_lead_fields",
        fields: [
          { key: "timeline", value: "just_researching", confidence: 1, evidence: "just looking" },
        ],
      },
      context(f),
    );
    // Timeline 0 now: 50 + 15 = 65 of 95 → 68, warm.
    expect(second.routing).toMatchObject({ outcome: "contact_later", band: "warm", score: 68 });
    const [lead] = await t.admin
      .select()
      .from(leads)
      .where(eq(leads.conversationId, f.conversationId));
    const decisions = await t.admin
      .select()
      .from(routingDecisions)
      .where(eq(routingDecisions.leadId, lead!.id))
      .orderBy(asc(routingDecisions.sequence));
    // Both share decided_at (one clock): the sequence orders them.
    expect(decisions.map((row) => [row.sequence, row.outcome])).toEqual([
      [1, "book_meeting"],
      [2, "contact_later"],
    ]);
    expect(lead).toMatchObject({ status: "qualified", routingOutcome: "contact_later" });
    const snapshot = await t.db
      .forBusiness(f.tenant.businessId)
      .run((ctx) => loadLeadSnapshot(ctx, f.conversationId));
    expect(snapshot.routing?.outcome).toBe("contact_later");
    const reports = await t.admin
      .select()
      .from(leadReports)
      .where(eq(leadReports.leadId, lead!.id));
    expect(reports.map((row) => row.version).sort()).toEqual([1, 2]);
    const names = (
      await t.admin.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id))
    ).map((row) => row.name);
    expect(names.sort()).toEqual(["lead.handoff", "lead.meeting_requested", "lead.qualified"]);
  });

  it("writes nothing in dry-run mode but still answers with the decision", async () => {
    const f = await fixture();
    const outcome = await updateLeadFieldsHandler(deps()).handle(
      { type: "update_lead_fields", fields: QUALIFIED },
      context(f, "dry_run"),
    );
    expect(outcome.routing?.outcome).toBe("book_meeting");
    expect(
      await t.admin.select().from(leads).where(eq(leads.conversationId, f.conversationId)),
    ).toEqual([]);
  });

  it("disqualifies a spam contact, and leaves other judgements to a person", async () => {
    const spam = await fixture();
    const outcome = await markNotAFitHandler(deps()).handle(
      { type: "mark_not_a_fit", reason: "Sells SEO", category: "spam" },
      context(spam),
    );
    expect(outcome).toMatchObject({ status: "applied", routing: { outcome: "disqualify" } });
    expect(outcome.message).toContain("Close the conversation politely");
    const [lead] = await t.admin
      .select()
      .from(leads)
      .where(eq(leads.conversationId, spam.conversationId));
    expect(lead).toMatchObject({ status: "disqualified", disqualifyReason: "spam" });
    const events = await t.admin.select().from(leadEvents).where(eq(leadEvents.leadId, lead!.id));
    expect(
      events.map((row) => [row.name, (row.payload as { reasonCode?: string }).reasonCode]),
    ).toEqual([["lead.disqualified", "spam"]]);

    const other = await fixture();
    const judged = await markNotAFitHandler(deps()).handle(
      { type: "mark_not_a_fit", reason: "Asking for directions to a store" },
      context(other),
    );
    expect(judged.routing?.outcome).toBe("contact_later");
    expect(judged.message).toContain("A person at the business will look at this contact");
  });

  it("cannot reach a conversation of another business", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const foreign = {
      ...context(mine),
      trace: { ...context(mine).trace, conversationId: theirs.conversationId },
    };
    const outcome = await updateLeadFieldsHandler(deps()).handle(
      { type: "update_lead_fields", fields: QUALIFIED },
      foreign,
    );
    expect(outcome.status).toBe("rejected");
    expect(
      await t.admin.select().from(leads).where(eq(leads.conversationId, theirs.conversationId)),
    ).toEqual([]);
  });
});

describe("turn observer and outbox", () => {
  it("creates the lead, records emergencies and handoffs once per turn, and marks sent events", async () => {
    const f = await fixture();
    const observer = createLeadTurnObserver(deps());
    const turn = {
      conversationId: f.conversationId,
      turnId: randomUUID(),
      traceId: TRACE,
      status: "replied",
      now: new Date("2026-11-12T15:00:00.000Z"),
      actions: [
        {
          toolCallId: "a",
          action: {
            type: "escalate_emergency" as const,
            emergencyClass: "no_heat",
            summary: "No heat, 20F outside",
          },
          outcome: { status: "deferred" as const, message: null, data: null },
        },
        {
          toolCallId: "b",
          action: {
            type: "handoff_to_human" as const,
            reason: "Elderly customer, team should call",
            urgency: "high" as const,
          },
          outcome: { status: "deferred" as const, message: null, data: null },
        },
      ],
    };
    const run = () =>
      t.db.forBusiness(f.tenant.businessId).run((ctx) => observer.committed(ctx, turn));
    const events = await run();
    expect(events.map((event) => event.name).sort()).toEqual(["lead.emergency", "lead.handoff"]);
    const handoff = events.find((event) => event.name === "lead.handoff");
    expect(handoff?.data).toMatchObject({
      trigger: "bot_decision",
      urgency: "high",
      routing: "contact_later",
    });
    // Again (a replayed commit): the same unsent events, no new ones.
    expect((await run()).map((event) => event.id).sort()).toEqual(
      events.map((event) => event.id).sort(),
    );

    await observer.emitted(f.tenant, events, new Date());
    const rows = await t.admin
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.businessId, f.tenant.businessId));
    expect(rows.every((row) => row.emittedAt !== null)).toBe(true);
    expect(await run()).toEqual([]);
    const [lead] = await t.admin
      .select()
      .from(leads)
      .where(eq(leads.conversationId, f.conversationId));
    expect(lead?.status).toBe("handed_off");
  });

  it("sends what a failed turn left behind through the leads-outbox cron", async () => {
    const f = await fixture();
    await updateLeadFieldsHandler(deps()).handle(
      { type: "update_lead_fields", fields: QUALIFIED },
      context(f),
    );
    const sender = new RecordingSender();
    const later = () => new Date(Date.now() + 10 * 60_000);

    // Too young: left to the turn.
    expect(
      await dispatchLeadEvents({
        db: t.db,
        events: sender,
        tenant: f.tenant,
        before: new Date(0),
        now: new Date(),
      }),
    ).toBe(0);

    sender.fail = true;
    await expect(
      dispatchLeadEvents({
        db: t.db,
        events: sender,
        tenant: f.tenant,
        before: later(),
        now: new Date(),
      }),
    ).rejects.toThrow("down");
    const failed = await t.admin
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.businessId, f.tenant.businessId));
    expect(failed.every((row) => row.emittedAt === null && row.attempts === 1)).toBe(true);

    sender.fail = false;
    const [job] = createLeadJobs({ db: t.db, events: sender, logger: quiet, clock: later });
    await job!.handler({
      event: { name: "cron", id: null, data: {} },
      step: inlineSteps,
      runId: "run-1",
      attempt: 0,
      logger: quiet,
    });
    const mine = sender.sent.filter((event) => event.data.businessId === f.tenant.businessId);
    expect(mine.map((event) => event.name).sort()).toEqual([
      "lead.meeting_requested",
      "lead.qualified",
    ]);
    const rows = await t.admin
      .select()
      .from(leadEvents)
      .where(eq(leadEvents.businessId, f.tenant.businessId));
    expect(rows.every((row) => row.emittedAt !== null)).toBe(true);
  });
});
