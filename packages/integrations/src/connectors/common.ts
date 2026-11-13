import { z } from "zod";

import { type ConnectorError, err, ok, type Result } from "@repo/core";

import { type FetchLike, vendorJson } from "../http";

/** The deployment's OAuth app of a vendor (from env); null when not configured. */
export interface OAuthApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** OAuth tokens as stored (encrypted) in `integration_connection_secrets`. */
export const OAuthCredentials = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.string(),
});
export type OAuthCredentials = z.infer<typeof OAuthCredentials>;

/** A long-lived token pasted by the business (a private app or private integration token). */
export const TokenCredentials = z.object({
  kind: z.literal("token"),
  accessToken: z.string().min(1),
});
export type TokenCredentials = z.infer<typeof TokenCredentials>;

/** True when an OAuth token expires within `marginMs` (default two minutes). */
export function oauthExpiresSoon(
  credentials: { readonly kind: string; readonly expiresAt?: string },
  now: Date,
  marginMs = 120_000,
): boolean {
  if (credentials.kind !== "oauth" || credentials.expiresAt === undefined) return false;
  const expires = Date.parse(credentials.expiresAt);
  return Number.isNaN(expires) || expires - now.getTime() <= marginMs;
}

const TokenAnswer = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.coerce.number().int().positive().optional(),
  })
  .passthrough();
export type TokenAnswer = z.infer<typeof TokenAnswer>;

/**
 * A token request (authorization code or refresh) to an OAuth token endpoint. A refused grant
 * (`invalid_grant`, 400/401) is `auth_expired`: the business has to connect again.
 */
export async function tokenRequest(
  fetchImpl: FetchLike,
  vendor: string,
  url: string,
  form: Readonly<Record<string, string>>,
  now: () => Date,
  previousRefresh: string | null,
): Promise<
  Result<{ readonly credentials: OAuthCredentials; readonly raw: TokenAnswer }, ConnectorError>
> {
  const answer = await vendorJson(
    fetchImpl,
    `${vendor} sign-in`,
    { method: "POST", url, form },
    TokenAnswer,
    now,
  );
  if (!answer.ok) {
    if (answer.error.code === "validation" || answer.error.code === "auth_expired") {
      return err({
        code: "auth_expired",
        message: `${vendor} refused the sign-in (the access was removed or expired). Connect it again.`,
        retryable: false,
        retryAfterSeconds: null,
      });
    }
    return answer;
  }
  const token = answer.value.data;
  const expiresAt =
    token.expires_in !== undefined
      ? now().getTime() + token.expires_in * 1000
      : (jwtExpiry(token.access_token) ?? now().getTime() + 3600 * 1000);
  return ok({
    credentials: {
      kind: "oauth",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? previousRefresh,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    raw: token,
  });
}

/**
 * The `exp` claim of an access token that is a JWT, in milliseconds. Jobber's answer has no
 * `expires_in`; its app template reads the expiry from the token's `exp` claim the same way.
 * The claim is only used to know when to refresh, never trusted for anything else.
 */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    const exp =
      claims !== null && typeof claims === "object" ? (claims as { exp?: unknown }).exp : null;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** The value of a mapped field as text, for vendors whose fields are all strings. */
export function stringify(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}
