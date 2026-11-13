import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getIntegrations } from "@/server/integrations";
import { createCrmOAuthCallbackHandler } from "@/server/integrations/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The code exchange and the connection test.
export const maxDuration = 60;

/** Finishes connecting HubSpot, GoHighLevel or Jobber (C14). See the handler. */
export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createCrmOAuthCallbackHandler({
    getAccess,
    getIntegrations,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
