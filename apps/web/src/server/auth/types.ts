import type { Result, UserId } from "@repo/core";

/** The signed-in person, as established from a verified session. */
export interface SessionUser {
  readonly id: UserId;
  readonly email: string | null;
}

export type AuthFailureCode =
  /** Wrong email or password. Deliberately does not say which. */
  | "invalid_credentials"
  /** The sign-in link is wrong, already used or expired. */
  | "link_invalid"
  | "rate_limited"
  /** The auth service could not be reached or answered with an error. */
  | "unavailable";

export interface AuthFailure {
  readonly code: AuthFailureCode;
}

export interface CookieOptions {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: boolean | "lax" | "strict" | "none";
  readonly path?: string;
  readonly maxAge?: number;
  readonly expires?: Date;
  readonly domain?: string;
}

/**
 * The cookies of one request and its response. The same provider code runs against the
 * cookie store of a route handler, the request and response pair in `proxy.ts`, and a plain
 * map in tests.
 */
export interface CookieJar {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
  /** Response headers that must accompany changed auth cookies (no caching). Optional. */
  setHeaders?(headers: Readonly<Record<string, string>>): void;
}

/**
 * Sign-in behind one interface, so the routes do not care whether Supabase Auth (production)
 * or the local store (development and CI) answers.
 */
export interface AuthProvider {
  readonly mode: "supabase" | "local";

  signInWithPassword(email: string, password: string): Promise<Result<SessionUser, AuthFailure>>;

  /**
   * Sends a sign-in link to an existing user. Succeeds whether or not the address belongs
   * to a user, so the form cannot be used to find out who has an account. `link` is set
   * only by the local provider, which has no way to send email.
   */
  sendMagicLink(
    email: string,
    options: { readonly redirectTo: string },
  ): Promise<Result<{ readonly link: string | null }, AuthFailure>>;

  /** Finishes a link that came back with `?code=` (Supabase PKCE flow). */
  exchangeCode(code: string): Promise<Result<SessionUser, AuthFailure>>;

  /** Finishes a link that came back with `?token_hash=&type=`. */
  verifyEmailToken(tokenHash: string, type: string): Promise<Result<SessionUser, AuthFailure>>;

  /** The user of a valid session, or null. Verifies the session; never trusts the cookie. */
  getUser(): Promise<SessionUser | null>;

  /** Renews the session cookies when they are due. Called by `proxy.ts` on every request. */
  refresh(): Promise<void>;

  signOut(): Promise<void>;
}
