import { logger, type WebhookRequest } from "@repo/core";
import { DEFAULT_PIPELINE_OPTIONS, type Pipeline } from "@repo/pipeline";

const MAX_WEBHOOK_BYTES = DEFAULT_PIPELINE_OPTIONS.maxWebhookBytes;

/** The framework-free view of a request that channel adapters verify and parse. */
export async function toWebhookRequest(request: Request): Promise<WebhookRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    method: request.method === "GET" ? "GET" : "POST",
    url: request.url,
    headers,
    query: Object.fromEntries(url.searchParams),
    // Read once, as text: signatures are computed over these exact bytes.
    rawBody: request.method === "GET" ? "" : await request.text(),
  };
}

type RouteContext = { params: Promise<{ channel: string }> };

/**
 * The handler behind `/api/webhooks/[channel]`. It contains no channel logic: it builds a
 * `WebhookRequest` and returns what `handleWebhook` decided (ARCHITECTURE §2, step 1).
 */
export function createWebhookHandler(getPipeline: () => Pick<Pipeline, "handleWebhook">) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    const { channel } = await context.params;
    // Refuse an oversized body before reading it; `handleWebhook` checks the bytes again.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    let pipeline: Pick<Pipeline, "handleWebhook">;
    try {
      pipeline = getPipeline();
    } catch (error) {
      logger.error("webhook.pipeline_unavailable", { channel, error });
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    const result = await pipeline.handleWebhook(channel, await toWebhookRequest(request));
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}
