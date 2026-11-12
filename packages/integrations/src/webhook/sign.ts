import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Signatures of outgoing webhook requests. The header
 *
 *   X-HSRB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * binds the body to the moment it was sent, so a receiver can refuse a replayed request:
 * recompute the HMAC over the raw bytes it received, compare in constant time, and refuse a
 * timestamp more than five minutes away from its clock. `verifyWebhookSignature` does exactly
 * that and is what docs/INTEGRATIONS.md shows receivers.
 */

export const SIGNATURE_HEADER = "x-hsrb-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = "whsec_";

/** A new signing secret: 32 random bytes, prefixed so it is recognisable when pasted. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Last four characters, for the admin panel ("whsec_…a1B2"). */
export function secretHint(secret: string): string {
  return `${SECRET_PREFIX}…${secret.slice(-4)}`;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signWebhookBody(secret: string, body: string, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export type SignatureCheck =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: "malformed" | "mismatch" | "expired" };

/**
 * Checks a signature header against the raw body. Several `v1=` values are accepted (a
 * sender rotating its secret may sign with both).
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  rawBody: string,
  now: Date,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): SignatureCheck {
  if (header === null || header.length > 2000) return { ok: false, reason: "malformed" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value, ...rest] = part.trim().split("=");
    if (key === undefined || value === undefined || rest.length > 0) continue;
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(hmac(secret, timestamp, rawBody), "hex");
  const matches = signatures.some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) return { ok: false, reason: "mismatch" };
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, timestamp };
}
