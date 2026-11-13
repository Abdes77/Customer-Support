import { type DeploymentInfo, deploymentInfo, type Env, getEnv, requireEnv } from "@repo/core/env";
import { getDatabase, type LocalAuthStore } from "@repo/db";

import { createLocalAuthProvider } from "./local-provider";
import { resolveAuthMode } from "./mode";
import { createSupabaseAuthProvider } from "./supabase-provider";
import type { AuthProvider, CookieJar } from "./types";

/** True when the app is served over HTTPS, so session cookies get the Secure flag. */
export function isSecureDeployment(env: Env): boolean {
  return env.APP_URL?.startsWith("https://") ?? false;
}

/**
 * The sign-in provider for this deployment, bound to the cookies of one request. Null when
 * no sign-in is configured.
 */
export function createAuthProvider(
  jar: CookieJar,
  options: {
    readonly env?: Env;
    readonly deployment?: DeploymentInfo;
    /** Overrides the user store of the local provider, for tests. */
    readonly localStore?: LocalAuthStore;
  } = {},
): AuthProvider | null {
  const env = options.env ?? getEnv();
  const mode = resolveAuthMode(env, options.deployment ?? deploymentInfo());
  if (mode === "supabase") {
    const config = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return createSupabaseAuthProvider({
      jar,
      url: config.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
  }
  if (mode === "local") {
    const { LOCAL_AUTH_SECRET } = requireEnv(env, "LOCAL_AUTH_SECRET");
    return createLocalAuthProvider({
      jar,
      secret: LOCAL_AUTH_SECRET,
      secure: isSecureDeployment(env),
      store: options.localStore ?? getDatabase().localAuth,
    });
  }
  return null;
}
