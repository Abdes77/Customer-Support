import { timingSafeEqual } from "node:crypto";

import { type DeploymentInfo, type Env, hasEnv, isLoopbackUrl, type NodeEnv } from "@repo/core/env";
import type { BusinessTenant } from "@repo/db";
import { inngestDevAllowed, type JobsMode } from "@repo/jobs";
import {
  type CheckStatus,
  developmentSwitchCheck,
  type DevelopmentSwitches,
  emergencyReadinessCheck,
  type ReadinessCheck,
  type ReadinessReport,
  summarize,
} from "@repo/observability";

import { resolveAuthMode } from "../auth/mode";

/**
 * Readiness (C17, `GET /api/health/ready`): whether this deployment can serve customers
 * safely. The rules are in `@repo/observability`; this file gathers the facts from the
 * environment, the composed pipeline and the database.
 *
 * Failing checks (503): the database does not answer; background jobs or the Claude API are
 * not configured; a variable the product cannot run without is missing; a development-only
 * switch is on in a production build that others can reach. Warnings (still 200): Sentry is
 * off in a production build; businesses whose emergencies reach nobody (by id); stuck work
 * alerted in the last day.
 */

export interface ReadinessFacts {
  readonly env: Env;
  readonly deployment: DeploymentInfo;
  readonly runtime: NodeEnv;
  /** `DEVELOPMENT_MODE=1` on a production build off Vercel (`developmentModeRequested()`). */
  readonly developmentMode: boolean;
  readonly jobs: JobsMode;
  readonly model: "live" | "offline" | "unconfigured";
  /** The test channel runs (on a per-process secret when TEST_CHANNEL_SECRET is unset). */
  readonly testChannel: boolean;
  /** The website chat runs (on a per-process secret when WIDGET_SESSION_SECRET is unset). */
  readonly widget: boolean;
  readonly errorReporting: boolean;
  /** Active businesses, or a thrown error when the database does not answer. */
  readonly activeBusinesses: () => Promise<readonly BusinessTenant[]>;
  /** Whether an emergency at this business reaches a person (C13), when handling is on. */
  readonly emergencyReady: (tenant: BusinessTenant) => Promise<{
    readonly enabled: boolean;
    readonly ready: boolean;
  }>;
  /** Stuck-work alerts (send_stuck, ingest_stuck) raised in the last day, per business. */
  readonly stuckWork: (tenant: BusinessTenant) => Promise<number>;
}

const REQUIRED_IN_PRODUCTION = ["APP_URL", "DATABASE_URL", "CREDENTIALS_ENCRYPTION_KEY"] as const;

export function developmentSwitches(facts: ReadinessFacts): DevelopmentSwitches {
  const { env, deployment } = facts;
  const supabaseStorage = hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
  return {
    developmentMode: facts.developmentMode,
    inProcessJobs: facts.jobs === "local",
    offlineModel: facts.model === "offline",
    localSignIn: resolveAuthMode(env, deployment, facts.runtime) === "local",
    localStorage: !supabaseStorage && deployment.environment === "local",
    processTestChannelSecret: facts.testChannel && env.TEST_CHANNEL_SECRET === undefined,
    processWidgetSecret: facts.widget && env.WIDGET_SESSION_SECRET === undefined,
    inngestDev: inngestDevAllowed(env, deployment),
  };
}

const check = (name: string, status: CheckStatus, detail: string): ReadinessCheck => ({
  name,
  status,
  detail,
});

export async function evaluateReadiness(facts: ReadinessFacts): Promise<ReadinessReport> {
  const productionBuild = facts.runtime === "production";
  const hosted = facts.deployment.environment !== "local";
  const checks: ReadinessCheck[] = [];

  checks.push(
    developmentSwitchCheck({
      productionBuild,
      loopback: isLoopbackUrl(facts.env.APP_URL),
      switches: developmentSwitches(facts),
    }),
  );

  const missing = REQUIRED_IN_PRODUCTION.filter((name) => facts.env[name] === undefined);
  checks.push(
    missing.length > 0 && hosted
      ? check("configuration", "fail", `Missing: ${missing.join(", ")}.`)
      : check("configuration", "ok", "The variables the product needs are set."),
  );
  checks.push(
    facts.jobs === "unconfigured"
      ? check(
          "jobs",
          "fail",
          "Background jobs are not configured: set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY.",
        )
      : check("jobs", "ok", facts.jobs === "inngest" ? "Inngest." : "In-process runner."),
  );
  checks.push(
    facts.model === "unconfigured"
      ? check("model", "fail", "The Claude API is not configured: set ANTHROPIC_API_KEY.")
      : check("model", "ok", facts.model === "live" ? "Claude API." : "Offline stand-in."),
  );
  checks.push(
    facts.errorReporting
      ? check("error_reporting", "ok", "Errors are reported to Sentry.")
      : check(
          "error_reporting",
          productionBuild ? "warn" : "ok",
          "SENTRY_DSN is not set: errors reach the logs only.",
        ),
  );

  let businesses: readonly BusinessTenant[];
  try {
    businesses = await facts.activeBusinesses();
    checks.push(check("database", "ok", "The database answers."));
  } catch {
    checks.push(check("database", "fail", "The database does not answer."));
    return summarize(checks);
  }

  const notReady: string[] = [];
  let checked = 0;
  let stuck = 0;
  for (const tenant of businesses) {
    try {
      const emergency = await facts.emergencyReady(tenant);
      if (emergency.enabled) {
        checked += 1;
        if (!emergency.ready) notReady.push(tenant.businessId);
      }
      stuck += await facts.stuckWork(tenant);
    } catch {
      notReady.push(tenant.businessId);
    }
  }
  checks.push(emergencyReadinessCheck({ checked, notReady }));
  checks.push(
    stuck > 0
      ? check(
          "stuck_work",
          "warn",
          `${stuck} message${stuck === 1 ? "" : "s"} got stuck in the last day (see the alerts).`,
        )
      : check("stuck_work", "ok", "No stuck messages in the last day."),
  );
  return summarize(checks);
}

/** Whether the request carries the health check token (constant-time comparison). */
export function authorizedForDetails(request: Request, env: Env): boolean {
  const token = env.HEALTH_CHECK_TOKEN;
  if (token === undefined) return false;
  const presented = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What the route answers: the verdict always; each check's name and status always (they
 * say nothing about a tenant); the details (which variables, which businesses) only with
 * the token, or on a developer machine.
 */
export function readinessBody(
  report: ReadinessReport,
  detailed: boolean,
): {
  readonly status: ReadinessReport["status"];
  readonly checks: readonly { name: string; status: CheckStatus; detail?: string }[];
} {
  return {
    status: report.status,
    checks: report.checks.map((item) =>
      detailed
        ? { name: item.name, status: item.status, detail: item.detail }
        : { name: item.name, status: item.status },
    ),
  };
}
