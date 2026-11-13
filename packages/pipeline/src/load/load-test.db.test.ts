import { describe, expect, it } from "vitest";

import { loadTestRefusal } from "./guard";
import { distribution, runLoadTest } from "./load-test";

/*
 * The load test itself is a command (`pnpm load:test`), too slow for `pnpm verify`. This keeps
 * it working: the same code on two businesses with short waits, and its guard.
 */
describe("load test (C18)", () => {
  it("runs end to end on a small scale and finds nothing wrong", async () => {
    const report = await runLoadTest({
      businesses: 2,
      conversationsPerBusiness: 2,
      bursts: 2,
      messagesPerBurst: 2,
      messageGapMs: 50,
      startSpreadMs: 200,
      replyWaitSeconds: 0,
      debouncePeriodMs: 300,
      poolSize: 6,
    });
    expect(report.failures).toEqual([]);
    expect(report.conversations).toBe(4);
    expect(report.inboundMessages).toBeGreaterThanOrEqual(16);
    expect(report.replyTurns).toBe(8);
    expect(report.capped?.emergencyAnswered).toBe(true);
    expect(report.capped?.noticesPerStoppedConversation.every((count) => count === 1)).toBe(true);
  }, 180_000);

  it("refuses anything but a local test database server", () => {
    expect(loadTestRefusal({})).toBeNull();
    expect(loadTestRefusal({ NODE_ENV: "production" })).toMatch(/production/);
    expect(loadTestRefusal({ VERCEL_ENV: "preview" })).toMatch(/deployment/);
    expect(
      loadTestRefusal({ TEST_DATABASE_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres" }),
    ).toMatch(/not this machine/);
    expect(
      loadTestRefusal({
        TEST_DATABASE_URL: "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_dev",
        DATABASE_URL: "postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_dev",
      }),
    ).toMatch(/same database/);
  });

  it("summarizes timings", () => {
    expect(distribution([5, 1, 3, 2, 4])).toEqual({ count: 5, p50: 3, p95: 5, max: 5 });
    expect(distribution([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
  });
});
