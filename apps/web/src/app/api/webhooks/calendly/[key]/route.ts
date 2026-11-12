import { getServerPipeline } from "@/server/pipeline";
import { handleCalendlyWebhook } from "@/server/scheduling/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Calendly deliveries for one connection (C12): the key names the connection, the signature
 * is checked over the raw body with its signing key. See `createCalendlyWebhookHandler`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await context.params;
  return handleCalendlyWebhook(request, key, getServerPipeline().scheduling.calendlyWebhook);
}
