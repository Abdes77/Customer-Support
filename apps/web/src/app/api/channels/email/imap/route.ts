import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getEmail } from "@/server/email";
import { createImapConnectHandler } from "@/server/email/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Logs in to the IMAP and the SMTP server before anything is stored.
export const maxDuration = 60;

/** Connects an IMAP/SMTP inbox (C11). See `createImapConnectHandler`. */
export function POST(request: Request): Promise<Response> {
  return createImapConnectHandler({
    getAccess,
    getEmail,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request);
}
