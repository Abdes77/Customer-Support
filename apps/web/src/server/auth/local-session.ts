import { createHmac, timingSafeEqual } from "node:crypto";

import type { UserId } from "@repo/core";

import type { CookieJar, CookieOptions, SessionUser } from "./types";

/*
 * Sessions of the local sign-in provider (development and CI only): a payload and its
 * HMAC-SHA256 under LOCAL_AUTH_SECRET, in an httpOnly cookie. No database is involved, so
 * `proxy.ts` can verify and renew a session cheaply. Production sessions are Supabase's.
 */

export const LOCAL_SESSION_COOKIE = "hsrb_session";
export const LOCAL_SESSION_SECONDS = 7 * 24 * 60 * 60;
export const LOCAL_MAGIC_LINK_SECONDS = 15 * 60;

export type LocalTokenType = "session" | "magic";

export interface LocalTokenPayload {
  readonly sub: string;
  readonly email: string;
  readonly typ: LocalTokenType;
  /** Seconds since the epoch. */
  readonly iat: number;
  readonly exp: number;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signLocalToken(payload: LocalTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

/** The payload when the token is intact, of the expected type and not expired; else null. */
export function verifyLocalToken(
  token: string,
  secret: string,
  type: LocalTokenType,
  now: Date,
): LocalTokenPayload | null {
  const [body, mac, extra] = token.split(".");
  if (body === undefined || mac === undefined || extra !== undefined) return null;
  const expected = signature(body, secret);
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<LocalTokenPayload>;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      payload.typ !== type ||
      payload.exp <= seconds(now)
    ) {
      return null;
    }
    return payload as LocalTokenPayload;
  } catch {
    return null;
  }
}

export function createLocalToken(
  user: { readonly id: string; readonly email: string },
  type: LocalTokenType,
  secret: string,
  now: Date,
): string {
  const lifetime = type === "session" ? LOCAL_SESSION_SECONDS : LOCAL_MAGIC_LINK_SECONDS;
  const issuedAt = seconds(now);
  return signLocalToken(
    { sub: user.id, email: user.email, typ: type, iat: issuedAt, exp: issuedAt + lifetime },
    secret,
  );
}

export function sessionCookieOptions(secure: boolean, maxAge: number): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge };
}

function readPayload(jar: CookieJar, secret: string, now: Date): LocalTokenPayload | null {
  const cookie = jar.getAll().find((candidate) => candidate.name === LOCAL_SESSION_COOKIE);
  return cookie === undefined ? null : verifyLocalToken(cookie.value, secret, "session", now);
}

export function readLocalSession(jar: CookieJar, secret: string, now: Date): SessionUser | null {
  const payload = readPayload(jar, secret, now);
  return payload === null ? null : { id: payload.sub as UserId, email: payload.email };
}

export function writeLocalSession(
  jar: CookieJar,
  user: { readonly id: string; readonly email: string },
  options: { readonly secret: string; readonly secure: boolean; readonly now: Date },
): void {
  jar.set(
    LOCAL_SESSION_COOKIE,
    createLocalToken(user, "session", options.secret, options.now),
    sessionCookieOptions(options.secure, LOCAL_SESSION_SECONDS),
  );
}

export function clearLocalSession(jar: CookieJar, secure: boolean): void {
  jar.set(LOCAL_SESSION_COOKIE, "", sessionCookieOptions(secure, 0));
}

/** Issues a fresh cookie once half of the session's lifetime has passed. */
export function refreshLocalSession(
  jar: CookieJar,
  options: { readonly secret: string; readonly secure: boolean; readonly now: Date },
): void {
  const payload = readPayload(jar, options.secret, options.now);
  if (payload === null) return;
  const age = seconds(options.now) - payload.iat;
  if (age > LOCAL_SESSION_SECONDS / 2) {
    writeLocalSession(jar, { id: payload.sub, email: payload.email }, options);
  }
}
