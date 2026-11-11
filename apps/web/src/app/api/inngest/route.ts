import { serve } from "inngest/next";
import type { NextRequest } from "next/server";

import { getEnv } from "@repo/core/env";

import { getServerPipeline, inngestFunctions } from "@/server/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One Inngest step runs per request; the longest is a model call (ARCHITECTURE §4).
export const maxDuration = 300;

type Handlers = ReturnType<typeof serve>;
let handlers: Handlers | null = null;

/** Built on first request, so `next build` needs no Inngest configuration. */
function inngestHandlers(): Handlers | null {
  if (handlers !== null) return handlers;
  const server = getServerPipeline();
  if (server.inngest === null) return null;
  const env = getEnv();
  handlers = serve({
    client: server.inngest,
    functions: inngestFunctions(server),
    ...(env.INNGEST_SIGNING_KEY === undefined ? {} : { signingKey: env.INNGEST_SIGNING_KEY }),
    ...(env.INNGEST_SIGNING_KEY_FALLBACK === undefined
      ? {}
      : { signingKeyFallback: env.INNGEST_SIGNING_KEY_FALLBACK }),
  });
  return handlers;
}

function notServed(): Response {
  // Jobs run in this process (local development without Inngest) or are not configured.
  return Response.json({ error: "inngest_not_configured" }, { status: 404 });
}

export async function GET(request: NextRequest, context: unknown): Promise<Response> {
  return (await inngestHandlers()?.GET(request, context)) ?? notServed();
}

export async function POST(request: NextRequest, context: unknown): Promise<Response> {
  return (await inngestHandlers()?.POST(request, context)) ?? notServed();
}

export async function PUT(request: NextRequest, context: unknown): Promise<Response> {
  return (await inngestHandlers()?.PUT(request, context)) ?? notServed();
}
