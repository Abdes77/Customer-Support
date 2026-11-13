import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Visitor session tokens. A token is `<payload>.<signature>`, both base64url: the payload is
 * a small JSON object with ids and an expiry, the signature an HMAC-SHA256 over it with
 * `WIDGET_SESSION_SECRET`. The token is the visitor's only credential; it names the session
 * row, which is checked on every request (revoked, expired, other origin), so a token can be
 * cut off at once without rotating the secret.
 */

const VERSION = 1;
const MIN_SECRET_LENGTH = 32;
// Keeps a widget signature from ever being valid as any other HMAC made with the secret.
const DOMAIN = "hsrb-widget-session-v1\n";

const Claims = z.object({
  v: z.literal(VERSION),
  /** widget_sessions.id */
  sid: z.uuid(),
  /** channel_connections.id */
  cid: z.uuid(),
  bid: z.uuid(),
  aid: z.uuid(),
  /** Expiry, seconds since the epoch. */
  exp: z.number().int().positive(),
});
export type WidgetTokenClaims = z.infer<typeof Claims>;

export function assertWidgetSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`WIDGET_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN).update(payload).digest();
}

export function signWidgetToken(secret: string, claims: Omit<WidgetTokenClaims, "v">): string {
  assertWidgetSecret(secret);
  const payload = Buffer.from(JSON.stringify({ v: VERSION, ...claims })).toString("base64url");
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export function verifyWidgetToken(
  secret: string,
  token: string,
  now: Date,
): WidgetTokenClaims | null {
  if (token.length > 2000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, presented] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(presented)) return null;
  const expected = signature(secret, payload);
  const given = Buffer.from(presented, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = Claims.safeParse(json);
  if (!claims.success) return null;
  if (claims.data.exp * 1000 <= now.getTime()) return null;
  return claims.data;
}

/**
 * A keyed hash of the visitor's network address, for the per-address limit. The address
 * itself is never stored.
 */
export function hashIp(secret: string, ip: string | null): string {
  return createHmac("sha256", secret)
    .update("hsrb-widget-ip\n")
    .update(ip ?? "unknown")
    .digest("base64url")
    .slice(0, 32);
}
