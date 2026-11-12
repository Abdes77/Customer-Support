import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getWhatsApp } from "@/server/whatsapp";
import { createEmbeddedSignupHandler } from "@/server/whatsapp/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Five calls to Meta (code exchange, numbers, subscription, registration, templates).
export const maxDuration = 60;

/** Finishes WhatsApp Embedded Signup for a business (C9). See `createEmbeddedSignupHandler`. */
export function POST(request: Request): Promise<Response> {
  return createEmbeddedSignupHandler({
    getAccess,
    getWhatsApp,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request);
}
