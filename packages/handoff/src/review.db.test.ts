import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  alerts,
  and,
  conversations,
  conversationTurns,
  eq,
  escalations,
  messages,
  sql,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import type { JobDefinition } from "@repo/jobs";
import { settingsWith } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { acknowledgeByLink, acknowledgeBySms, MAX_CODE_ATTEMPTS } from "./emergency/ack";
import { runChainStep, startEscalation } from "./emergency/escalation";
import { createQuietHoursGate } from "./domain";
import { createHandoffJobs, HANDOFF_FUNCTION_IDS } from "./jobs";
import { emergencyReadiness } from "./readiness";
import { createHandoffService } from "./service";
import {
  createFixture,
  drive,
  type Fixture,
  quiet,
  setAgencySettings,
  setBusinessSettings,
  TestClock,
  testDeps,
  TRACE,
} from "./test-fixture";
import { createRecordingTransports } from "./testing";

/*
 * The emergency chain's failure paths and the guards added in the C13 review: a delivery
 * that throws, a contact without an address, a chain that ends unanswered, guessing the
 * text-message code, the same emergency recorded twice, the quiet-hours gate for an
 * emergency with alerts switched off, and the readiness signal for empty chains. Every time
 * comes from an injected clock.
 */

/** Tuesday, November 10, 2026, 10:00 AM in Chicago. */
const TUESDAY_10AM = new Date("2026-11-10T16:00:00.000Z");
const ann = { name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms" as const] };
const bob = { name: "Bob", phone: "+15125550102", email: "", alert_by: ["sms" as const] };
const OFFICE = {
  name: "Office",
  email: "office@lonestar.example",
  phone: "",
  channels: ["email" as const],
  events: [],
  active: true,
};

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.dispose();
});

function job(jobs: JobDefinition[], id: string): JobDefinition {
  const found = jobs.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No job ${id}`);
  return found;
}

async function start(f: Fixture, clock: TestClock, traceId: string = TRACE) {
  return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run(async (ctx) =>
    startEscalation(ctx, {
      conversationId: f.conversationId,
      emergencyClass: "gas_leak",
      summary: "Smells gas",
      traceId,
      values: (await loadSettings(ctx, f.tenant, { logger: quiet })).values,
      now: clock.now(),
    }),
  );
}

async function chainAlerts(escalationId: string) {
  return t.admin.select().from(alerts).where(eq(alerts.escalationId, escalationId));
}

describe("the emergency chain never stalls", () => {
  it("records an alert whose transport throws as failed, moves on, and ends loudly", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "emergency.escalation_chain": [ann, bob],
      "emergency.rounds": 1,
      "alerts.recipients": [OFFICE],
    });
    const clock = new TestClock(TUESDAY_10AM);
    // Every text to Ann throws; everything else goes out.
    const transports = createRecordingTransports({
      answer: (send) => {
        if (send.to === ann.phone) throw new Error("socket hang up");
        return { ok: true, providerId: randomUUID() };
      },
    });
    const { deps } = testDeps(t, clock, transports);
    const started = await start(f, clock);
    const run = await drive<"handoff.escalation_started">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.emergencyChain),
      { traceId: TRACE, ...f.tenant, escalationId: started!.escalationId },
      clock,
    );
    expect(run.result).toEqual({ outcome: "exhausted" });
    const rows = await chainAlerts(started!.escalationId);
    const ofAnn = rows.filter((row) => row.recipient === ann.phone && row.kind === "emergency");
    expect(ofAnn.map((row) => [row.channel, row.status])).toEqual(
      expect.arrayContaining([
        ["sms", "failed"],
        ["voice", "failed"],
      ]),
    );
    expect(ofAnn.every((row) => (row.error ?? "").startsWith("transport_error"))).toBe(true);
    // Ann's alert and call threw: no wait for her; Bob was alerted and called.
    expect(transports.sent.filter((send) => send.to === bob.phone).map((s) => s.channel)).toEqual([
      "sms",
      "voice",
    ]);
    // Exhausted: the critical in-app alert, and the office hears it by email with the notice.
    const all = await t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.businessId, f.tenant.businessId));
    expect(all.find((row) => row.kind === "emergency_unacknowledged")).toMatchObject({
      severity: "critical",
    });
    const office = transports.sent.filter((send) => send.to === OFFICE.email);
    expect(office).toHaveLength(1);
    expect(office[0]!.subject).toMatch(/^NOBODY ACKNOWLEDGED THIS EMERGENCY/);
  });

  it("records a contact without a number as failed and goes on to the next one", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "emergency.escalation_chain": [ann, bob],
      "emergency.rounds": 1,
      "emergency.call_unacknowledged": false,
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    // A stored snapshot from before the settings' checks: Ann has no number.
    await t.admin
      .update(escalations)
      .set({
        chain: sql`jsonb_set(${escalations.chain}, '{0,phone}', '""'::jsonb)`,
      })
      .where(eq(escalations.id, started!.escalationId));
    const first = await runChainStep(deps, f.tenant, started!.escalationId, 0);
    expect(first).toMatchObject({ active: true, waitUntil: TUESDAY_10AM.toISOString(), sent: 0 });
    const [row] = await chainAlerts(started!.escalationId);
    expect(row).toMatchObject({ status: "failed", channel: "sms" });
    expect(row!.error).toMatch(/^no_address/);
    await runChainStep(deps, f.tenant, started!.escalationId, 1);
    expect(transports.sent.map((send) => send.to)).toEqual([bob.phone]);
  });

  it("raises a critical in-app alert when the chain's job fails for good", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, { "emergency.escalation_chain": [ann] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    const started = await start(f, clock);
    const chain = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.emergencyChain);
    await chain.onFailure?.({
      event: {
        name: "handoff.escalation_started",
        id: "e1",
        data: { traceId: TRACE, ...f.tenant, escalationId: started!.escalationId },
      },
      error: { message: "boom", code: null },
      runId: "run-1",
      logger: quiet,
    } as never);
    const rows = await t.admin
      .select()
      .from(alerts)
      .where(
        and(eq(alerts.businessId, f.tenant.businessId), eq(alerts.kind, "emergency_chain_failed")),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "critical", channel: "in_app" });
  });

  it("records an emergency once when the action and lead.emergency both start it", async () => {
    // Nobody to alert: the chain ends at once, and lead.emergency for the same turn must not
    // record (and flag) a second one.
    const f = await createFixture(t);
    const clock = new TestClock(TUESDAY_10AM);
    const first = await start(f, clock);
    const second = await start(f, clock);
    expect(first).toMatchObject({ status: "exhausted", contacts: 0 });
    expect(second).toMatchObject({ escalationId: first!.escalationId, started: false });
    // Another turn, an hour later: a new emergency is recorded.
    clock.advance(3_600_000);
    const later = await start(f, clock, randomUUID());
    expect(later!.escalationId).not.toBe(first!.escalationId);
    const rows = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.conversationId, f.conversationId));
    expect(rows).toHaveLength(2);
  });
});

describe("the text-message code", () => {
  it(`stops accepting a code after ${MAX_CODE_ATTEMPTS} wrong ones from the alerted number`, async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, { "emergency.escalation_chain": [ann] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    await runChainStep(deps, f.tenant, started!.escalationId, 0);
    const text = transports.sent[0]!.text;
    const code = /Reply (\d{6})/.exec(text)![1]!;
    const wrong = (n: number) => String((Number(code) + n) % 1_000_000).padStart(6, "0");
    for (let n = 1; n <= MAX_CODE_ATTEMPTS; n += 1) {
      expect(await acknowledgeBySms(deps, { from: ann.phone, body: wrong(n) })).toEqual({
        kind: "no_match",
      });
    }
    // The right code no longer works...
    expect(await acknowledgeBySms(deps, { from: ann.phone, body: code })).toEqual({
      kind: "no_match",
    });
    // ...but the link still does.
    const token = /\/api\/handoff\/ack\/(\S+)$/.exec(text)![1]!;
    expect(await acknowledgeByLink(deps, token)).toMatchObject({ kind: "acknowledged" });
  });
});

describe("quiet hours and emergencies", () => {
  it("never holds a reply that carried an emergency, even with alerts switched off", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "hours.quiet_hours_cover_replies": true,
      "emergency.enabled": false,
    });
    const [counter] = await t.admin
      .update(conversations)
      .set({ messageSeq: sql`${conversations.messageSeq} + 1` })
      .where(eq(conversations.id, f.conversationId))
      .returning({ seq: conversations.messageSeq });
    const [message] = await t.admin
      .insert(messages)
      .values({
        ...f.tenant,
        conversationId: f.conversationId,
        channelConnectionId: f.connectionId as never,
        direction: "outbound",
        author: "bot",
        kind: "text",
        text: "Leave the house now and call 911 from outside.",
        sequence: counter!.seq,
        status: "sending",
      })
      .returning({ id: messages.id });
    await t.admin.insert(conversationTurns).values({
      ...f.tenant,
      conversationId: f.conversationId,
      ordinal: 1,
      trigger: "inbound_message",
      status: "replied",
      runId: randomUUID(),
      traceId: TRACE,
      throughSeq: 0,
      actions: [
        {
          toolCallId: "t1",
          action: { type: "escalate_emergency", emergencyClass: "gas_leak", summary: "gas" },
          outcome: {
            status: "rejected",
            message: "Emergency alerts are switched off.",
            data: null,
          },
        },
      ],
      replyMessageIds: [message!.id],
    });
    const night = new Date("2026-11-11T04:00:00Z"); // 10 PM in Chicago
    const { deps } = testDeps(t, new TestClock(night));
    const verdict = await t.db
      .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
      .run((ctx) =>
        createQuietHoursGate(deps).check(ctx, {
          messageId: message!.id,
          conversationId: f.conversationId,
          channel: "test",
          sequence: counter!.seq,
          payload: {},
          now: night,
        }),
      );
    expect(verdict).toEqual({ kind: "send" });
  });
});

describe("readiness", () => {
  const none = { sms: null, voice: null, email: null, whatsapp: null };
  const all = createRecordingTransports();

  it("says plainly when an emergency would reach nobody", () => {
    const empty = emergencyReadiness(settingsWith({}).values, all);
    expect(empty).toMatchObject({ ready: false, businessContacts: 0, fallbackContacts: 0 });
    expect(empty.problems).toContain("no_escalation_contacts");
    const noTwilio = emergencyReadiness(
      settingsWith({ "emergency.escalation_chain": [ann] }).values,
      none,
    );
    expect(noTwilio.ready).toBe(false);
    expect(noTwilio.problems).toEqual(
      expect.arrayContaining([
        "sms_not_configured",
        "voice_not_configured",
        "no_reachable_contact",
      ]),
    );
    const ok = emergencyReadiness(
      settingsWith({ "emergency.escalation_chain": [ann] }).values,
      all,
    );
    expect(ok).toMatchObject({ ready: true, businessContacts: 1 });
  });

  it("is offered to the admin panel and flagged in it once a day by the sweeper", async () => {
    const f = await createFixture(t);
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    expect(await createHandoffService(deps).readiness(f.tenant)).toMatchObject({ ready: false });
    const sweep = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.sweep);
    const runSweep = () =>
      drive<"handoff.escalation_started">(sweep, {} as never, clock).then(() =>
        t.admin
          .select()
          .from(alerts)
          .where(
            and(eq(alerts.businessId, f.tenant.businessId), eq(alerts.kind, "emergency_not_ready")),
          ),
      );
    expect(await runSweep()).toHaveLength(1);
    clock.advance(5 * 60_000);
    expect(await runSweep()).toHaveLength(1);
    // Contacts entered: nothing more.
    await setAgencySettings(t, f.tenant.agencyId, {
      "emergency.fallback_contacts": [ann],
    });
    clock.advance(86_400_000);
    expect(await runSweep()).toHaveLength(1);
  });
});
