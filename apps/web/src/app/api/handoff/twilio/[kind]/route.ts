import { getEnv } from "@repo/core/env";

import { createTwilioRouteHandler } from "@/server/handoff/routes";
import { getServerPipeline } from "@/server/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Twilio's callbacks for alerts (C13): `sms` (a reply to an alert text acknowledges with its
 * code), `voice` (the keypress on an escalation call), `status` (delivery of a text or call).
 * Each is checked with Twilio's signature over the public URL and the form parameters.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await context.params;
  const handler = createTwilioRouteHandler({
    twilio: () => getServerPipeline().handoff.twilio,
    handoff: () => getServerPipeline().handoff.deps,
    appUrl: getEnv().APP_URL ?? new URL(request.url).origin,
  });
  return handler(request, kind);
}
