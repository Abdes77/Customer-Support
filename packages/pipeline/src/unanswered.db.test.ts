import { afterEach, describe, expect, it } from "vitest";

import { eq, messages } from "@repo/db";

import { createHarness, type Harness, message, type TestTenant } from "./testing/harness";
import { countUnansweredMessages, UNANSWERED_AFTER_MS, UNANSWERED_WINDOW_MS } from "./unanswered";

/*
 * What the readiness check counts when the job runner accepts events and never runs them
 * (C18, THREAT_MODEL 4.16). The clock of each count is set from the stored rows' own times,
 * so the test never depends on the real date.
 */
let h: Harness;

afterEach(async () => {
  await h.dispose();
});

async function count(tenant: TestTenant, at: Date): Promise<number> {
  return h.t.db
    .forBusiness(tenant.tenant.businessId)
    .run((ctx) => countUnansweredMessages(ctx, at));
}

async function receivedAt(tenant: TestTenant): Promise<Date> {
  const rows = await h.t.admin
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.businessId, tenant.tenant.businessId));
  return new Date(Math.max(...rows.map((row) => row.createdAt.getTime())));
}

describe("unanswered customer messages (C18)", () => {
  it("counts a message the runner accepted but never ran, between 30 minutes and two hours old", async () => {
    // Events are recorded and never run: a runner that accepts and does nothing.
    h = await createHarness({ runJobs: false });
    const tenant = await h.newTenant();
    expect((await h.deliver(tenant, [message("hello?"), message("anyone?")])).status).toBe(200);
    const at = await receivedAt(tenant);

    expect(await count(tenant, new Date(at.getTime() + UNANSWERED_AFTER_MS - 60_000))).toBe(0);
    expect(await count(tenant, new Date(at.getTime() + UNANSWERED_AFTER_MS + 60_000))).toBe(2);
    expect(await count(tenant, new Date(at.getTime() + UNANSWERED_WINDOW_MS + 60_000))).toBe(0);
    // Another business's messages are not this one's.
    const other = await h.newTenant();
    expect(await count(other, new Date(at.getTime() + UNANSWERED_AFTER_MS + 60_000))).toBe(0);
  });

  it("counts nothing once a turn dealt with the messages, and never counts a reaction", async () => {
    h = await createHarness();
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("my roof leaks")]);
    await h.idle();
    await h.deliver(tenant, [
      {
        type: "reaction",
        id: "r-1",
        from: { id: "visitor-1" },
        targetMessageId: "out-1",
        emoji: "👍",
        sentAt: new Date().toISOString(),
      },
    ]);
    await h.idle();
    const at = await receivedAt(tenant);
    expect(await count(tenant, new Date(at.getTime() + UNANSWERED_AFTER_MS + 60_000))).toBe(0);
  });

  it("does not count a message whose turn ran and failed: that is not a dead runner", async () => {
    h = await createHarness();
    h.engine.respond = async () => {
      throw new Error("the model is down");
    };
    const tenant = await h.newTenant();
    await h.deliver(tenant, [message("hello?")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    expect(conversation?.handledThroughSeq).toBe(0);
    const at = await receivedAt(tenant);
    expect(await count(tenant, new Date(at.getTime() + UNANSWERED_AFTER_MS + 60_000))).toBe(0);
  });
});
