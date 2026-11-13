import { getEnv } from "@repo/core/env";

import { createAckRouteHandlers } from "@/server/handoff/routes";
import { getServerPipeline } from "@/server/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function handlers(request: Request) {
  return createAckRouteHandlers({
    twilio: () => getServerPipeline().handoff.twilio,
    handoff: () => getServerPipeline().handoff.deps,
    appUrl: getEnv().APP_URL ?? new URL(request.url).origin,
  });
}

/**
 * The page an emergency alert links to (C13). Opening it acknowledges nothing (link scanners
 * and previews open links); its button posts back to the same address.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return handlers(request).get(token);
}

/** Acknowledges the emergency: the alerts stop for everyone, once. */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return handlers(request).post(token);
}
