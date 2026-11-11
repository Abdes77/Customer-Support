import type { NextRequest, NextResponse } from "next/server";

import { logger } from "@repo/core";
import { deploymentInfo, getEnv, requireEnv } from "@repo/core/env";

import { ProxyCookieJar } from "./cookies";
import { refreshLocalSession } from "./local-session";
import { resolveAuthMode } from "./mode";
import { createSupabaseAuthProvider } from "./supabase-provider";

/**
 * Renews the session cookies of a request. This is all `proxy.ts` does: it keeps sessions
 * alive, it does not decide who may see what. Every page, server action and route handler
 * checks the user itself (ARCHITECTURE §3).
 *
 * It deliberately imports nothing that opens a database connection.
 */
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const jar = new ProxyCookieJar(request);
  try {
    const env = getEnv();
    const mode = resolveAuthMode(env, deploymentInfo());
    if (mode === "supabase") {
      const config = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
      await createSupabaseAuthProvider({
        jar,
        url: config.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      }).refresh();
    } else if (mode === "local") {
      const { LOCAL_AUTH_SECRET } = requireEnv(env, "LOCAL_AUTH_SECRET");
      refreshLocalSession(jar, {
        secret: LOCAL_AUTH_SECRET,
        secure: env.APP_URL?.startsWith("https://") ?? false,
        now: new Date(),
      });
    }
  } catch (error) {
    // A failed refresh must not take the site down: the request goes on with the cookies it
    // came with, and the page's own check decides.
    logger.error("auth.refresh.failed", { error });
  }
  return jar.response;
}
