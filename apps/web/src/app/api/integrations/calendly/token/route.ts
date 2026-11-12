import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getScheduling } from "@/server/scheduling";
import { createCalendlyTokenHandler } from "@/server/scheduling/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/** Connects Calendly with a personal access token (C12). See the handler. */
export function POST(request: Request): Promise<Response> {
  return createCalendlyTokenHandler({
    getAccess,
    getScheduling,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request);
}
