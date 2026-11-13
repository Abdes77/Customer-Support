import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getIntegrations } from "@/server/integrations";
import { createCrmOAuthStartHandler } from "@/server/integrations/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Starts connecting HubSpot, GoHighLevel or Jobber (C14). See the handler. */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createCrmOAuthStartHandler({
    getAccess,
    getIntegrations,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
