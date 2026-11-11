import { type DeploymentInfo, deploymentInfo, type Env, getEnv, hasEnv } from "@repo/core/env";

/**
 * Which sign-in the deployment uses.
 *
 * - "supabase": Supabase Auth. Production, and any environment with a Supabase project.
 * - "local": the built-in sign-in for development and CI, where there is no Supabase
 *   project. It needs LOCAL_AUTH_SECRET, a database set up by the compatibility bootstrap,
 *   and it is never chosen on Vercel, whatever the variables say.
 * - "unconfigured": neither. The sign-in page says so; nothing else is reachable.
 */
export type AuthMode = "supabase" | "local" | "unconfigured";

export function resolveAuthMode(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): AuthMode {
  if (hasEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY")) return "supabase";
  if (env.LOCAL_AUTH_SECRET !== undefined && deployment.environment === "local") return "local";
  return "unconfigured";
}
