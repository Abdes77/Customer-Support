import { describe, expect, it } from "vitest";

import { type DeploymentInfo, loadEnv, type NodeEnv } from "@repo/core/env";
import type { BusinessTenant } from "@repo/db";

import {
  authorizedForDetails,
  createReadinessCache,
  evaluateReadiness,
  mayReadDetails,
  type ReadinessFacts,
  readinessBody,
} from "./readiness";

const KEY = Buffer.alloc(32, 7).toString("base64");
const TENANT = {
  agencyId: "0b6f9d4e-7c1a-4c2b-9d3e-5f6a7b8c9d0e",
  businessId: "1c7a0e5f-8d2b-4d3c-8e4f-6a7b8c9d0e1f",
} as BusinessTenant;

const PRODUCTION: Record<string, string> = {
  APP_URL: "https://bot.example.com",
  DATABASE_URL: "postgresql://x@db.example.com/app",
  CREDENTIALS_ENCRYPTION_KEY: KEY,
  TEST_CHANNEL_SECRET: "t".repeat(40),
  WIDGET_SESSION_SECRET: "w".repeat(40),
  NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SENTRY_DSN: "https://k@o1.ingest.sentry.io/1",
};

function facts(
  overrides: Partial<ReadinessFacts> & {
    readonly vars?: Record<string, string | undefined>;
    readonly environment?: DeploymentInfo["environment"];
    readonly runtime?: NodeEnv;
  } = {},
): ReadinessFacts {
  const { vars, environment, runtime, ...rest } = overrides;
  return {
    env: loadEnv({ ...PRODUCTION, ...vars }),
    deployment: { environment: environment ?? "production", commitSha: null, region: null },
    runtime: runtime ?? "production",
    developmentMode: false,
    jobs: "inngest",
    model: "live",
    testChannel: true,
    widget: true,
    errorReporting: true,
    activeBusinesses: async () => [TENANT],
    emergencyReady: async () => ({ enabled: true, ready: true }),
    stuckWork: async () => 0,
    unansweredMessages: async () => 0,
    ...rest,
  };
}

const statusOf = (report: Awaited<ReturnType<typeof evaluateReadiness>>, name: string) =>
  report.checks.find((check) => check.name === name)?.status;

describe("readiness (C17)", () => {
  it("is ready when production is configured as production", async () => {
    const report = await evaluateReadiness(facts());
    expect(report.status).toBe("ready");
    expect(report.checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("fails a self-hosted production build reachable by others that opted into development mode", async () => {
    // DEVELOPMENT_MODE=1 makes deploymentInfo() "local": the in-process runner, the offline
    // model, local storage and per-process secrets come on. Others can reach APP_URL.
    const report = await evaluateReadiness(
      facts({
        environment: "local",
        developmentMode: true,
        jobs: "local",
        model: "offline",
        vars: {
          TEST_CHANNEL_SECRET: undefined,
          NEXT_PUBLIC_SUPABASE_URL: undefined,
          SUPABASE_SERVICE_ROLE_KEY: undefined,
          LOCAL_AUTH_SECRET: "l".repeat(40),
        },
      }),
    );
    expect(report.status).toBe("not_ready");
    const switches = report.checks.find((check) => check.name === "development_switches");
    expect(switches?.status).toBe("fail");
    for (const label of [
      "DEVELOPMENT_MODE=1",
      "in-process job runner",
      "offline model",
      "local file storage",
      "test channel",
    ]) {
      expect(switches?.detail).toContain(label);
    }
  });

  it("accepts the same switches on loopback (the browser tests) and on a developer machine", async () => {
    const devMachine = {
      environment: "local" as const,
      developmentMode: true,
      jobs: "local" as const,
      model: "offline" as const,
      vars: { APP_URL: "http://127.0.0.1:3100", TEST_CHANNEL_SECRET: undefined },
    };
    expect((await evaluateReadiness(facts(devMachine))).status).toBe("ready");
    expect(
      (await evaluateReadiness(facts({ ...devMachine, runtime: "development", vars: {} }))).status,
    ).toBe("ready");
  });

  it("fails without jobs, without the Claude API, without the database", async () => {
    expect(statusOf(await evaluateReadiness(facts({ jobs: "unconfigured" })), "jobs")).toBe("fail");
    expect(statusOf(await evaluateReadiness(facts({ model: "unconfigured" })), "model")).toBe(
      "fail",
    );
    const down = await evaluateReadiness(
      facts({
        activeBusinesses: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    expect(down.status).toBe("not_ready");
    expect(statusOf(down, "database")).toBe("fail");
  });

  it("warns, by business id, when a business's emergencies reach nobody, and on stuck work and missing Sentry", async () => {
    const report = await evaluateReadiness(
      facts({
        errorReporting: false,
        emergencyReady: async () => ({ enabled: true, ready: false }),
        stuckWork: async () => 2,
      }),
    );
    expect(report.status).toBe("ready");
    expect(report.checks.find((check) => check.name === "emergency_contacts")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining(TENANT.businessId),
    });
    expect(statusOf(report, "stuck_work")).toBe("warn");
    expect(statusOf(report, "error_reporting")).toBe("warn");
  });

  it("fails when customer messages wait without a reply turn: a job runner that never runs (C18)", async () => {
    const report = await evaluateReadiness(facts({ unansweredMessages: async () => 3 }));
    expect(report.status).toBe("not_ready");
    expect(statusOf(report, "unanswered")).toBe("fail");
    expect(report.checks.find((item) => item.name === "unanswered")?.detail).toContain(
      "3 customer messages have waited more than 30 minutes",
    );
    // The jobs check alone says "ok": the keys are set. Only the count notices.
    expect(statusOf(report, "jobs")).toBe("ok");
    const unknown = await evaluateReadiness(
      facts({
        unansweredMessages: async () => {
          throw new Error("timeout");
        },
      }),
    );
    expect(statusOf(unknown, "unanswered")).toBe("warn");
    expect(unknown.status).toBe("ready");
  });

  it("shows details only to the holder of the health check token", async () => {
    const env = loadEnv({ ...PRODUCTION, HEALTH_CHECK_TOKEN: "h".repeat(32) });
    const request = (header?: string) =>
      new Request("https://bot.example.com/api/health/ready", {
        headers: header === undefined ? {} : { authorization: header },
      });
    expect(authorizedForDetails(request(`Bearer ${"h".repeat(32)}`), env)).toBe(true);
    expect(authorizedForDetails(request(`Bearer ${"h".repeat(31)}x`), env)).toBe(false);
    expect(authorizedForDetails(request(), env)).toBe(false);
    expect(authorizedForDetails(request(`Bearer ${"h".repeat(32)}`), loadEnv(PRODUCTION))).toBe(
      false,
    );

    const report = await evaluateReadiness(
      facts({ emergencyReady: async () => ({ enabled: true, ready: false }) }),
    );
    // Without the token: the verdict, and nothing that says which protection is off.
    const open = readinessBody(report, false);
    expect(open).toEqual({ status: "ready" });
    const failing = readinessBody(await evaluateReadiness(facts({ jobs: "unconfigured" })), false);
    expect(failing).toEqual({ status: "not_ready" });
    expect(JSON.stringify(readinessBody(report, true))).toContain(TENANT.businessId);
  });

  it("shows the checks without a token on a developer machine only, never on a reachable production build", () => {
    const anonymous = new Request("https://bot.example.com/api/health/ready");
    const who = (
      environment: "local" | "production",
      runtime: "production" | "development",
      url: string,
    ) =>
      mayReadDetails(anonymous, {
        env: loadEnv({ ...PRODUCTION, APP_URL: url }),
        deployment: { environment, commitSha: null, region: null },
        runtime,
      });
    // `pnpm dev`, and the browser tests' production build on loopback.
    expect(who("local", "development", "https://bot.example.com")).toBe(true);
    expect(who("local", "production", "http://127.0.0.1:3100")).toBe(true);
    // DEVELOPMENT_MODE=1 on a server others can reach: the misconfiguration itself.
    expect(who("local", "production", "https://bot.example.com")).toBe(false);
    expect(who("production", "production", "https://bot.example.com")).toBe(false);
    expect(who("production", "production", "http://127.0.0.1:3100")).toBe(false);
  });

  it("evaluates once for all requests of a few seconds, and again after that", async () => {
    let now = 1_000_000;
    let evaluations = 0;
    let fail = false;
    const cached = createReadinessCache({
      now: () => now,
      ttlMs: 15_000,
      evaluate: async () => {
        evaluations += 1;
        if (fail) throw new Error("database down");
        return evaluateReadiness(facts());
      },
    });
    // A burst of anonymous requests costs one evaluation (one database read per business).
    const burst = await Promise.all(Array.from({ length: 50 }, () => cached()));
    expect(new Set(burst).size).toBe(1);
    expect(evaluations).toBe(1);
    now += 14_999;
    await cached();
    expect(evaluations).toBe(1);
    now += 2;
    await cached();
    expect(evaluations).toBe(2);
    // A failed evaluation is not kept: the next request tries again.
    now += 20_000;
    fail = true;
    await expect(cached()).rejects.toThrow("database down");
    fail = false;
    expect((await cached()).status).toBe("ready");
    expect(evaluations).toBe(4);
  });
});
