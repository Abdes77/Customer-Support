/**
 * Readiness (C17): whether this deployment can serve customers safely right now. The app
 * gathers the facts (`apps/web/src/server/health`); the rules that turn them into a verdict
 * are here, pure and tested.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  readonly name: string;
  readonly status: CheckStatus;
  /** A sentence for the operator. Ids at most, never customer data or secrets. */
  readonly detail: string;
}

export interface ReadinessReport {
  /** "not_ready" when any check failed; warnings do not stop traffic. */
  readonly status: "ready" | "not_ready";
  readonly checks: readonly ReadinessCheck[];
}

export function summarize(checks: readonly ReadinessCheck[]): ReadinessReport {
  return {
    status: checks.some((check) => check.status === "fail") ? "not_ready" : "ready",
    checks,
  };
}

/** Switches that only a developer machine may have on. */
export interface DevelopmentSwitches {
  /** DEVELOPMENT_MODE=1 on a production build off Vercel. */
  readonly developmentMode: boolean;
  /** Jobs run inside the web process instead of Inngest. */
  readonly inProcessJobs: boolean;
  /** Replies come from the rule-based stand-in instead of the Claude API. */
  readonly offlineModel: boolean;
  /** The built-in password sign-in (LOCAL_AUTH_SECRET) instead of Supabase Auth. */
  readonly localSignIn: boolean;
  /** Files in a folder on this machine instead of Supabase Storage. */
  readonly localStorage: boolean;
  /** The test channel (and /dev/chat) signed with a per-process secret. */
  readonly processTestChannelSecret: boolean;
  /** Website-chat sessions signed with a per-process secret. */
  readonly processWidgetSecret: boolean;
  /** Inngest's dev mode, which does not check request signatures. */
  readonly inngestDev: boolean;
}

const SWITCH_LABELS: Readonly<Record<keyof DevelopmentSwitches, string>> = {
  developmentMode: "DEVELOPMENT_MODE=1",
  inProcessJobs: "in-process job runner",
  offlineModel: "offline model",
  localSignIn: "local sign-in",
  localStorage: "local file storage",
  processTestChannelSecret: "test channel with a per-process secret (/dev/chat)",
  processWidgetSecret: "website chat with a per-process secret",
  inngestDev: "Inngest dev mode",
};

/**
 * Fails when a development-only switch is on in a production build that others can reach
 * (APP_URL not on this machine). On a developer machine, or a production build on loopback
 * (the browser tests), the switches are expected and only listed.
 */
export function developmentSwitchCheck(facts: {
  readonly productionBuild: boolean;
  readonly loopback: boolean;
  readonly switches: DevelopmentSwitches;
}): ReadinessCheck {
  const on = (Object.keys(SWITCH_LABELS) as (keyof DevelopmentSwitches)[])
    .filter((key) => facts.switches[key])
    .map((key) => SWITCH_LABELS[key]);
  if (on.length === 0) {
    return { name: "development_switches", status: "ok", detail: "None is on." };
  }
  if (facts.productionBuild && !facts.loopback) {
    return {
      name: "development_switches",
      status: "fail",
      detail: `A production build reachable by others has development-only switches on: ${on.join(", ")}. Remove DEVELOPMENT_MODE and configure the production services (docs/HUMAN_TODO.md).`,
    };
  }
  return {
    name: "development_switches",
    status: "ok",
    detail: `Development machine: ${on.join(", ")}.`,
  };
}

/**
 * Businesses whose emergencies would reach nobody (C13's `readiness`). A warning, not a
 * failure: a business may go live knowingly without phone alerts (DECISIONS 253), but the
 * state must be visible wherever the deployment's health is read.
 */
export function emergencyReadinessCheck(facts: {
  readonly checked: number;
  readonly notReady: readonly string[];
}): ReadinessCheck {
  if (facts.notReady.length === 0) {
    return {
      name: "emergency_contacts",
      status: "ok",
      detail: `Emergencies reach a person for all ${facts.checked} active businesses with emergency handling on.`,
    };
  }
  return {
    name: "emergency_contacts",
    status: "warn",
    detail: `Emergencies reach nobody for ${facts.notReady.length} of ${facts.checked} active businesses: ${facts.notReady.slice(0, 20).join(", ")}${facts.notReady.length > 20 ? ", …" : ""}.`,
  };
}
