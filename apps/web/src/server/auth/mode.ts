import {
  type DeploymentInfo,
  deploymentInfo,
  type Env,
  getEnv,
  hasEnv,
  isLoopbackUrl,
  type NodeEnv,
  nodeEnv,
} from "@repo/core/env";

/**
 * Which sign-in the deployment uses.
 *
 * - "supabase": Supabase Auth. Production, and any environment with a Supabase project.
 * - "local": the built-in sign-in for development and CI, where there is no Supabase
 *   project. It needs LOCAL_AUTH_SECRET, a database set up by the compatibility bootstrap,
 *   and a developer machine (`deploymentInfo()` "local"): never on Vercel, and a production
 *   build (`next start`) only with `DEVELOPMENT_MODE=1` (C17) and while APP_URL is this
 *   machine (localhost, 127.0.0.1, ::1), as the browser tests run it. A server reachable by
 *   others never has it.
 * - "unconfigured": neither. The sign-in page says so; nothing else is reachable.
 */
export type AuthMode = "supabase" | "local" | "unconfigured";

export { isLoopbackUrl };

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
