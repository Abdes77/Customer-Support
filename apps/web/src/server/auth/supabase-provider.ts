import { createServerClient } from "@supabase/ssr";

import { err, ok, type Result, type UserId } from "@repo/core";

import type { AuthFailure, AuthProvider, CookieJar, SessionUser } from "./types";

/**
 * The part of Supabase's auth client this provider uses. Declared here so tests can supply
 * a stand-in, and so a change in the SDK shows up as a type error in one place.
 */
export interface SupabaseAuthClient {
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthResponseLike>;
  signInWithOtp(credentials: {
    email: string;
    options: { shouldCreateUser: boolean; emailRedirectTo: string };
  }): Promise<{ error: AuthErrorLike | null }>;
  exchangeCodeForSession(code: string): Promise<AuthResponseLike>;
  verifyOtp(params: { token_hash: string; type: EmailLinkType }): Promise<AuthResponseLike>;
  getClaims(): Promise<{
    data: { claims: { sub?: string; email?: string } } | null;
    error: AuthErrorLike | null;
  }>;
  signOut(): Promise<{ error: AuthErrorLike | null }>;
}

interface AuthErrorLike {
  readonly status?: number;
  readonly code?: string;
}

interface AuthResponseLike {
  readonly data: { readonly user: { readonly id: string; readonly email?: string } | null };
  readonly error: AuthErrorLike | null;
}

const EMAIL_LINK_TYPES = ["magiclink", "email", "invite", "recovery", "signup"] as const;
type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];

export interface SupabaseProviderOptions {
  readonly jar: CookieJar;
  /** NEXT_PUBLIC_SUPABASE_URL. */
  readonly url: string;
  /** NEXT_PUBLIC_SUPABASE_ANON_KEY. The anon key: row-level security applies to it. */
  readonly anonKey: string;
  /** Overrides the client, for tests. */
  readonly client?: SupabaseAuthClient;
}

function failure(error: AuthErrorLike, fallback: AuthFailure["code"]): AuthFailure {
  if (error.status === 429) return { code: "rate_limited" };
  if (error.status === undefined || error.status >= 500) return { code: "unavailable" };
  return { code: fallback };
}

function userOf(
  response: AuthResponseLike,
  fallback: AuthFailure["code"],
): Result<SessionUser, AuthFailure> {
  if (response.error !== null) return err(failure(response.error, fallback));
  const user = response.data.user;
  if (user === null) return err({ code: fallback });
  return ok({ id: user.id as UserId, email: user.email ?? null });
}

/**
 * Supabase Auth: password and magic-link sign-in, with the session in Supabase's own
 * cookies. A new provider (and client) is made for every request, as @supabase/ssr requires.
 *
 * Built from the current @supabase/ssr and auth-js type definitions; not yet run against a
 * live project (docs/HUMAN_TODO.md).
 */
export function createSupabaseAuthProvider(options: SupabaseProviderOptions): AuthProvider {
  const { jar } = options;
  // The assignment is the compatibility check: if the SDK's auth client stops matching the
  // interface above, this line stops compiling.
  const auth: SupabaseAuthClient =
    options.client ??
    createServerClient(options.url, options.anonKey, {
      cookies: {
        getAll: () => jar.getAll(),
        setAll(cookies, headers) {
          for (const cookie of cookies) jar.set(cookie.name, cookie.value, cookie.options);
          jar.setHeaders?.(headers);
        },
      },
    }).auth;

  return {
    mode: "supabase",

    async signInWithPassword(email, password) {
      return userOf(await auth.signInWithPassword({ email, password }), "invalid_credentials");
    },

    async sendMagicLink(email, { redirectTo }) {
      // Never create users from the sign-in form: people are invited by their agency.
      const { error } = await auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      if (error === null) return ok({ link: null });
      const reason = failure(error, "invalid_credentials");
      // "No such user" is reported like success, so the form does not reveal who has an
      // account. Rate limits and outages are worth telling the person about.
      return reason.code === "invalid_credentials" ? ok({ link: null }) : err(reason);
    },

    async exchangeCode(code) {
      return userOf(await auth.exchangeCodeForSession(code), "link_invalid");
    },

    async verifyEmailToken(tokenHash, type) {
      if (!(EMAIL_LINK_TYPES as readonly string[]).includes(type)) {
        return err({ code: "link_invalid" });
      }
      return userOf(
        await auth.verifyOtp({ token_hash: tokenHash, type: type as EmailLinkType }),
        "link_invalid",
      );
    },

    async getUser() {
      // getClaims() verifies the token's signature (locally with asymmetric keys, otherwise
      // with the Auth server). getSession() alone would trust whatever the cookie says.
      const { data, error } = await auth.getClaims();
      const sub = data?.claims.sub;
      if (error !== null || sub === undefined) return null;
      return { id: sub as UserId, email: data?.claims.email ?? null };
    },

    async refresh() {
      // Refreshes an expiring session and writes the new cookies through the jar.
      await auth.getClaims();
    },

    async signOut() {
      await auth.signOut();
    },
  };
}
