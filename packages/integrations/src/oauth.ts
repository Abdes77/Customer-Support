import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { GHL_AUTHORIZE_URL, GHL_SCOPES, GHL_TOKEN_URL } from "./connectors/gohighlevel";
import { HUBSPOT_AUTHORIZE_URL, HUBSPOT_SCOPES, HUBSPOT_TOKEN_URL } from "./connectors/hubspot";
import { JOBBER_AUTHORIZE_URL, JOBBER_TOKEN_URL } from "./connectors/jobber";
import type { OAuthApp } from "./connectors/common";

/*
 * OAuth 2.0 for the CRMs that offer it to apps (HubSpot, GoHighLevel, Jobber), following the
 * pattern of the calendar and email connections (C11, C12): a `state` that names the
 * provider, agency, business, person and return path, signed with a server key and bound to
 * an HttpOnly cookie that also holds the PKCE verifier. The callback requires a valid
 * signature, an unexpired state, the same cookie nonce and the same signed-in person. Domain
 * packages do not import each other, so these small helpers are this package's own.
 *
 * PKCE is sent to every vendor; a vendor that does not use it ignores the parameters.
 */

export const OAUTH_PROVIDERS = ["hubspot", "gohighlevel", "jobber"] as const;
export type CrmOAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is CrmOAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export const OAUTH_ENDPOINTS: Readonly<
  Record<CrmOAuthProvider, { authorize: string; token: string; scopes: readonly string[] }>
> = {
  hubspot: { authorize: HUBSPOT_AUTHORIZE_URL, token: HUBSPOT_TOKEN_URL, scopes: HUBSPOT_SCOPES },
  gohighlevel: { authorize: GHL_AUTHORIZE_URL, token: GHL_TOKEN_URL, scopes: GHL_SCOPES },
  jobber: { authorize: JOBBER_AUTHORIZE_URL, token: JOBBER_TOKEN_URL, scopes: [] },
};

export const CRM_OAUTH_COOKIE = "hsrb_crm_oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizationUrl(
  provider: CrmOAuthProvider,
  input: {
    readonly app: OAuthApp;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  },
): string {
  const endpoints = OAUTH_ENDPOINTS[provider];
  const url = new URL(endpoints.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (endpoints.scopes.length > 0) url.searchParams.set("scope", endpoints.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** The form of the code exchange (the token request itself is `tokenRequest`). */
export function codeExchangeForm(
  provider: CrmOAuthProvider,
  input: {
    readonly app: OAuthApp;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  },
): Record<string, string> {
  return {
    grant_type: "authorization_code",
    client_id: input.app.clientId,
    client_secret: input.app.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    ...(provider === "gohighlevel" ? { user_type: "Location" } : {}),
  };
}

// --- signed state ------------------------------------------------------------------------

const StatePayload = z.object({
  v: z.literal(1),
  p: z.enum(OAUTH_PROVIDERS),
  a: z.uuid(),
  b: z.uuid(),
  u: z.string().min(1).max(100),
  n: z.string().min(16).max(100),
  r: z.string().max(512),
  e: z.number().int(),
});
export type CrmOAuthState = z.infer<typeof StatePayload>;

function sign(key: Uint8Array, body: string): string {
  return createHmac("sha256", key).update(`crm-oauth-state:${body}`).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createOAuthState(
  key: Uint8Array,
  input: Omit<CrmOAuthState, "v" | "n" | "e">,
  now: Date,
): { readonly state: string; readonly nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const payload: CrmOAuthState = {
    v: 1,
    ...input,
    n: nonce,
    e: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { state: `${body}.${sign(key, body)}`, nonce };
}

export type StateCheck =
  | { readonly ok: true; readonly payload: CrmOAuthState }
  | { readonly ok: false; readonly reason: "malformed" | "signature" | "expired" | "cookie" };

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
  let payload: CrmOAuthState;
  try {
    payload = StatePayload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
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
): { readonly nonce: string; readonly verifier: string } | null {
  if (value == null) return null;
  const [nonce, verifier, ...rest] = value.split(".");
  if (nonce === undefined || verifier === undefined || rest.length > 0) return null;
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    return null;
  }
  return { nonce, verifier };
}
