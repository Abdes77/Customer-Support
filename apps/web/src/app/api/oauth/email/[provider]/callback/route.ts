import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getEmail } from "@/server/email";
import { createOAuthCallbackHandler } from "@/server/email/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The code exchange, the mailbox's profile and the watch or subscription.
export const maxDuration = 60;

/** Finishes connecting a Gmail or Microsoft 365 inbox (C11). See `createOAuthCallbackHandler`. */
export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createOAuthCallbackHandler({
    getAccess,
    getEmail,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
