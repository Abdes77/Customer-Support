import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/*
 * The OAuth `state` of an inbox connection: which business, which person, where to return,
 * signed with a server key and bound to a cookie of the browser that started the flow. The
 * cookie also carries the PKCE verifier, which never appears in a URL. On the way back the
 * callback requires a valid signature, an unexpired state, the same cookie nonce and the same
 * signed-in person, so a code cannot be injected into another person's flow, and a mailbox
 * cannot be connected to a business the person did not choose.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE = "hsrb_email_oauth";

const Payload = z.object({
  v: z.literal(1),
  p: z.enum(["gmail", "microsoft"]),
  a: z.uuid(),
  b: z.uuid(),
  u: z.string().min(1).max(100),
  n: z.string().min(16).max(100),
  r: z.string().max(512),
  e: z.number().int(),
});
export type OAuthStatePayload = z.infer<typeof Payload>;

function sign(key: Uint8Array, body: string): string {
  return createHmac("sha256", key).update(`email-oauth-state:${body}`).digest("base64url");
}

export function createOAuthState(
  key: Uint8Array,
  input: Omit<OAuthStatePayload, "v" | "n" | "e">,
  now: Date,
): { readonly state: string; readonly nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const payload: OAuthStatePayload = {
    v: 1,
    ...input,
    n: nonce,
    e: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { state: `${body}.${sign(key, body)}`, nonce };
}

export type StateCheck =
  | { readonly ok: true; readonly payload: OAuthStatePayload }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "expired" | "cookie" };

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyOAuthState(
  key: Uint8Array,
  state: string,
  cookieNonce: string | null,
  now: Date,
): StateCheck {
  const [body, signature, ...rest] = state.split(".");
  if (body === undefined || signature === undefined || rest.length > 0 || body.length > 4000) {
    return { ok: false, reason: "malformed" };
  }
  if (!equal(sign(key, body), signature)) return { ok: false, reason: "signature" };
  let payload: OAuthStatePayload;
  try {
    payload = Payload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.e < now.getTime()) return { ok: false, reason: "expired" };
  if (cookieNonce === null || !equal(cookieNonce, payload.n))
    return { ok: false, reason: "cookie" };
  return { ok: true, payload };
}

/** The cookie value: the state's nonce and the PKCE verifier. */
export function cookieValue(nonce: string, verifier: string): string {
  return `${nonce}.${verifier}`;
}

export function readCookieValue(
  value: string | null | undefined,
): { nonce: string; verifier: string } | null {
  if (value == null) return null;
  const [nonce, verifier, ...rest] = value.split(".");
  if (nonce === undefined || verifier === undefined || rest.length > 0) return null;
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier))
    return null;
  return { nonce, verifier };
}
