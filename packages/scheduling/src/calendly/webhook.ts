import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/*
 * Calendly webhooks (docs read on 2026-11-12, "Webhook Signatures"): the header
 * `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>` is the HMAC-SHA256, keyed with the
 * webhook signing key, of `<t>.<raw body>`. The body is checked as received (never
 * re-serialized), compared in constant time, and refused when `t` is outside the tolerance,
 * so a captured delivery cannot be replayed later.
 */

export const CALENDLY_SIGNATURE_HEADER = "calendly-webhook-signature";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "mismatch" | "stale" };

export function signCalendlyPayload(key: string, timestamp: number, rawBody: string): string {
  const digest = createHmac("sha256", key).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyCalendlySignature(input: {
  readonly header: string | null | undefined;
  readonly rawBody: string;
  readonly keys: readonly string[];
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): SignatureCheck {
  if (input.header === null || input.header === undefined || input.header.length === 0) {
    return { ok: false, reason: "missing" };
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value !== undefined && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value !== undefined && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed" };
  let matched = false;
  for (const key of input.keys) {
    if (key.length === 0) continue;
    const expected = Buffer.from(
      createHmac("sha256", key).update(`${timestamp}.${input.rawBody}`, "utf8").digest("hex"),
    );
    for (const signature of signatures) {
      const given = Buffer.from(signature);
      if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
    }
  }
  if (!matched) return { ok: false, reason: "mismatch" };
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.now.getTime() / 1000 - timestamp) > tolerance) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, timestamp };
}

const ScheduledEvent = z
  .object({
    uri: z.string().min(1),
    start_time: z.string().min(1),
    end_time: z.string().min(1),
    event_type: z.string().nullish(),
    status: z.string().optional(),
  })
  .passthrough();

const InviteePayload = z
  .object({
    uri: z.string().min(1),
    email: z.string().nullish(),
    name: z.string().nullish(),
    status: z.string().optional(),
    timezone: z.string().nullish(),
    rescheduled: z.boolean().optional(),
    old_invitee: z.string().nullish(),
    new_invitee: z.string().nullish(),
    reschedule_url: z.string().nullish(),
    cancel_url: z.string().nullish(),
    tracking: z
      .object({
        utm_source: z.string().nullish(),
        utm_content: z.string().nullish(),
        utm_campaign: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    scheduled_event: ScheduledEvent,
    cancellation: z.object({ reason: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

export const CalendlyWebhookBody = z
  .object({
    event: z.string().min(1),
    created_at: z.string().optional(),
    created_by: z.string().nullish(),
    payload: z.unknown(),
  })
  .passthrough();

export type CalendlyInvitee = z.infer<typeof InviteePayload>;

export type CalendlyDelivery =
  | {
      readonly kind: "invitee";
      readonly event: "invitee.created" | "invitee.canceled";
      readonly invitee: CalendlyInvitee;
    }
  | { readonly kind: "ignored"; readonly event: string };

/** The delivery's event and invitee; anything we did not subscribe to is "ignored". */
export function parseCalendlyDelivery(rawBody: string): CalendlyDelivery | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const body = CalendlyWebhookBody.safeParse(json);
  if (!body.success) return null;
  const event = body.data.event;
  if (event !== "invitee.created" && event !== "invitee.canceled")
    return { kind: "ignored", event };
  const invitee = InviteePayload.safeParse(body.data.payload);
  if (!invitee.success) return null;
  return { kind: "invitee", event, invitee: invitee.data };
}

/** The tracking token we put in a single-use link (`utm_content`), if the booking has one. */
export function trackingToken(invitee: CalendlyInvitee): string | null {
  const content = invitee.tracking?.utm_content ?? null;
  return content !== null && /^[A-Za-z0-9_-]{16,64}$/.test(content) ? content : null;
}

/** The single-use link with our tracking token, so the booking comes back to its conversation. */
export function linkWithToken(bookingUrl: string, token: string): string {
  const url = new URL(bookingUrl);
  url.searchParams.set("utm_source", "hsrb");
  url.searchParams.set("utm_content", token);
  return url.toString();
}
