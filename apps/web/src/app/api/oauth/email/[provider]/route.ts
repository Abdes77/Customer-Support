import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getEmail } from "@/server/email";
import { createOAuthStartHandler } from "@/server/email/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Starts connecting a Gmail or Microsoft 365 inbox (C11). See `createOAuthStartHandler`. */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createOAuthStartHandler({
    getAccess,
    getEmail,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
