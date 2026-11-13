import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type { OAuthCredentials } from "../config";
import { apiJson, apiRequest, type FetchLike } from "./http";

/*
 * OAuth 2.0 authorization code flow with PKCE (RFC 7636) for Gmail and Microsoft 365.
 *
 * Google: accounts.google.com authorize, oauth2.googleapis.com token; `access_type=offline`
 * and `prompt=consent` so a refresh token comes back. Scopes: read mail (history and
 * messages; also what a Gmail watch needs) and send mail; nothing that changes the mailbox.
 *
 * Microsoft: login.microsoftonline.com/{tenant}/oauth2/v2.0; `offline_access` for a refresh
 * token (which rotates: the new one replaces the old). Scopes: read the profile, read mail
 * (delta, MIME content, change notifications) and send mail.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.Send"] as const;

export interface OAuthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MicrosoftOAuthApp extends OAuthApp {
  /** "common", "organizations" or a tenant id. */
  readonly tenant: string;
}

/** A PKCE verifier and its S256 challenge. */
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
  readonly loginHint?: string | null;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export function microsoftAuthorizationUrl(input: {
  readonly app: MicrosoftOAuthApp;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly loginHint?: string | null;
}): string {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(input.app.tenant)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.coerce.number().int().positive().default(3600),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  })
  .passthrough();

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function toCredentials(
  token: z.infer<typeof TokenResponse>,
  now: Date,
  previousRefresh: string | null,
): OAuthCredentials {
  return {
    kind: "oauth",
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previousRefresh,
    expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
    scope: token.scope ?? "",
  };
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function microsoftTokenUrl(app: MicrosoftOAuthApp): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(app.tenant)}/oauth2/v2.0/token`;
}

export async function exchangeGoogleCode(
  fetchImpl: FetchLike,
  input: {
    readonly app: OAuthApp;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly now: Date;
  },
): Promise<OAuthCredentials> {
  const token = await apiJson(
    fetchImpl,
    "google_oauth",
    {
      method: "POST",
      url: GOOGLE_TOKEN_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        code: input.code,
        client_id: input.app.clientId,
        client_secret: input.app.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier,
      }),
    },
    TokenResponse,
  );
  return toCredentials(token, input.now, null);
}

export async function exchangeMicrosoftCode(
  fetchImpl: FetchLike,
  input: {
    readonly app: MicrosoftOAuthApp;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly now: Date;
  },
): Promise<OAuthCredentials> {
  const token = await apiJson(
    fetchImpl,
    "microsoft_oauth",
    {
      method: "POST",
      url: microsoftTokenUrl(input.app),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: input.app.clientId,
        client_secret: input.app.clientSecret,
        scope: MICROSOFT_SCOPES.join(" "),
        code: input.code,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier,
      }),
    },
    TokenResponse,
  );
  return toCredentials(token, input.now, null);
}

/** A new access token from the refresh token (Google keeps it; Microsoft sends a new one). */
export async function refreshGoogleToken(
  fetchImpl: FetchLike,
  input: { readonly app: OAuthApp; readonly refreshToken: string; readonly now: Date },
): Promise<OAuthCredentials> {
  const token = await apiJson(
    fetchImpl,
    "google_oauth",
    {
      method: "POST",
      url: GOOGLE_TOKEN_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: input.app.clientId,
        client_secret: input.app.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }),
    },
    TokenResponse,
  );
  return toCredentials(token, input.now, input.refreshToken);
}

export async function refreshMicrosoftToken(
  fetchImpl: FetchLike,
  input: { readonly app: MicrosoftOAuthApp; readonly refreshToken: string; readonly now: Date },
): Promise<OAuthCredentials> {
  const token = await apiJson(
    fetchImpl,
    "microsoft_oauth",
    {
      method: "POST",
      url: microsoftTokenUrl(input.app),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: input.app.clientId,
        client_secret: input.app.clientSecret,
        scope: MICROSOFT_SCOPES.join(" "),
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }),
    },
    TokenResponse,
  );
  return toCredentials(token, input.now, input.refreshToken);
}

/** Revokes a Google token when a connection is removed (best effort). */
export async function revokeGoogleToken(fetchImpl: FetchLike, token: string): Promise<void> {
  await apiRequest(fetchImpl, "google_oauth", {
    method: "POST",
    url: "https://oauth2.googleapis.com/revoke",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ token }),
  });
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
