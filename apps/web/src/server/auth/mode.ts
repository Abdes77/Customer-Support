import {
  type DeploymentInfo,
  deploymentInfo,
  type Env,
  getEnv,
  hasEnv,
  type NodeEnv,
  nodeEnv,
} from "@repo/core/env";

/**
 * Which sign-in the deployment uses.
 *
 * - "supabase": Supabase Auth. Production, and any environment with a Supabase project.
 * - "local": the built-in sign-in for development and CI, where there is no Supabase
 *   project. It needs LOCAL_AUTH_SECRET, a database set up by the compatibility bootstrap,
 *   and it is never chosen on Vercel, whatever the variables say. A production build (`next
 *   start`, as the browser tests run it) gets it only while APP_URL is this machine
 *   (localhost, 127.0.0.1, ::1), so a server reachable by others never has it.
 * - "unconfigured": neither. The sign-in page says so; nothing else is reachable.
 */
export type AuthMode = "supabase" | "local" | "unconfigured";

/** True for an APP_URL on this machine only. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function resolveAuthMode(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
  runtime: NodeEnv = nodeEnv(),
): AuthMode {
  if (hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY")) return "supabase";
  if (
    env.LOCAL_AUTH_SECRET !== undefined &&
    deployment.environment === "local" &&
    (runtime !== "production" || isLoopbackUrl(env.APP_URL))
  ) {
    return "local";
  }
  return "unconfigured";
}
