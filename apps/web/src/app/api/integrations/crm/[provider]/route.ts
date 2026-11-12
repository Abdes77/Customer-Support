import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import { getAccess } from "@/server/auth";
import { getIntegrations } from "@/server/integrations";
import { createCrmKeyConnectHandler } from "@/server/integrations/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The token request (ServiceTitan) and the connection test.
export const maxDuration = 60;

/** Connects a CRM with a key or client credentials (C14). See the handler. */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await context.params;
  return createCrmKeyConnectHandler({
    getAccess,
    getIntegrations,
    directory: getDatabase().directory,
    appUrl: getEnv().APP_URL,
  })(request, provider);
}
