import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getWhatsApp } from "@/server/whatsapp";
import { createTokenConnectHandler } from "@/server/whatsapp/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Up to four calls to Meta (numbers, subscription, registration, templates).
export const maxDuration = 60;

/**
 * Connects a WhatsApp number with an access token typed into the admin panel. See
 * `createTokenConnectHandler`.
 */
export function POST(request: Request): Promise<Response> {
  return createTokenConnectHandler({
    getAccess,
    getWhatsApp,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request);
}
