import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  DeliveryStatus,
  InboundAttachment,
  IsoDateTime,
  type WebhookRequest,
  type WebhookVerification,
} from "@repo/core";

/*
 * The test channel's wire format. It is ours, so it is small: a JSON body with the receiving
 * account and a list of events, signed like most providers sign their webhooks.
 *
 *   POST /api/webhooks/test
 *   x-test-timestamp: 1794430000
 *   x-test-signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the channel secret>
 *
 * The timestamp must be within five minutes of the server clock, so a captured request
 * cannot be replayed later; a replay inside the window is harmless because messages are
 * stored once per provider message id.
 */

export const TEST_SIGNATURE_HEADER = "x-test-signature";
export const TEST_TIMESTAMP_HEADER = "x-test-timestamp";
export const TEST_SIGNATURE_TOLERANCE_SECONDS = 300;

const Text = z.string().max(20_000);
const ExternalId = z.string().min(1).max(200);

export const TestSender = z.object({
  id: ExternalId,
  name: z.string().max(200).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
  email: z.email().nullable().default(null),
});

export const TestWebhookEvent = z.discriminatedUnion("type", [
  /** A customer message. */
  z.object({
    type: z.literal("message"),
    id: ExternalId,
    from: TestSender,
    text: Text.nullable(),
    sentAt: IsoDateTime,
    attachments: z.array(InboundAttachment).max(10).default([]),
    replyTo: ExternalId.nullable().default(null),
  }),
  /** A customer reaction to a message. */
  z.object({
    type: z.literal("reaction"),
    id: ExternalId,
    from: TestSender,
    targetMessageId: ExternalId,
    emoji: z.string().max(16).nullable(),
    removed: z.boolean().default(false),
    sentAt: IsoDateTime,
  }),
  /** Delivery status of a message we sent. */
  z.object({
    type: z.literal("status"),
    messageId: ExternalId,
    status: DeliveryStatus,
    occurredAt: IsoDateTime,
    error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  }),
  /** Someone at the business answered from the provider's own inbox. */
  z.object({
    type: z.literal("human_reply"),
    contactId: ExternalId,
    messageId: ExternalId,
    text: Text.nullable(),
    occurredAt: IsoDateTime,
  }),
  /** The business removed our access. */
  z.object({
    type: z.literal("revoked"),
    reason: z.string().max(500),
    occurredAt: IsoDateTime,
  }),
]);
export type TestWebhookEvent = z.input<typeof TestWebhookEvent>;

export const TestWebhookBody = z.object({
  /** The receiving account: the test connection's `external_account_id`. */
  accountId: ExternalId,
  events: z.array(TestWebhookEvent).min(1).max(50),
});
export type TestWebhookBody = z.input<typeof TestWebhookBody>;

/** The external account id of a business's test connection. */
export function testAccountIdFor(businessId: string): string {
  return `test-${businessId}`;
}

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** The headers that make `rawBody` a valid test-channel webhook. */
export function signTestWebhook(
  secret: string,
  rawBody: string,
  now: Date = new Date(),
): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    "content-type": "application/json",
    [TEST_TIMESTAMP_HEADER]: timestamp,
    [TEST_SIGNATURE_HEADER]: sign(secret, timestamp, rawBody),
  };
}

/** A complete, signed webhook request, for the dev chat page and tests. */
export function buildTestWebhookRequest(options: {
  readonly secret: string;
  readonly body: TestWebhookBody;
  readonly url?: string;
  readonly now?: Date;
}): WebhookRequest {
  const rawBody = JSON.stringify(options.body);
  return {
    method: "POST",
    url: options.url ?? "http://localhost/api/webhooks/test",
    headers: signTestWebhook(options.secret, rawBody, options.now),
    query: {},
    rawBody,
  };
}

/** Checks the signature and the timestamp of a test-channel webhook in constant time. */
export function verifyTestWebhook(
  request: WebhookRequest,
  secret: string,
  now: Date,
): WebhookVerification {
  if (request.method !== "POST") return { outcome: "rejected", reason: "method_not_allowed" };
  const timestamp = request.headers[TEST_TIMESTAMP_HEADER];
  const signature = request.headers[TEST_SIGNATURE_HEADER];
  if (timestamp === undefined || signature === undefined) {
    return { outcome: "rejected", reason: "missing_signature" };
  }
  if (!/^\d{1,12}$/.test(timestamp)) return { outcome: "rejected", reason: "bad_timestamp" };
  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (skew > TEST_SIGNATURE_TOLERANCE_SECONDS) {
    return { outcome: "rejected", reason: "stale_timestamp" };
  }
  const expected = Buffer.from(sign(secret, timestamp, request.rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { outcome: "rejected", reason: "bad_signature" };
  }
  return { outcome: "verified" };
}
