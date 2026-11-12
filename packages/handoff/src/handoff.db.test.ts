import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EventPayload } from "@repo/core";
import {
  alerts,
  auditLog,
  bookings,
  contacts,
  conversations,
  conversationTurns,
  eq,
  escalations,
  messages,
  scheduledJobs,
  sql,
  takeoverLocks,
} from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import type { JobDefinition } from "@repo/jobs";
import { settingsWith } from "@repo/settings";

import { acknowledgeByLink, acknowledgeBySms, ackPageView } from "./emergency/ack";
import { loadEscalation, runChainStep, startEscalation } from "./emergency/escalation";
import { createTwilioWebhookHandlers } from "./emergency/webhooks";
import {
  createHandoffInboundObserver,
  createOptOutGate,
  createQuietHoursGate,
  escalateEmergencyHandler,
} from "./domain";
import { planFollowUp } from "./follow-ups/plan";
import { createHandoffJobs, HANDOFF_FUNCTION_IDS } from "./jobs";
import { recordOptOut } from "./opt-out";
import { createHandoffService } from "./service";
import { startTakeover, touchTakeover } from "./takeover/locks";
import {
  addInbound,
  createFixture,
  createUser,
  drive,
  type Fixture,
  quiet,
  setAgencySettings,
  setBusinessSettings,
  TestClock,
  testDeps,
  TRACE,
} from "./test-fixture";
import { createRecordingTransports, twilioSignature } from "./testing";

/** Tuesday, November 10, 2026, 10:00 AM in Chicago. */
const TUESDAY_10AM = new Date("2026-11-10T16:00:00.000Z");
const OWNER = {
  name: "Owner",
  email: "owner@lonestar.example",
  phone: "+15125550100",
  channels: ["sms" as const, "email" as const],
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

function leadEvent(f: Fixture, extra: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    occurredAt: TUESDAY_10AM.toISOString(),
    traceId: TRACE,
    ...f.tenant,
    conversationId: f.conversationId,
    contactId: f.contactId,
    leadId: f.leadId,
    channel: "test" as const,
    score: 84,
    band: "hot",
    ...extra,
  };
}

async function rowsOf(f: Fixture) {
  return t.admin.select().from(alerts).where(eq(alerts.businessId, f.tenant.businessId));
}

describe("lead alerts", () => {
  it("alerts each recipient by each channel once per lead decision, with the conversation link", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, { "alerts.recipients": [OWNER] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const jobs = createHandoffJobs(deps);

    const qualified = await drive<"lead.qualified">(
      job(jobs, HANDOFF_FUNCTION_IDS.alertQualified),
      leadEvent(f, { routing: "book_meeting" }) as EventPayload<"lead.qualified">,
      clock,
    );
    expect(qualified.result).toEqual({ sent: 2, failed: 0 });
    const link = `https://app.example/inbox/${f.conversationId}`;
    // The settings keep a recipient's channels sorted: email, then text message.
    expect(transports.sent).toEqual([
      expect.objectContaining({
        channel: "email",
        to: "owner@lonestar.example",
        subject: "Hot lead: Pat Lee, water heater replacement",
      }),
      {
        channel: "sms",
        to: "+15125550100",
        text: `Hot lead for Lone Star Plumbing (84): Pat Lee, water heater replacement, via Website chat. ${link}`,
      },
    ]);
    expect(transports.sent[0]?.text).toContain(`Open the conversation (sign-in required): ${link}`);

    // "Wants a meeting" for the same lead is the same decision: no second alert.
    const meeting = await drive<"lead.meeting_requested">(
      job(jobs, HANDOFF_FUNCTION_IDS.alertMeetingRequested),
      leadEvent(f, { bookingMode: "calendar" }) as EventPayload<"lead.meeting_requested">,
      clock,
    );
    expect(meeting.result).toEqual({ alerts: 0 });
    // A customer asking for a person is news of its own.
    const handoff = await drive<"lead.handoff">(
      job(jobs, HANDOFF_FUNCTION_IDS.alertHandoff),
      leadEvent(f, {
        routing: "book_meeting",
        trigger: "customer_request",
        urgency: "normal",
      }) as EventPayload<"lead.handoff">,
      clock,
    );
    expect(handoff.result).toEqual({ sent: 2, failed: 0 });
    expect(transports.sent[3]?.text.startsWith("Needs a person: ")).toBe(true);
    const rows = await rowsOf(f);
    expect(rows.map((row) => [row.kind, row.channel, row.status]).sort()).toEqual([
      ["handoff", "email", "sent"],
      ["handoff", "sms", "sent"],
      ["lead_qualified", "email", "sent"],
      ["lead_qualified", "sms", "sent"],
    ]);
  });

  it("leaves out qualified leads under the minimum score, and holds them overnight when asked", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "alerts.recipients": [OWNER],
      "alerts.minimum_score": 90,
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const jobs = createHandoffJobs(deps);
    const low = await drive<"lead.qualified">(
      job(jobs, HANDOFF_FUNCTION_IDS.alertQualified),
      leadEvent(f, { routing: "contact_later" }) as EventPayload<"lead.qualified">,
      clock,
    );
    expect(low.result).toEqual({ alerts: 0 });
    expect(transports.sent).toEqual([]);

    const g = await createFixture(t);
    await setBusinessSettings(t, g.tenant, {
      "alerts.recipients": [OWNER],
      "alerts.hold_overnight": { enabled: true, start: "21:00", end: "07:00" },
    });
    // 10 PM in Chicago: held until 7 AM.
    clock.set("2026-11-11T04:00:00.000Z");
    const held = await drive<"lead.qualified">(
      job(jobs, HANDOFF_FUNCTION_IDS.alertQualified),
      leadEvent(g, { routing: "contact_later" }) as EventPayload<"lead.qualified">,
      clock,
    );
    expect(held.sleeps[0]).toEqual({ id: "hold", until: "2026-11-11T13:00:00.000Z" });
    expect(held.result).toEqual({ sent: 2, failed: 0 });
    const rows = await rowsOf(g);
    expect(rows.every((row) => row.sentAt?.toISOString() === "2026-11-11T13:00:00.000Z")).toBe(
      true,
    );
  });

  it("records a failed delivery and goes on to the next recipient; retries a passing failure", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "alerts.recipients": [
        { ...OWNER, channels: ["sms"] },
        { ...OWNER, name: "Office", phone: "+15125550111", channels: ["sms"] },
        { ...OWNER, name: "Tech", phone: "+15125550122", channels: ["sms"] },
      ],
    });
    const clock = new TestClock(TUESDAY_10AM);
    let flaky = 0;
    const transports = createRecordingTransports({
      answer: (send) => {
        if (send.to === "+15125550100") {
          return { ok: false, retryable: false, code: "21211", message: "Invalid number" };
        }
        if (send.to === "+15125550122" && flaky < 2) {
          flaky += 1;
          return { ok: false, retryable: true, code: "timeout", message: "Timed out" };
        }
        return { ok: true, providerId: "SM1" };
      },
    });
    const { deps } = testDeps(t, clock, transports);
    const run = await drive<"lead.qualified">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.alertQualified),
      leadEvent(f, { routing: "contact_later" }) as EventPayload<"lead.qualified">,
      clock,
    );
    expect(run.result).toEqual({ sent: 2, failed: 1 });
    expect(run.sleeps.map((sleep) => sleep.id.split("-")[0])).toEqual(["pause", "pause"]);
    const rows = await rowsOf(f);
    const byPhone = Object.fromEntries(rows.map((row) => [row.recipient, row]));
    expect(byPhone["+15125550100"]).toMatchObject({ status: "failed" });
    expect(byPhone["+15125550100"]?.error).toContain("21211");
    expect(byPhone["+15125550111"]).toMatchObject({ status: "sent" });
    expect(byPhone["+15125550122"]).toMatchObject({ status: "sent" });
  });

  it("alerts a message that could not be delivered when the business asks for it", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "alerts.recipients": [{ ...OWNER, channels: ["sms"] }],
      "alerts.events": ["send_failed"],
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const messageId = randomUUID();
    const run = await drive<"message.send_failed">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.alertSendFailed),
      {
        traceId: TRACE,
        ...f.tenant,
        conversationId: f.conversationId,
        messageId: messageId as never,
        channel: "test",
        errorCode: "window_closed",
      },
      clock,
    );
    expect(run.result).toEqual({ sent: 1, failed: 0 });
    expect(transports.sent[0]?.text).toContain(
      "A message could not be delivered to Pat Lee on Website chat (window_closed)",
    );
  });
});

describe("alerts for a conversation that needs a person", () => {
  it("alerts the handoff recipients once a day when an opted-out customer wrote and got no answer", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "alerts.recipients": [{ ...OWNER, channels: ["sms"] }],
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const attention = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.alertAttention);
    const data: EventPayload<"handoff.attention_needed"> = {
      traceId: TRACE,
      ...f.tenant,
      conversationId: f.conversationId,
      reason: "opted_out_customer_wrote",
      day: "2026-11-10",
    };
    const run = await drive<"handoff.attention_needed">(attention, data, clock);
    expect(run.result).toEqual({ sent: 1, failed: 0 });
    expect(transports.sent).toEqual([
      expect.objectContaining({
        channel: "sms",
        to: "+15125550100",
        text: expect.stringMatching(
          /^The customer opted out of automated messages and wrote again; the bot did not answer\. Needs a person: /,
        ),
      }),
    ]);
    expect(transports.sent[0]?.text).toContain(`https://app.example/inbox/${f.conversationId}`);
    // The same day again (a retried run, a second message): nothing more is sent.
    const again = await drive<"handoff.attention_needed">(attention, data, clock);
    expect(again.result).toEqual({ sent: 0, failed: 0 });
    expect(transports.sent).toHaveLength(1);
    const rows = await rowsOf(f);
    expect(rows.map((row) => [row.kind, row.severity, row.status])).toEqual([
      ["handoff", "warning", "sent"],
    ]);
  });
});

describe("emergency chain", () => {
  const ann = { name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms" as const] };
  const bob = {
    name: "Bob",
    phone: "+15125550102",
    email: "bob@lonestar.example",
    alert_by: ["whatsapp" as const, "email" as const],
  };

  async function chainFixture(values: Parameters<typeof setBusinessSettings>[2] = {}) {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "emergency.escalation_chain": [ann, bob],
      "emergency.rounds": 1,
      ...values,
    });
    await setAgencySettings(t, f.tenant.agencyId, {
      "emergency.fallback_contacts": [
        { name: "Agency desk", phone: "+15125550109", email: "", alert_by: ["sms"] },
      ],
    });
    return f;
  }

  async function start(f: Fixture, clock: TestClock) {
    const settings = settingsWith({});
    const { loadSettings } = await import("@repo/settings/server");
    return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run(async (ctx) =>
      startEscalation(ctx, {
        conversationId: f.conversationId,
        emergencyClass: "gas_leak",
        summary: "Smells gas in the kitchen <b>now</b>",
        traceId: TRACE,
        values: (await loadSettings(ctx, f.tenant, { logger: quiet })).values ?? settings.values,
        now: clock.now(),
      }),
    );
  }

  function chainData(f: Fixture, escalationId: string) {
    return { traceId: TRACE, ...f.tenant, escalationId };
  }

  it("alerts, calls and moves on through the chain and the agency when nobody acknowledges", async () => {
    const f = await chainFixture();
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    expect(started).toMatchObject({ started: true, status: "active", contacts: 3 });
    const run = await drive<"handoff.escalation_started">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.emergencyChain),
      chainData(f, started!.escalationId),
      clock,
    );
    expect(run.result).toEqual({ outcome: "exhausted" });
    expect(transports.sent.map((send) => `${send.channel}:${send.to}`)).toEqual([
      "sms:+15125550101",
      "voice:+15125550101",
      "whatsapp:+15125550102",
      "email:bob@lonestar.example",
      "voice:+15125550102",
      "sms:+15125550109",
      "voice:+15125550109",
    ]);
    // Five minutes to acknowledge an alert, two after a call.
    expect(run.sleeps.map((sleep) => sleep.until)).toEqual([
      "2026-11-10T16:05:00.000Z",
      "2026-11-10T16:07:00.000Z",
      "2026-11-10T16:12:00.000Z",
      "2026-11-10T16:14:00.000Z",
      "2026-11-10T16:19:00.000Z",
      "2026-11-10T16:21:00.000Z",
    ]);
    const sms = transports.sent[0]!.text;
    expect(sms).toContain(
      "EMERGENCY for Lone Star Plumbing: Gas smell or gas leak. Pat Lee, +15125550199.",
    );
    expect(sms).toMatch(
      /Reply \d{6} to acknowledge, or open https:\/\/app\.example\/api\/handoff\/ack\//,
    );
    expect(sms).toContain("‹b›now‹/b›");
    expect(transports.sent[1]!.text).toContain('numDigits="1"');
    // The stored rows keep neither the code nor the link's secret.
    const rows = await t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.escalationId, started!.escalationId));
    expect(rows.every((row) => !(row.body ?? "").includes("Reply"))).toBe(true);
    expect(rows.find((row) => row.channel === "sms")?.ackCodeHash).toMatch(/^[0-9a-f]{64}$/);
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, started!.escalationId));
    expect(escalation).toMatchObject({ status: "exhausted", currentStep: 5 });
    const notes = await rowsOf(f);
    expect(notes.find((row) => row.kind === "emergency_unacknowledged")).toMatchObject({
      severity: "critical",
      channel: "in_app",
    });
  });

  it("stops at the first acknowledgement by text-message code, exactly once", async () => {
    const f = await chainFixture();
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    const results: unknown[] = [];
    const run = await drive<"handoff.escalation_started">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.emergencyChain),
      chainData(f, started!.escalationId),
      clock,
      {
        beforeWake: async (sleep) => {
          if (sleep.id !== "wait-0") return;
          const code = /Reply (\d{6})/.exec(transports.sent[0]!.text)![1]!;
          const wrong = code === "000000" ? "111111" : "000000";
          clock.advance(60_000);
          // A stranger's number with the right code, Ann's number with a wrong code.
          results.push(await acknowledgeBySms(deps, { from: "+15125550177", body: code }));
          results.push(await acknowledgeBySms(deps, { from: ann.phone, body: wrong }));
          results.push(await acknowledgeBySms(deps, { from: ann.phone, body: `ok ${code}` }));
          results.push(await acknowledgeBySms(deps, { from: ann.phone, body: code }));
        },
      },
    );
    expect(results).toEqual([
      { kind: "no_match" },
      { kind: "no_match" },
      { kind: "acknowledged", by: "Ann (+15***101)", via: "sms" },
      // The chain has ended: its codes match nothing any more.
      { kind: "no_match" },
    ]);
    expect(run.result).toEqual({ outcome: "stopped", step: 1 });
    expect(transports.sent.map((send) => send.channel)).toEqual(["sms"]);
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, started!.escalationId));
    expect(escalation).toMatchObject({
      status: "acknowledged",
      acknowledgedVia: "sms",
      acknowledgedBy: "Ann (+15***101)",
    });
    expect(escalation?.acknowledgedAt?.toISOString()).toBe("2026-11-10T16:01:00.000Z");
    const audit = await t.admin
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, started!.escalationId));
    expect(audit.map((row) => row.action).sort()).toEqual([
      "emergency.acknowledge",
      "emergency.escalate",
    ]);
  });

  it("acknowledges through the link's page (POST only) and the keypress on the call", async () => {
    const f = await chainFixture({ "emergency.escalation_chain": [ann] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    await runChainStep(deps, f.tenant, started!.escalationId, 0);
    const link = /open (https:\/\/\S+)/.exec(transports.sent[0]!.text)![1]!;
    const token = link.split("/").at(-1)!;
    expect(await ackPageView(deps, token)).toMatchObject({
      state: "active",
      businessName: "Lone Star Plumbing",
      emergencyLabel: "Gas smell or gas leak",
    });
    const forged = `${token.slice(0, -4)}AAAA`;
    expect(await ackPageView(deps, forged)).toBeNull();
    expect(await acknowledgeByLink(deps, forged)).toBeNull();
    expect(await acknowledgeByLink(deps, token)).toEqual({
      kind: "acknowledged",
      by: "Ann (+15***101)",
      via: "link",
    });
    expect(await acknowledgeByLink(deps, token)).toMatchObject({ kind: "already" });
    expect(await ackPageView(deps, token)).toMatchObject({ state: "acknowledged" });

    // A second emergency: the call's keypress, through Twilio's signed callback.
    const g = await chainFixture({ "emergency.escalation_chain": [ann] });
    const second = await start(g, clock);
    await runChainStep(deps, g.tenant, second!.escalationId, 0);
    await runChainStep(deps, g.tenant, second!.escalationId, 1);
    const twiml = transports.sent.at(-1)!.text;
    const action = /action="([^"]+)"/.exec(twiml)![1]!.replaceAll("&amp;", "&");
    const hooks = createTwilioWebhookHandlers({ ...deps, authToken: "twilio-token" });
    const params = { CallSid: "CA00000000000000000000000000000001", Digits: "1" };
    expect((await hooks.voice({ url: action, params, signature: "forged" })).status).toBe(403);
    const answer = await hooks.voice({
      url: action,
      params,
      signature: twilioSignature("twilio-token", action, params),
    });
    expect(answer.body).toContain("The emergency is acknowledged");
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, second!.escalationId));
    expect(escalation).toMatchObject({ status: "acknowledged", acknowledgedVia: "voice" });
    // A third step after the acknowledgement sends nothing.
    const before = transports.sent.length;
    expect(await runChainStep(deps, g.tenant, second!.escalationId, 2)).toMatchObject({
      active: false,
    });
    expect(transports.sent.length).toBe(before);
  });

  it("records one acknowledgement when two arrive at once, whichever wins", async () => {
    const f = await chainFixture({ "emergency.escalation_chain": [ann] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    await runChainStep(deps, f.tenant, started!.escalationId, 0);
    const text = transports.sent[0]!.text;
    const code = /Reply (\d{6})/.exec(text)![1]!;
    const token = /open (\S+)$/.exec(text)![1]!.split("/").at(-1)!;
    const results = await Promise.all([
      acknowledgeByLink(deps, token),
      acknowledgeBySms(deps, { from: ann.phone, body: code }),
      // A step of the chain racing the acknowledgements: it either went out first or not at all.
      runChainStep(deps, f.tenant, started!.escalationId, 1),
    ]);
    const kinds = results.slice(0, 2).map((result) => (result as { kind: string }).kind);
    expect(kinds.filter((kind) => kind === "acknowledged")).toHaveLength(1);
    expect(kinds.find((kind) => kind !== "acknowledged")).toMatch(/^(already|no_match)$/);
    const audit = await t.admin
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, started!.escalationId));
    expect(audit.filter((row) => row.action === "emergency.acknowledge")).toHaveLength(1);
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.id, started!.escalationId));
    expect(escalation?.status).toBe("acknowledged");
    // After it, nothing more goes out.
    const before = transports.sent.length;
    await runChainStep(deps, f.tenant, started!.escalationId, 1);
    expect(transports.sent.length).toBe(before);
  });

  it("answers text-message replies through Twilio's signed webhook", async () => {
    const f = await chainFixture({ "emergency.escalation_chain": [ann] });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, transports } = testDeps(t, clock);
    const started = await start(f, clock);
    await runChainStep(deps, f.tenant, started!.escalationId, 0);
    const code = /Reply (\d{6})/.exec(transports.sent[0]!.text)![1]!;
    const hooks = createTwilioWebhookHandlers({ ...deps, authToken: "twilio-token" });
    const url = "https://app.example/api/handoff/twilio/sms";
    const params = { From: ann.phone, To: "+15125550000", Body: code, MessageSid: "SM1" };
    const answer = await hooks.sms({
      url,
      params,
      signature: twilioSignature("twilio-token", url, params),
    });
    expect(answer).toMatchObject({ status: 200, contentType: "text/xml" });
    expect(answer.body).toContain("acknowledged");
    const noCode = { ...params, Body: "on my way" };
    expect(
      (
        await hooks.sms({
          url,
          params: noCode,
          signature: twilioSignature("twilio-token", url, noCode),
        })
      ).body,
    ).toContain("6-digit code");
    expect((await hooks.sms({ url, params, signature: null })).status).toBe(403);
  });

  it("moves straight on when an alert cannot be sent, and repeats nothing when a step runs again", async () => {
    const f = await chainFixture({ "emergency.escalation_chain": [ann, bob] });
    const clock = new TestClock(TUESDAY_10AM);
    const transports = createRecordingTransports({ missing: ["sms", "voice"] });
    const { deps } = testDeps(t, clock, transports);
    const started = await start(f, clock);
    const step0 = await runChainStep(deps, f.tenant, started!.escalationId, 0);
    // Nothing could reach Ann: no wait.
    expect(step0).toEqual({
      active: true,
      waitUntil: TUESDAY_10AM.toISOString(),
      sent: 0,
      failed: 1,
    });
    const rows = await t.admin
      .select()
      .from(alerts)
      .where(eq(alerts.escalationId, started!.escalationId));
    expect(rows.map((row) => [row.channel, row.status, row.error?.split(":")[0]])).toEqual([
      ["sms", "failed", "not_configured"],
    ]);
    // Bob's alert goes out by WhatsApp and email; the step run again sends nothing new and
    // keeps its deadline.
    await runChainStep(deps, f.tenant, started!.escalationId, 1);
    const step2 = await runChainStep(deps, f.tenant, started!.escalationId, 2);
    clock.advance(30_000);
    const again = await runChainStep(deps, f.tenant, started!.escalationId, 2);
    expect(again.waitUntil).toBe(step2.waitUntil);
    expect(transports.sent.map((send) => send.channel)).toEqual(["whatsapp", "email"]);
  });

  it("starts one chain per conversation, none when emergencies are off, and flags a business with nobody to alert", async () => {
    const f = await chainFixture();
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, events } = testDeps(t, clock);
    const first = await start(f, clock);
    const second = await start(f, clock);
    expect(second).toMatchObject({ escalationId: first!.escalationId, started: false });

    const handler = escalateEmergencyHandler(deps);
    const context = {
      trace: { traceId: TRACE, ...f.tenant, conversationId: f.conversationId },
      mode: "live" as const,
      toolCallId: "tool-1",
      now: TUESDAY_10AM.toISOString(),
      settings: settingsWith({ "emergency.enabled": false }),
      channel: {
        id: "test" as const,
        capabilities: {} as never,
        window: { open: true, closesAt: null },
      },
      business: {} as never,
    };
    const action = {
      type: "escalate_emergency" as const,
      emergencyClass: "gas_leak",
      summary: "gas",
    };
    expect(await handler.handle(action, context)).toMatchObject({ status: "rejected" });
    expect(
      await handler.handle(action, { ...context, mode: "dry_run", settings: settingsWith({}) }),
    ).toMatchObject({ status: "applied" });

    // A business with no chain and no agency fallback.
    const g = await createFixture(t);
    const outcome = await handler.handle(action, {
      ...context,
      trace: { traceId: TRACE, ...g.tenant, conversationId: g.conversationId },
      settings: settingsWith({}),
    });
    expect(outcome).toMatchObject({ status: "applied", data: { alerted: false } });
    const [escalation] = await t.admin
      .select()
      .from(escalations)
      .where(eq(escalations.conversationId, g.conversationId));
    expect(escalation).toMatchObject({ status: "exhausted" });
    expect((await rowsOf(g)).map((row) => [row.kind, row.severity])).toEqual([
      ["emergency_unassigned", "critical"],
    ]);
    // An exhausted chain starts no job.
    expect(events.filter((event) => event.name === "handoff.escalation_started")).toEqual([]);
  });
});

describe("takeover", () => {
  it("releases after the idle time, counting from the last message of either side", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "handoff.auto_release_minutes": 120,
      "handoff.on_release": "check_in",
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, events } = testDeps(t, clock);
    const scope = () => t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId });
    const started = await scope().run((ctx) =>
      startTakeover(ctx, {
        conversationId: f.conversationId,
        source: "admin_panel",
        userId: null,
        reason: "test",
        traceId: TRACE,
        now: clock.now(),
      }),
    );
    expect(started).not.toBeNull();
    const run = await drive<"conversation.takeover_started">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.takeoverRelease),
      {
        traceId: TRACE,
        ...f.tenant,
        conversationId: f.conversationId,
        userId: null,
        source: "admin_panel",
      },
      clock,
      {
        beforeWake: async (sleep) => {
          if (sleep.id !== "idle-0") return;
          // The customer writes an hour in: the idle time starts again.
          clock.set("2026-11-10T17:00:00.000Z");
          await scope().run((ctx) => touchTakeover(ctx, f.conversationId, clock.now()));
        },
      },
    );
    expect(run.result).toEqual({ outcome: "released" });
    expect(run.sleeps.map((sleep) => sleep.until)).toEqual([
      "2026-11-10T18:00:00.000Z",
      "2026-11-10T19:00:00.000Z",
    ]);
    const [lock] = await t.admin
      .select()
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, f.conversationId));
    expect(lock).toMatchObject({ releaseReason: "idle_timeout" });
    expect(lock?.releasedAt?.toISOString()).toBe("2026-11-10T19:00:00.000Z");
    expect(events.map((event) => [event.name, event.id])).toEqual([
      ["conversation.takeover_released", `takeover-released-${lock!.id}`],
      ["conversation.turn_requested", `turn-release-${lock!.id}`],
    ]);
  });

  it("takes over, replies and releases from the admin panel", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, { "handoff.auto_release_minutes": null });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, events, queued } = testDeps(t, clock);
    const service = createHandoffService(deps);
    const userId = await createUser(t);
    expect((await service.takeoverState(f.tenant, f.conversationId)).active).toBe(false);
    await service.sendManualReply({
      tenant: f.tenant,
      conversationId: f.conversationId,
      userId,
      text: "Hi Pat, this is Sam from the office.",
    });
    expect(queued).toEqual([
      expect.objectContaining({
        author: "human_agent",
        text: "Hi Pat, this is Sam from the office.",
      }),
    ]);
    const state = await service.takeoverState(f.tenant, f.conversationId);
    expect(state).toMatchObject({ active: true, source: "admin_panel", releasesAt: null });
    expect(
      await service.takeOver({ tenant: f.tenant, conversationId: f.conversationId, userId }),
    ).toEqual({
      started: false,
    });
    // No idle release for this business: the job leaves it to a person.
    const run = await drive<"conversation.takeover_started">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.takeoverRelease),
      {
        traceId: TRACE,
        ...f.tenant,
        conversationId: f.conversationId,
        userId,
        source: "admin_panel",
      },
      clock,
    );
    expect(run.result).toEqual({ outcome: "manual_only" });
    expect(
      await service.release({ tenant: f.tenant, conversationId: f.conversationId, userId }),
    ).toEqual({
      released: true,
    });
    expect((await service.takeoverState(f.tenant, f.conversationId)).active).toBe(false);
    expect(events.map((event) => event.name)).toEqual([
      "conversation.takeover_started",
      "conversation.takeover_released",
    ]);
  });
});

describe("follow-ups", () => {
  async function plan(f: Fixture, at: Date, nudge: number | null, inboundSeq: number) {
    return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
      planFollowUp(ctx, {
        conversationId: f.conversationId,
        leadId: f.leadId,
        runAt: at,
        payload: {
          reason: nudge === null ? "requested" : "cadence",
          nudge,
          inboundSeq,
          traceId: TRACE,
        },
        now: TUESDAY_10AM,
      }),
    );
  }

  function followUpData(f: Fixture, followUpId: string) {
    return { traceId: TRACE, ...f.tenant, conversationId: f.conversationId, followUpId };
  }

  async function statusOf(followUpId: string) {
    const [row] = await t.admin
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, followUpId));
    return row;
  }

  it("asks the pipeline for the nudge when it is due", async () => {
    const f = await createFixture(t);
    await addInbound(t, f, "How much for a new water heater?", new Date("2026-11-10T15:50:00Z"));
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, events } = testDeps(t, clock);
    const planned = await plan(f, new Date("2026-11-10T18:00:00Z"), 1, 1);
    const run = await drive<"handoff.follow_up_planned">(
      job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.followUp),
      followUpData(f, planned.followUpId),
      clock,
    );
    expect(run.result).toEqual({ outcome: "requested" });
    expect(run.sleeps).toEqual([{ id: "due-0", until: "2026-11-10T18:00:00.000Z" }]);
    expect(events.at(-1)).toMatchObject({
      name: "conversation.turn_requested",
      id: `turn-follow-up-${planned.followUpId}`,
      data: { trigger: "follow_up", requestId: `follow-up-${planned.followUpId}` },
    });
    expect(await statusOf(planned.followUpId)).toMatchObject({ status: "done" });
  });

  it("stops on a reply, an opt-out or a booking that came while it waited", async () => {
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, events } = testDeps(t, clock);
    const followUp = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.followUp);
    const cases: [string, (f: Fixture) => Promise<void>][] = [
      [
        "customer_replied",
        async (f) => void (await addInbound(t, f, "Still thinking", clock.now())),
      ],
      [
        "cancelled",
        async (f) => {
          await t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
            recordOptOut(
              ctx,
              f.contactId,
              {
                at: clock.now().toISOString(),
                source: "admin_panel",
                channel: null,
                conversationId: null,
                messageId: null,
                keyword: null,
                userId: null,
              },
              clock.now(),
            ),
          );
        },
      ],
      [
        "booked",
        async (f) => {
          await t.admin.insert(bookings).values({
            ...f.tenant,
            contactId: f.contactId,
            conversationId: f.conversationId,
            leadId: f.leadId,
            status: "confirmed",
            provider: "manual",
            startsAt: new Date("2026-11-12T15:00:00Z"),
            endsAt: new Date("2026-11-12T16:00:00Z"),
          } as never);
        },
      ],
    ];
    for (const [expected, change] of cases) {
      const f = await createFixture(t);
      await addInbound(t, f, "Hi", new Date("2026-11-10T15:50:00Z"));
      clock.set(TUESDAY_10AM);
      const planned = await plan(f, new Date("2026-11-10T18:00:00Z"), 1, 1);
      const before = events.length;
      const run = await drive<"handoff.follow_up_planned">(
        followUp,
        followUpData(f, planned.followUpId),
        clock,
        { beforeWake: () => change(f) },
      );
      expect(run.result, expected).toEqual({ outcome: expected });
      expect(events.length).toBe(before);
      expect((await statusOf(planned.followUpId))?.status).toBe("cancelled");
    }
  });

  it("waits out the customer's quiet hours, and business hours when it has to", async () => {
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    const followUp = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.followUp);
    const f = await createFixture(t);
    await addInbound(t, f, "Hi", new Date("2026-11-10T15:50:00Z"));
    // Due at 10 PM in Chicago (the contact's area code): sent at 8 AM.
    const night = await plan(f, new Date("2026-11-11T04:00:00Z"), 1, 1);
    const run = await drive<"handoff.follow_up_planned">(
      followUp,
      followUpData(f, night.followUpId),
      clock,
    );
    expect(run.result).toEqual({ outcome: "requested" });
    expect(run.sleeps.map((sleep) => sleep.until)).toEqual([
      "2026-11-11T04:00:00.000Z",
      "2026-11-11T14:00:00.000Z",
    ]);

    // Business hours only: Wednesday is Veterans Day, so Thursday 8 AM.
    const g = await createFixture(t);
    await setBusinessSettings(t, g.tenant, { "follow_up.send_window": "business_hours" });
    await addInbound(t, g, "Hi", new Date("2026-11-10T15:50:00Z"));
    clock.set(TUESDAY_10AM);
    const closed = await plan(g, new Date("2026-11-11T04:00:00Z"), 1, 1);
    const later = await drive<"handoff.follow_up_planned">(
      followUp,
      followUpData(g, closed.followUpId),
      clock,
    );
    expect(later.sleeps.map((sleep) => sleep.until).at(-1)).toBe("2026-11-12T14:00:00.000Z");
  });

  it("keeps to the maximum nudges and to channels whose window has closed", async () => {
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    const followUp = job(createHandoffJobs(deps), HANDOFF_FUNCTION_IDS.followUp);
    const f = await createFixture(t);
    await addInbound(t, f, "Hi", new Date("2026-11-10T15:50:00Z"));
    // The test channel takes the website chat's settings: one nudge.
    const second = await plan(f, new Date("2026-11-10T18:00:00Z"), 2, 1);
    expect(
      (
        await drive<"handoff.follow_up_planned">(
          followUp,
          followUpData(f, second.followUpId),
          clock,
        )
      ).result,
    ).toEqual({ outcome: "max_nudges" });

    const m = await createFixture(t, {
      channel: "messenger",
      lastInboundAt: new Date("2026-11-09T17:00:00Z"),
    });
    await addInbound(t, m, "Hi", new Date("2026-11-09T17:00:00Z"));
    clock.set(TUESDAY_10AM);
    const late = await plan(m, new Date("2026-11-10T18:00:00Z"), 1, 1);
    expect(
      (await drive<"handoff.follow_up_planned">(followUp, followUpData(m, late.followUpId), clock))
        .result,
    ).toEqual({ outcome: "no_allowed_time" });
  });
});

describe("opt-out and the customer's messages", () => {
  it("records an opt-out word once with its time and source, confirms once, and lifts it on an opt-in word", async () => {
    const f = await createFixture(t);
    const clock = new TestClock(TUESDAY_10AM);
    const { deps, queued } = testDeps(t, clock);
    const planned = await t.db
      .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
      .run((ctx) =>
        planFollowUp(ctx, {
          conversationId: f.conversationId,
          leadId: f.leadId,
          runAt: new Date("2026-11-10T18:00:00Z"),
          payload: { reason: "cadence", nudge: 1, inboundSeq: 0, traceId: TRACE },
          now: clock.now(),
        }),
      );
    const observer = createHandoffInboundObserver(deps);
    const store = async (text: string) => {
      const messageId = await addInbound(t, f, text, clock.now());
      return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
        observer.stored(ctx, {
          messageId: messageId as never,
          conversationId: f.conversationId,
          contactId: f.contactId,
          channel: "test",
          kind: "text",
          text,
          traceId: TRACE,
          now: clock.now(),
        }),
      );
    };
    const events = await store("STOP");
    expect(events.map((event) => event.name)).toEqual(["message.send_requested"]);
    expect(queued).toEqual([
      expect.objectContaining({
        purpose: "opt_out_confirmation",
        text: "You won't get any more messages from us. Reply START if you change your mind.",
      }),
    ]);
    const [contact] = await t.admin.select().from(contacts).where(eq(contacts.id, f.contactId));
    expect(contact?.optedOutAt?.toISOString()).toBe(TUESDAY_10AM.toISOString());
    expect(contact?.metadata["optOut"]).toMatchObject({
      source: "keyword",
      keyword: "stop",
      channel: "test",
      conversationId: f.conversationId,
    });
    expect(
      (
        await t.admin.select().from(scheduledJobs).where(eq(scheduledJobs.id, planned.followUpId))
      )[0],
    ).toMatchObject({ status: "cancelled", cancelReason: "opted_out" });
    const audit = await t.admin.select().from(auditLog).where(eq(auditLog.targetId, f.contactId));
    expect(audit.map((row) => row.action)).toEqual(["contact.opt_out"]);

    // Again: already opted out, nothing more is sent.
    clock.advance(60_000);
    expect(await store("stop")).toEqual([]);
    expect(queued).toHaveLength(1);
    // Opting back in.
    expect(await store("Start")).toEqual([]);
    const [after] = await t.admin.select().from(contacts).where(eq(contacts.id, f.contactId));
    expect(after?.optedOutAt).toBeNull();
  });

  it("keeps a takeover awake while the customer writes", async () => {
    const f = await createFixture(t);
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    const scope = () => t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId });
    await scope().run((ctx) =>
      startTakeover(ctx, {
        conversationId: f.conversationId,
        source: "admin_panel",
        userId: null,
        reason: "test",
        traceId: TRACE,
        now: clock.now(),
      }),
    );
    clock.advance(45 * 60_000);
    const messageId = await addInbound(t, f, "Are you still there?", clock.now());
    await scope().run((ctx) =>
      createHandoffInboundObserver(deps).stored(ctx, {
        messageId: messageId as never,
        conversationId: f.conversationId,
        contactId: f.contactId,
        channel: "test",
        kind: "text",
        text: "Are you still there?",
        traceId: TRACE,
        now: clock.now(),
      }),
    );
    const [lock] = await t.admin
      .select()
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, f.conversationId));
    expect(lock?.lastActivityAt.toISOString()).toBe("2026-11-10T16:45:00.000Z");
  });
});

/** A bot message being sent, and the turn that wrote it. */
async function outbound(
  f: Fixture,
  trigger: "inbound_message" | "follow_up",
  actions: unknown[] = [],
  startedAt?: Date,
): Promise<{ messageId: string; sequence: number }> {
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
      text: "Hi",
      sequence: counter!.seq,
      status: "sending",
    })
    .returning({ id: messages.id });
  const [last] = await t.admin
    .select({ ordinal: sql<number>`coalesce(max(${conversationTurns.ordinal}), 0)` })
    .from(conversationTurns)
    .where(eq(conversationTurns.conversationId, f.conversationId));
  await t.admin.insert(conversationTurns).values({
    ...f.tenant,
    conversationId: f.conversationId,
    ordinal: Number(last?.ordinal ?? 0) + 1,
    trigger,
    status: "replied",
    runId: randomUUID(),
    traceId: TRACE,
    throughSeq: 0,
    actions,
    replyMessageIds: [message!.id],
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  return { messageId: message!.id, sequence: counter!.seq };
}

describe("quiet-hours gate", () => {
  async function check(f: Fixture, message: { messageId: string; sequence: number }, at: Date) {
    const clock = new TestClock(at);
    const { deps } = testDeps(t, clock);
    return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
      createQuietHoursGate(deps).check(ctx, {
        messageId: message.messageId as never,
        conversationId: f.conversationId,
        channel: "test",
        sequence: message.sequence,
        payload: {},
        now: at,
      }),
    );
  }

  const NIGHT = new Date("2026-11-11T04:00:00Z"); // 10 PM in Chicago

  it("holds unprompted messages until quiet hours end and drops a nudge the customer overtook", async () => {
    const f = await createFixture(t);
    const nudge = await outbound(f, "follow_up");
    expect(await check(f, nudge, NIGHT)).toEqual({
      kind: "hold",
      until: "2026-11-11T14:00:00.000Z",
      reason: "quiet_hours",
    });
    expect(await check(f, nudge, TUESDAY_10AM)).toEqual({ kind: "send" });
    await addInbound(t, f, "Actually, yes", NIGHT);
    expect(await check(f, nudge, new Date("2026-11-11T14:00:00Z"))).toEqual({
      kind: "withhold",
      reason: "customer_replied",
    });
  });

  it("holds replies only when the business asks for it, and never an emergency's", async () => {
    const f = await createFixture(t);
    const reply = await outbound(f, "inbound_message");
    expect(await check(f, reply, NIGHT)).toEqual({ kind: "send" });
    await setBusinessSettings(t, f.tenant, { "hours.quiet_hours_cover_replies": true });
    expect(await check(f, reply, NIGHT)).toMatchObject({
      kind: "hold",
      reason: "quiet_hours_reply",
    });
    const emergency = await outbound(f, "inbound_message", [
      {
        toolCallId: "t1",
        action: { type: "escalate_emergency", emergencyClass: "gas_leak", summary: "gas" },
        outcome: { status: "applied", message: null, data: null },
      },
    ]);
    expect(await check(f, emergency, NIGHT)).toEqual({ kind: "send" });
  });
});

describe("opt-out gate", () => {
  const OPTED_OUT_AT = new Date("2026-11-10T15:00:00.000Z");
  const LATER = new Date("2026-11-10T15:30:00.000Z");
  const EARLIER = new Date("2026-11-10T14:30:00.000Z");

  async function check(
    f: Fixture,
    message: { messageId: string; sequence: number },
    payload: Record<string, unknown> = {},
  ) {
    const { deps } = testDeps(t, new TestClock(TUESDAY_10AM));
    return t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
      createOptOutGate(deps).check(ctx, {
        messageId: message.messageId as never,
        conversationId: f.conversationId,
        channel: "test",
        sequence: message.sequence,
        payload,
        now: TUESDAY_10AM,
      }),
    );
  }

  async function optOut(f: Fixture) {
    await t.admin
      .update(contacts)
      .set({ optedOutAt: OPTED_OUT_AT })
      .where(eq(contacts.id, f.contactId));
  }

  it("lets everything through for a customer who did not opt out", async () => {
    const f = await createFixture(t);
    expect(await check(f, await outbound(f, "follow_up"))).toEqual({ kind: "send" });
  });

  it("by default lets only the confirmation and emergency answers reach an opted-out customer", async () => {
    const f = await createFixture(t);
    await optOut(f);
    const withheld = { kind: "withhold", reason: "opted_out" };
    expect(await check(f, await outbound(f, "follow_up"))).toEqual(withheld);
    expect(await check(f, await outbound(f, "inbound_message", [], LATER))).toEqual(withheld);
    expect(await check(f, await outbound(f, "inbound_message"), { purpose: "reminder" })).toEqual(
      withheld,
    );
    expect(
      await check(f, await outbound(f, "inbound_message"), { purpose: "opt_out_confirmation" }),
    ).toEqual({ kind: "send" });
    // An emergency answer goes, even one written just before the opt-out.
    expect(
      await check(
        f,
        await outbound(
          f,
          "inbound_message",
          [
            {
              toolCallId: "t1",
              action: { type: "escalate_emergency", emergencyClass: "gas_leak", summary: "gas" },
              outcome: { status: "applied", message: null, data: null },
            },
          ],
          EARLIER,
        ),
      ),
    ).toEqual({
      kind: "send",
    });
  });

  it('with "proactive_only", lets replies written after the opt-out through, nothing else', async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, { "follow_up.opt_out_scope": "proactive_only" });
    await optOut(f);
    expect(await check(f, await outbound(f, "inbound_message", [], LATER))).toEqual({
      kind: "send",
    });
    expect(await check(f, await outbound(f, "inbound_message", [], EARLIER))).toEqual({
      kind: "withhold",
      reason: "opted_out",
    });
    expect(await check(f, await outbound(f, "follow_up", [], LATER))).toEqual({
      kind: "withhold",
      reason: "opted_out",
    });
  });

  it("answers while an emergency in the conversation is running or recent", async () => {
    const f = await createFixture(t);
    await optOut(f);
    await t.db.forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId }).run((ctx) =>
      startEscalation(ctx, {
        conversationId: f.conversationId,
        emergencyClass: "gas_leak",
        summary: null,
        traceId: TRACE,
        values: settingsWith({}).values,
        now: LATER,
      }),
    );
    expect(await check(f, await outbound(f, "inbound_message", [], LATER))).toEqual({
      kind: "send",
    });
    // A nudge still never goes.
    expect(await check(f, await outbound(f, "follow_up", [], LATER))).toEqual({
      kind: "withhold",
      reason: "opted_out",
    });
  });
});

describe("escalations in the admin panel", () => {
  it("lists a chain with its alerts and lets a signed-in person acknowledge it", async () => {
    const f = await createFixture(t);
    await setBusinessSettings(t, f.tenant, {
      "emergency.escalation_chain": [
        { name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms"] },
      ],
    });
    const clock = new TestClock(TUESDAY_10AM);
    const { deps } = testDeps(t, clock);
    const { loadSettings } = await import("@repo/settings/server");
    const started = await t.db
      .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
      .run(async (ctx) =>
        startEscalation(ctx, {
          conversationId: f.conversationId,
          emergencyClass: "flooding",
          summary: null,
          traceId: TRACE,
          values: (await loadSettings(ctx, f.tenant, { logger: quiet })).values,
          now: clock.now(),
        }),
      );
    await runChainStep(deps, f.tenant, started!.escalationId, 0);
    const service = createHandoffService(deps);
    const [view] = await service.listEscalations(f.tenant);
    expect(view).toMatchObject({
      status: "active",
      emergencyClass: "flooding",
      alerts: [{ channel: "sms", contactName: "Ann", status: "sent" }],
    });
    const userId = await createUser(t);
    expect(
      await service.acknowledgeEscalation({
        tenant: f.tenant,
        escalationId: started!.escalationId,
        userId,
        userLabel: "sam@agency.example",
      }),
    ).toEqual({ kind: "acknowledged", by: "sam@agency.example", via: "admin_panel" });
    const loaded = await t.db
      .forBusiness(f.tenant.businessId, { agencyId: f.tenant.agencyId })
      .run((ctx) => loadEscalation(ctx, started!.escalationId));
    expect(loaded?.status).toBe("acknowledged");
  });
});
