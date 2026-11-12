import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getScheduling } from "@/server/scheduling";
import { createCalendarOAuthStartHandler } from "@/server/scheduling/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Starts connecting Google Calendar, Outlook or Calendly (C12). See the handler. */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createCalendarOAuthStartHandler({
    getAccess,
    getScheduling,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
