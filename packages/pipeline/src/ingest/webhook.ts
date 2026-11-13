import {
  AppError,
  ChannelId,
  type ParsedWebhook,
  ParsedWebhook as ParsedWebhookSchema,
  type WebhookRequest,
} from "@repo/core";

import type { PipelineContext } from "../deps";
import { ingest } from "./ingest";

/** What the route sends back. Bodies never echo anything from the request. */
export interface WebhookResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function json(status: number, body: Record<string, unknown>): WebhookResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

/**
 * ARCHITECTURE §2, steps 1 to 7: the whole synchronous part of an inbound webhook. The route
 * only builds a `WebhookRequest` from the raw request and writes this response.
 *
 * - unknown channel, or no adapter registered for it: 404
 * - body too large: 413
 * - signature, timestamp or verify token rejected: 401 (logged without the body; nothing
 *   is stored, invariant I1)
 * - subscription handshake: the adapter's answer
 * - payload the adapter cannot parse: 400
 * - storing or emitting failed: 500, so the provider retries
 * - otherwise 200, with counts only
 */
export async function handleWebhook(
  p: PipelineContext,
  channel: string,
  request: WebhookRequest,
): Promise<WebhookResponse> {
  const channelId = ChannelId.safeParse(channel);
  const adapter = channelId.success ? p.adapters.find(channelId.data) : undefined;
  if (!channelId.success || adapter === undefined) return json(404, { error: "not_found" });
  const log = p.logger.child({ channel: channelId.data });

  if (Buffer.byteLength(request.rawBody, "utf8") > p.options.maxWebhookBytes) {
    log.warn("webhook.too_large", { bytes: Buffer.byteLength(request.rawBody, "utf8") });
    return json(413, { error: "payload_too_large" });
  }

  let verification;
  try {
    verification = await adapter.verifyWebhook(request);
  } catch (error) {
    log.error("webhook.verify_failed", { error });
    return json(500, { error: "internal" });
  }
  if (verification.outcome === "rejected") {
    log.warn("webhook.rejected", { reason: verification.reason, method: request.method });
    return json(401, { error: "unauthorized" });
  }
  if (verification.outcome === "challenge") {
    return {
      status: verification.status,
      headers: { "content-type": verification.contentType, "cache-control": "no-store" },
      body: verification.body,
    };
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  let parsed: ParsedWebhook;
  try {
    parsed = await adapter.parseWebhook(request);
  } catch (error) {
    const invalid = error instanceof AppError && error.code === "validation_failed";
    log.warn("webhook.unparseable", { error: invalid ? error.message : error });
    return invalid ? json(400, { error: "bad_request" }) : json(500, { error: "internal" });
  }
  const checked = ParsedWebhookSchema.safeParse(parsed);
  if (!checked.success) {
    log.error("webhook.contract_mismatch", {
      paths: checked.error.issues.map((issue) => issue.path.join(".")),
    });
    return json(400, { error: "bad_request" });
  }

  try {
    const result = await ingest(p, checked.data);
    log.info("webhook.ingested", { ...result });
    return json(200, { ok: true, ...result });
  } catch (error) {
    log.error("webhook.ingest_failed", { error });
    return json(500, { error: "internal" });
  }
}
