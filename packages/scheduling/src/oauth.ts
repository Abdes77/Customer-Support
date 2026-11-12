import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { apiJson, type CalendarVendor, type FetchLike } from "./http";

/*
 * OAuth 2.0 with PKCE for the calendar connections: Google Calendar, Outlook (Microsoft
 * Graph) and Calendly. The Google and Microsoft apps are the ones email uses (C11; the same
 * client ids through env), asked here for calendar scopes only: a calendar connection is its
 * own connection with its own tokens. Domain packages do not import each other, so the small
 * PKCE and state helpers live here too (DECISIONS).
 *
 * Google: `calendar.readonly` (busy times across the calendars the business chooses, the
 * calendar list) and `calendar.events` (create, move and cancel the bot's events),
 * `access_type=offline` and `prompt=consent` for a refresh token.
 * Microsoft: `offline_access User.Read Calendars.ReadWrite`; refresh tokens rotate.
 * Calendly: authorization code with PKCE at auth.calendly.com; refresh tokens rotate.
 */

export type CalendarOAuthProvider = "google_calendar" | "outlook_calendar" | "calendly";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;
export const MICROSOFT_CALENDAR_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
] as const;

export interface OAuthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MicrosoftOAuthApp extends OAuthApp {
  /** "common", "organizations" or a tenant id. */
  readonly tenant: string;
}

/** Stored, encrypted, in `integration_connection_secrets`. Never leaves the server. */
export const CalendarCredentials = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
    expiresAt: z.string(),
    scope: z.string(),
  }),
  z.object({
    /** A Calendly personal access token: no expiry, no refresh. */
    kind: z.literal("token"),
    accessToken: z.string().min(1),
    /** The signing key we gave Calendly's webhook subscription for this connection. */
    webhookSigningKey: z.string().min(16).nullable(),
  }),
]);
export type CalendarCredentials = z.infer<typeof CalendarCredentials>;
export type OAuthCredentials = Extract<CalendarCredentials, { kind: "oauth" }>;

export function pkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function googleAuthorizationUrl(input: {
  readonly app: OAuthApp;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function microsoftAuthorizationUrl(input: {
  readonly app: MicrosoftOAuthApp;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(input.app.tenant)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function calendlyAuthorizationUrl(input: {
  readonly app: OAuthApp;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL("https://auth.calendly.com/oauth/authorize");
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.coerce.number().int().positive().default(3600),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    /** Calendly: the user and organization the token belongs to. */
    owner: z.string().optional(),
    organization: z.string().optional(),
  })
  .passthrough();

export interface TokenGrant {
  readonly credentials: OAuthCredentials;
  /** Calendly's user and organization URIs, when the token response names them. */
  readonly owner: string | null;
  readonly organization: string | null;
}

function tokenEndpoint(provider: CalendarOAuthProvider, app: OAuthApp | MicrosoftOAuthApp): string {
  if (provider === "google_calendar") return "https://oauth2.googleapis.com/token";
  if (provider === "calendly") return "https://auth.calendly.com/oauth/token";
  const tenant = "tenant" in app ? app.tenant : "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

function vendorOf(provider: CalendarOAuthProvider): CalendarVendor {
  if (provider === "google_calendar") return "google_oauth";
  if (provider === "outlook_calendar") return "microsoft_oauth";
  return "calendly_oauth";
}

async function tokenRequest(
  fetchImpl: FetchLike,
  provider: CalendarOAuthProvider,
  app: OAuthApp | MicrosoftOAuthApp,
  form: Record<string, string>,
  now: Date,
  previousRefresh: string | null,
): Promise<TokenGrant> {
  const body = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    ...(provider === "outlook_calendar" ? { scope: MICROSOFT_CALENDAR_SCOPES.join(" ") } : {}),
    ...form,
  });
  const token = await apiJson(
    fetchImpl,
    vendorOf(provider),
    {
      method: "POST",
      url: tokenEndpoint(provider, app),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    TokenResponse,
  );
  return {
    credentials: {
      kind: "oauth",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? previousRefresh,
      expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
      scope: token.scope ?? "",
    },
    owner: token.owner ?? null,
    organization: token.organization ?? null,
  };
}

export function exchangeCode(
  fetchImpl: FetchLike,
  provider: CalendarOAuthProvider,
  input: {
    readonly app: OAuthApp | MicrosoftOAuthApp;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly now: Date;
  },
): Promise<TokenGrant> {
  return tokenRequest(
    fetchImpl,
    provider,
    input.app,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    input.now,
    null,
  );
}

export async function refreshAccessToken(
  fetchImpl: FetchLike,
  provider: CalendarOAuthProvider,
  input: {
    readonly app: OAuthApp | MicrosoftOAuthApp;
    readonly refreshToken: string;
    readonly now: Date;
  },
): Promise<OAuthCredentials> {
  const grant = await tokenRequest(
    fetchImpl,
    provider,
    input.app,
    { grant_type: "refresh_token", refresh_token: input.refreshToken },
    input.now,
    input.refreshToken,
  );
  return grant.credentials;
}

/** True when the access token expires within `marginMs` (default two minutes). */
export function tokenExpiresSoon(
  credentials: OAuthCredentials,
  now: Date,
  marginMs = 120_000,
): boolean {
  const expires = Date.parse(credentials.expiresAt);
  return Number.isNaN(expires) || expires - now.getTime() <= marginMs;
}

// --- signed state ------------------------------------------------------------------------

/*
 * The OAuth `state`: which provider, agency, business, person and return path, signed with a
 * server key and bound to an HttpOnly cookie that also holds the PKCE verifier. The callback
 * requires a valid signature, an unexpired state, the same cookie nonce and the same
 * signed-in person, so a code cannot be injected into someone else's flow.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const CALENDAR_OAUTH_COOKIE = "hsrb_calendar_oauth";

const StatePayload = z.object({
  v: z.literal(1),
  p: z.enum(["google_calendar", "outlook_calendar", "calendly"]),
  a: z.uuid(),
  b: z.uuid(),
  u: z.string().min(1).max(100),
  n: z.string().min(16).max(100),
  r: z.string().max(512),
  e: z.number().int(),
});
export type CalendarOAuthState = z.infer<typeof StatePayload>;

function sign(key: Uint8Array, body: string): string {
  return createHmac("sha256", key).update(`calendar-oauth-state:${body}`).digest("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createOAuthState(
  key: Uint8Array,
  input: Omit<CalendarOAuthState, "v" | "n" | "e">,
  now: Date,
): { readonly state: string; readonly nonce: string } {
  const nonce = randomBytes(24).toString("base64url");
  const payload: CalendarOAuthState = {
    v: 1,
    ...input,
    n: nonce,
    e: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { state: `${body}.${sign(key, body)}`, nonce };
}

export type StateCheck =
  | { readonly ok: true; readonly payload: CalendarOAuthState }
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
  let payload: CalendarOAuthState;
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
): { nonce: string; verifier: string } | null {
  if (value == null) return null;
  const [nonce, verifier, ...rest] = value.split(".");
  if (nonce === undefined || verifier === undefined || rest.length > 0) return null;
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) {
    return null;
  }
  return { nonce, verifier };
}
