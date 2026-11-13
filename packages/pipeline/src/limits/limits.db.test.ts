import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineTurnInput } from "@repo/core";
import {
  alerts,
  and,
  businesses,
  conversations,
  conversationTurns,
  eq,
  escalations,
  modelCalls,
  takeoverLocks,
} from "@repo/db";
import { settingsWith } from "@repo/settings";

import { createHarness, type Harness, message, reply, type TestTenant } from "../testing/harness";
import { exceededLimit, type LimitUsage, startOfDay, startOfMonth } from "./usage";
import { mayDescribeEmergency } from "./guard";

/*
 * The limits guard (C17) end to end, on a fixed clock: 2026-06-15 12:00 in New York, so the
 * business day of the test is the same whatever the real time is. Rows the database stamps
 * itself (messages) carry the real time, which is after the clock and so inside every window.
 */
const NOW = new Date("2026-06-15T16:00:00.000Z");

let h: Harness;
let calls: EngineTurnInput[];

beforeEach(async () => {
  h = await createHarness({ clock: () => new Date(NOW) });
  calls = [];
  h.engine.respond = async (input) => {
    calls.push(input);
    return reply("Thanks, we can help with that.");
  };
});

afterEach(async () => {
  await h.dispose();
});

async function turnsOf(tenant: TestTenant) {
  return h.t.admin
    .select({ status: conversationTurns.status, skipReason: conversationTurns.skipReason })
    .from(conversationTurns)
    .where(eq(conversationTurns.businessId, tenant.tenant.businessId))
    .orderBy(conversationTurns.startedAt, conversationTurns.ordinal);
}

async function limitAlerts(tenant: TestTenant) {
  return h.t.admin
    .select({ dedupeKey: alerts.dedupeKey, severity: alerts.severity, payload: alerts.payload })
    .from(alerts)
    .where(and(eq(alerts.businessId, tenant.tenant.businessId), eq(alerts.kind, "limit_reached")));
}

async function spend(
  tenant: TestTenant,
  microUsd: number,
  options: { conversationId?: string | null; traceId?: string; at?: Date } = {},
) {
  await h.t.admin.insert(modelCalls).values({
    ...tenant.tenant,
    conversationId: (options.conversationId ?? null) as never,
    traceId: (options.traceId ?? randomUUID()) as never,
    purpose: "reply",
    model: "claude-fable-5-2",
    effort: "medium",
    promptVersion: "test",
    startedAt: options.at ?? NOW,
    latencyMs: 10,
    costMicroUsd: microUsd,
  });
}

const notices = (rows: Awaited<ReturnType<Harness["messagesOf"]>>) =>
  rows.filter((row) => row.payload["purpose"] === "limit_notice");

describe("rate limits (C17)", () => {
  it("stops a flooding customer before any model call, tells them once and alerts the agency", async () => {
    const tenant = await h.newTenant({ "limits.contact_messages_per_hour": 5 });
    await h.deliver(
      tenant,
      Array.from({ length: 6 }, (_, index) => message(`question ${index + 1}`)),
    );
    await h.idle();
    expect(calls).toHaveLength(0);

    let rows = await h.messagesOf(tenant);
    expect(notices(rows)).toHaveLength(1);
    expect(notices(rows)[0]).toMatchObject({ author: "bot", status: "sent" });
    expect(notices(rows)[0]!.text).toContain("call 911");
    expect(await turnsOf(tenant)).toEqual([
      { status: "skipped", skipReason: "limits:contact_messages_per_hour" },
    ]);
    const [alert] = await limitAlerts(tenant);
    expect(alert).toMatchObject({ severity: "warning" });
    expect(alert!.dedupeKey).toMatch(/^limit_reached:contact_messages_per_hour:contact:/);

    // More messages the same day: still silent, no second notice, no second alert.
    await h.deliver(tenant, [message("hello?")]);
    await h.idle();
    rows = await h.messagesOf(tenant);
    expect(calls).toHaveLength(0);
    expect(notices(rows)).toHaveLength(1);
    expect(await limitAlerts(tenant)).toHaveLength(1);
    // The customer's messages are all stored and unread for the team.
    expect(rows.filter((row) => row.direction === "inbound")).toHaveLength(7);
    const [conversation] = await h.conversationsOf(tenant);
    expect(conversation!.unreadCount).toBeGreaterThanOrEqual(7);
  });

  it("answers a message that may describe an emergency past a limit, a few times a day", async () => {
    const tenant = await h.newTenant({ "limits.contact_messages_per_hour": 5 });
    await h.deliver(
      tenant,
      Array.from({ length: 6 }, (_, index) => message(`spam ${index}`)),
    );
    await h.idle();
    expect(calls).toHaveLength(0);

    for (let index = 0; index < 4; index += 1) {
      await h.deliver(tenant, [message("I smell gas in the kitchen")]);
      await h.idle();
    }
    // Three emergency turns past the limit get the engine (safety instructions first); the
    // fourth no longer does, so "gas" cannot reopen a flood.
    expect(calls).toHaveLength(3);
    const turns = await turnsOf(tenant);
    expect(turns.filter((turn) => turn.status === "replied")).toHaveLength(3);
    expect(turns.at(-1)).toEqual({
      status: "skipped",
      skipReason: "limits:contact_messages_per_hour",
    });
  });

  it("counts the bot's replies per customer per day", async () => {
    const tenant = await h.newTenant({ "limits.contact_replies_per_day": 5 });
    for (let index = 0; index < 6; index += 1) {
      await h.deliver(tenant, [message(`question ${index}`)]);
      await h.idle();
    }
    expect(calls).toHaveLength(5);
    expect((await turnsOf(tenant)).at(-1)).toEqual({
      status: "skipped",
      skipReason: "limits:contact_replies_per_day",
    });
  });
});

describe("spend caps (C17)", () => {
  it("pauses a business at its daily cap; model calls of emergencies and of other days do not count", async () => {
    const tenant = await h.newTenant({ "limits.business_daily_spend_usd": 1 });
    // Yesterday's spend and an emergency's spend are not counted.
    await spend(tenant, 5_000_000, { at: new Date(NOW.getTime() - 2 * 86_400_000) });
    const trace = randomUUID();
    await spend(tenant, 5_000_000, { traceId: trace });
    await h.t.admin.insert(escalations).values({
      ...tenant.tenant,
      emergencyClass: "gas_leak",
      status: "acknowledged",
      traceId: trace as never,
    } as never);
    await spend(tenant, 900_000);
    await h.deliver(tenant, [message("Can you quote a roof?")]);
    await h.idle();
    expect(calls).toHaveLength(1);

    // Today's ordinary spend reaches $1: the next turn is stopped, loudly.
    await spend(tenant, 100_000);
    await h.deliver(tenant, [message("And gutters?")]);
    await h.idle();
    expect(calls).toHaveLength(1);
    expect((await turnsOf(tenant)).at(-1)).toEqual({
      status: "skipped",
      skipReason: "limits:business_daily_spend",
    });
    const [alert] = await limitAlerts(tenant);
    expect(alert).toMatchObject({ severity: "critical" });
    expect(
      h.logs.some((record) => record.level === "error" && record.msg === "limits.cap_reached"),
    ).toBe(true);
  });

  it("caps one customer's spend per day without stopping the business", async () => {
    const tenant = await h.newTenant({ "limits.contact_daily_spend_usd": 0.5 });
    await h.deliver(tenant, [message("first", { from: "visitor-1" })]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    await spend(tenant, 600_000, { conversationId: conversation!.id });
    await h.deliver(tenant, [message("second", { from: "visitor-1" })]);
    await h.deliver(tenant, [message("hello", { from: "visitor-2" })]);
    await h.idle();
    // visitor-1: 1 call, then capped; visitor-2: answered.
    expect(calls).toHaveLength(2);
    expect(calls.map((input) => input.pending.map((turn) => turn.text).join())).toEqual([
      "first",
      "hello",
    ]);
  });

  it("caps the whole agency across its businesses", async () => {
    const tenant = await h.newTenant({});
    // The agency-wide cap is a global setting.
    const { applySettingChanges } = await import("@repo/settings/server");
    await h.t.db.forAgency(tenant.tenant.agencyId).run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "global", agencyId: tenant.tenant.agencyId },
        changes: [{ key: "limits.agency_daily_spend_usd", value: 2 }],
        actor: { type: "system", label: "limits test" },
      }),
    );
    // Another business of the same agency spent $2 today.
    const [other] = await h.t.admin
      .insert(businesses)
      .values({
        agencyId: tenant.tenant.agencyId,
        name: "Other",
        slug: `other-${randomUUID().slice(0, 8)}`,
        status: "paused",
      })
      .returning({ id: businesses.id });
    await spend({ ...tenant, tenant: { ...tenant.tenant, businessId: other!.id } }, 2_000_000);
    await h.deliver(tenant, [message("hi")]);
    await h.idle();
    expect(calls).toHaveLength(0);
    expect((await turnsOf(tenant)).at(-1)?.skipReason).toBe("limits:agency_daily_spend");
  });

  it("hands the conversation to people when the business asks for it", async () => {
    const tenant = await h.newTenant({
      "limits.contact_messages_per_hour": 5,
      "limits.on_limit": "handoff",
    });
    await h.deliver(
      tenant,
      Array.from({ length: 6 }, (_, index) => message(`question ${index}`)),
    );
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    const locks = await h.t.admin
      .select({ source: takeoverLocks.source, reason: takeoverLocks.reason })
      .from(takeoverLocks)
      .where(eq(takeoverLocks.conversationId, conversation!.id));
    expect(locks).toEqual([{ source: "rule", reason: "limit:contact_messages_per_hour" }]);
    expect(h.events.named("handoff.attention_needed").map((event) => event.data.reason)).toEqual([
      "limit_reached",
    ]);
    // The notice still reaches the customer: it is exempt from the takeover it started.
    expect(notices(await h.messagesOf(tenant))[0]).toMatchObject({ status: "sent" });
  });

  it("leaves a business under its limits alone", async () => {
    const tenant = await h.newTenant({});
    await h.deliver(tenant, [message("hi")]);
    await h.idle();
    expect(calls).toHaveLength(1);
    expect(await limitAlerts(tenant)).toEqual([]);
    const rows = await h.t.admin
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.businessId, tenant.tenant.businessId));
    expect(rows).toHaveLength(1);
  });
});

describe("limit rules (pure)", () => {
  const usage: LimitUsage = {
    contactMessagesLastHour: 0,
    contactRepliesToday: 0,
    businessRepliesToday: 0,
    contactSpendToday: 0,
    businessSpendToday: 0,
    businessSpendThisMonth: 0,
    agencySpendToday: null,
  };
  const values = settingsWith({
    "limits.contact_messages_per_hour": 10,
    "limits.business_monthly_spend_usd": 50,
  }).values;

  it("never stops a follow-up for what the customer wrote, and stops it for everything else", () => {
    const flood = { ...usage, contactMessagesLastHour: 11 };
    expect(exceededLimit(flood, values, "inbound_message")).toBe("contact_messages_per_hour");
    expect(exceededLimit(flood, values, "follow_up")).toBeNull();
    const spent = { ...usage, businessSpendThisMonth: 50_000_000 };
    expect(exceededLimit(spent, values, "follow_up")).toBe("business_monthly_spend");
    expect(
      exceededLimit({ ...usage, businessSpendThisMonth: 49_999_999 }, values, "follow_up"),
    ).toBeNull();
  });

  it("treats an empty cap as no cap", () => {
    const none = settingsWith({
      "limits.business_replies_per_day": null,
      "limits.business_daily_spend_usd": null,
      "limits.contact_daily_spend_usd": null,
    }).values;
    expect(
      exceededLimit(
        { ...usage, businessRepliesToday: 1e6, businessSpendToday: 1e12, contactSpendToday: 1e12 },
        none,
        "inbound_message",
      ),
    ).toBeNull();
  });

  it("finds the business day and month in the business's own zone, across daylight saving", () => {
    expect(startOfDay(new Date("2026-03-08T15:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-06-15T03:00:00Z"), "America/Denver").toISOString()).toBe(
      "2026-06-14T06:00:00.000Z",
    );
    expect(
      startOfMonth(new Date("2026-11-01T03:00:00Z"), "America/Los_Angeles").toISOString(),
    ).toBe("2026-10-01T07:00:00.000Z");
  });

  it("recognizes the business's emergency phrases, names and keys, not ordinary words", () => {
    const classes = settingsWith({}).values["emergency.classes"];
    expect(mayDescribeEmergency(["I SMELL GAS!!"], classes)).toBe(true);
    expect(mayDescribeEmergency(["there is a gas leak"], classes)).toBe(true);
    expect(mayDescribeEmergency(["need a quote for gutters"], classes)).toBe(false);
    expect(mayDescribeEmergency([], classes)).toBe(false);
  });
});
