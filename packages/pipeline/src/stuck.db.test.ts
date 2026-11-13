import { afterEach, describe, expect, it } from "vitest";

import { alerts, and, eq, messages } from "@repo/db";

import { enqueueBotMessage } from "./outbound";
import { createHarness, type Harness, message } from "./testing/harness";

/*
 * Alerts on stuck work (C17). The sweep's clock is set from the stored rows' own times, so
 * the test never depends on the real date.
 */
let h: Harness;
let now = new Date(0);

afterEach(async () => {
  await h.dispose();
});

async function stuckAlerts(businessId: string) {
  return h.t.admin
    .select({ kind: alerts.kind, severity: alerts.severity, dedupeKey: alerts.dedupeKey })
    .from(alerts)
    .where(and(eq(alerts.businessId, businessId as never), eq(alerts.channel, "in_app")));
}

describe("stuck work alerts", () => {
  it("raises one critical alert, and one error log, for a reply that never went out", async () => {
    h = await createHarness({ runJobs: false, clock: () => now });
    const tenant = await h.newTenant();
    now = new Date();
    await h.deliver(tenant, [message("hello")]);
    const [conversation] = await h.conversationsOf(tenant);
    const queued = await h.t.db.forBusiness(tenant.tenant.businessId).run((ctx) =>
      enqueueBotMessage(ctx, {
        conversationId: conversation!.id,
        text: "Thanks!",
        traceId: conversation!.id,
        purpose: "reminder",
      }),
    );
    const [row] = await h.t.admin
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, queued!.messageId as never));

    // 29 minutes: still on its way (the sweeper re-sends it), no alarm yet.
    now = new Date(row!.createdAt.getTime() + 29 * 60_000);
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    expect(await stuckAlerts(tenant.tenant.businessId)).toEqual([]);

    now = new Date(row!.createdAt.getTime() + 31 * 60_000);
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    expect(await stuckAlerts(tenant.tenant.businessId)).toEqual([
      { kind: "send_stuck", severity: "critical", dedupeKey: `send_stuck:${queued!.messageId}` },
    ]);
    expect(h.logs.filter((record) => record.msg === "send.stuck")).toHaveLength(1);
  });

  it("raises an alert for a customer message whose turn never started", async () => {
    h = await createHarness({ runJobs: false, clock: () => now });
    const tenant = await h.newTenant();
    now = new Date();
    h.events.failures = 1;
    expect((await h.deliver(tenant, [message("anyone there?")])).status).toBe(500);
    const [row] = await h.t.admin
      .select({ createdAt: messages.createdAt, enqueuedAt: messages.enqueuedAt })
      .from(messages)
      .where(eq(messages.businessId, tenant.tenant.businessId));
    expect(row!.enqueuedAt).toBeNull();

    now = new Date(row!.createdAt.getTime() + 11 * 60_000);
    await h.pipeline.sweep({ ...tenant.tenant, status: "active" });
    const found = await stuckAlerts(tenant.tenant.businessId);
    expect(found.map((alert) => alert.kind)).toEqual(["ingest_stuck"]);
    expect(h.logs.some((record) => record.level === "error" && record.msg === "ingest.stuck")).toBe(
      true,
    );
  });
});
