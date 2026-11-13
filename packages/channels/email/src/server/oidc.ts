import { createPublicKey, type JsonWebKey, verify } from "node:crypto";

import { z } from "zod";

import type { FetchLike } from "../providers/http";

/*
 * Verifies the OpenID Connect token Cloud Pub/Sub puts on an authenticated push request
 * (docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions, read 2026-11-12):
 * `Authorization: Bearer <JWT>`, RS256, signed by one of Google's keys (`kid`), issuer
 * `accounts.google.com` or `https://accounts.google.com`, audience = the subscription's
 * audience, not expired, and `email` = the push service account with `email_verified` true
 * (the signature and audience checks alone do not cover who sent it).
 */

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 300;
/** An unknown key id makes us read Google's keys again at most this often. */
const KEY_REFRESH_MIN_MS = 5 * 60_000;

export interface JsonWebKeySet {
  readonly keys: readonly (JsonWebKey & { readonly kid?: string; readonly alg?: string })[];
}

const Header = z.object({
  alg: z.string(),
  kid: z.string().optional(),
  typ: z.string().optional(),
});
const Claims = z
  .object({
    iss: z.string(),
    aud: z.union([z.string(), z.array(z.string())]),
    exp: z.number(),
    iat: z.number().optional(),
    email: z.string().optional(),
    email_verified: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  })
  .passthrough();

export type OidcResult =
  { readonly ok: true; readonly email: string } | { readonly ok: false; readonly reason: string };

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function verifyGoogleOidcToken(
  token: string,
  expected: { readonly audience: string; readonly serviceAccount: string; readonly now: Date },
  keys: (options?: { readonly refresh?: boolean }) => Promise<JsonWebKeySet>,
): Promise<OidcResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return { ok: false, reason: "malformed" };
  }
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  let header: z.infer<typeof Header>;
  let claims: z.infer<typeof Claims>;
  try {
    header = Header.parse(decodePart(headerPart));
    claims = Claims.parse(decodePart(claimsPart));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "algorithm" };
  const find = (set: JsonWebKeySet) =>
    set.keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  // Google rotates its keys: an unknown key id reads the set again (at most every few
  // minutes, so forged ids cannot make us fetch on every request).
  const jwk = find(await keys()) ?? find(await keys({ refresh: true }));
  if (jwk === undefined) return { ok: false, reason: "unknown_key" };
  let valid: boolean;
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    valid = verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${claimsPart}`),
      publicKey,
      Buffer.from(signaturePart, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };
  const nowSeconds = Math.floor(expected.now.getTime() / 1000);
  if (!ISSUERS.has(claims.iss)) return { ok: false, reason: "issuer" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) return { ok: false, reason: "audience" };
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return { ok: false, reason: "expired" };
  if (claims.iat !== undefined && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "not_yet_valid" };
  }
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (claims.email?.toLowerCase() !== expected.serviceAccount.toLowerCase() || !verified) {
    return { ok: false, reason: "sender" };
  }
  return { ok: true, email: claims.email };
}

const JwksSchema = z.object({
  keys: z.array(z.object({ kid: z.string().optional(), kty: z.string() }).passthrough()),
});

/** Google's keys, fetched when needed and kept for an hour (or what Cache-Control says). */
export function googleKeySource(fetchImpl: FetchLike, clock: () => Date = () => new Date()) {
  let cached: { keys: JsonWebKeySet; until: number; fetchedAt: number } | null = null;
  return async (options: { readonly refresh?: boolean } = {}): Promise<JsonWebKeySet> => {
    const now = clock().getTime();
    if (cached !== null && cached.until > now) {
      if (options.refresh !== true || now - cached.fetchedAt < KEY_REFRESH_MIN_MS) {
        return cached.keys;
      }
    }
    const response = await fetchImpl(GOOGLE_JWKS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Google's keys could not be read (${response.status}).`);
    const keys = JwksSchema.parse(await response.json()) as unknown as JsonWebKeySet;
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
    const seconds = maxAge === undefined ? 3600 : Math.min(Number(maxAge), 6 * 3600);
    cached = { keys, until: now + seconds * 1000, fetchedAt: now };
    return keys;
  };
}
