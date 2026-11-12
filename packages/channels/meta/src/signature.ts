import { createHmac, timingSafeEqual } from "node:crypto";

import type { WebhookRequest, WebhookVerification } from "@repo/core";

/*
 * Meta webhooks (WhatsApp, Messenger, Instagram) are verified the same way:
 *
 * - Subscription handshake: `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.
 *   When the token is the one configured in the app, answer 200 with the challenge as the body.
 * - Event delivery: `POST` with `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the payload,
 *   keyed with the app secret>`. The HMAC is computed over the exact bytes received, never over
 *   re-serialized JSON, and compared in constant time.
 *
 * Meta sends no timestamp, so a captured request could be replayed; that is harmless because
 * every message is stored once per provider message id and statuses only move forward.
 */

export const META_SIGNATURE_HEADER = "x-hub-signature-256";

export interface MetaWebhookSecrets {
  /** The app secret (`META_APP_SECRET`). */
  readonly appSecret: string;
  /** The verify token entered in the app's webhook settings (`META_WEBHOOK_VERIFY_TOKEN`). */
  readonly verifyToken: string;
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Compare against a same-length buffer so the timing does not reveal the expected length.
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function metaSignature(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

/** Checks `X-Hub-Signature-256` against the raw body. */
export function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (header === undefined || appSecret.length === 0) return false;
  const presented = header.trim().toLowerCase();
  if (!/^sha256=[0-9a-f]{64}$/.test(presented)) return false;
  return safeEqual(presented, metaSignature(appSecret, rawBody));
}

/**
 * The `verifyWebhook` of every Meta channel adapter: the subscription handshake for GET,
 * the signature for POST. Never throws for a bad request.
 */
export function verifyMetaWebhook(
  request: WebhookRequest,
  secrets: MetaWebhookSecrets,
): WebhookVerification {
  if (request.method === "GET") {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    if (mode !== "subscribe" || token === undefined || challenge === undefined) {
      return { outcome: "rejected", reason: "not_a_subscription_handshake" };
    }
    if (secrets.verifyToken.length === 0 || !safeEqual(token, secrets.verifyToken)) {
      return { outcome: "rejected", reason: "verify_token_mismatch" };
    }
    // The challenge is echoed as plain text; anything but a short token is refused.
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(challenge)) {
      return { outcome: "rejected", reason: "invalid_challenge" };
    }
    return { outcome: "challenge", status: 200, contentType: "text/plain", body: challenge };
  }
  if (
    !verifyMetaSignature(secrets.appSecret, request.rawBody, request.headers[META_SIGNATURE_HEADER])
  ) {
    return { outcome: "rejected", reason: "bad_signature" };
  }
  return { outcome: "verified" };
}
