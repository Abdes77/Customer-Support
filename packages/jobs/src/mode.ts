import { type DeploymentInfo, deploymentInfo, type Env, getEnv } from "@repo/core/env";

/**
 * Which runner executes the jobs in this process.
 *
 * - "inngest": Inngest Cloud (INNGEST_EVENT_KEY set) or the Inngest dev server (INNGEST_DEV=1,
 *   honoured on a developer machine only).
 * - "local": the in-process runner. Only when neither is configured and the process is not
 *   on a hosted deployment, so a developer can run `pnpm dev` with nothing else and still see
 *   replies. Pending work is lost on restart; it is never used on Vercel.
 * - "unconfigured": a hosted deployment without Inngest. Sending an event fails with a
 *   ConfigError that names the missing variables.
 */
export type JobsMode = "inngest" | "local" | "unconfigured";

/**
 * Whether the Inngest client may run in dev mode. In dev mode the Inngest SDK does not verify
 * the signature of calls to `/api/inngest`, so anyone who can reach the deployment could run
 * the functions with any payload. A hosted deployment (Vercel production or preview) always
 * talks to Inngest Cloud with signed requests, whatever INNGEST_DEV says.
 */
export function inngestDevAllowed(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): boolean {
  const hosted = deployment.environment === "production" || deployment.environment === "preview";
  return env.INNGEST_DEV === true && !hosted;
}

export function jobsModeFromEnv(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): JobsMode {
  if (env.INNGEST_EVENT_KEY !== undefined || inngestDevAllowed(env, deployment)) return "inngest";
  return deployment.environment === "local" ? "local" : "unconfigured";
}
