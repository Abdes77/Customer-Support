import { err, ok } from "@repo/core";
import type { LocalAuthStore } from "@repo/db";

import {
  clearLocalSession,
  createLocalToken,
  readLocalSession,
  refreshLocalSession,
  verifyLocalToken,
  writeLocalSession,
} from "./local-session";
import type { AuthProvider, CookieJar, SessionUser } from "./types";

export interface LocalProviderOptions {
  readonly jar: CookieJar;
  /** LOCAL_AUTH_SECRET. */
  readonly secret: string;
  /** Mark the session cookie Secure (true when the app is served over HTTPS). */
  readonly secure: boolean;
  /** Users live in the compatibility `auth.users` table. */
  readonly store: LocalAuthStore;
  readonly now?: () => Date;
}

/**
 * Sign-in for local development and CI, where there is no Supabase Auth. Same interface as
 * the Supabase provider, with users from the compatibility bootstrap's `auth.users` table
 * and a signed cookie as the session. There is no mail server, so a "magic link" is handed
 * back to the caller, and the sign-in page shows it.
 */
export function createLocalAuthProvider(options: LocalProviderOptions): AuthProvider {
  const { jar, secret, secure, store } = options;
  const now = options.now ?? (() => new Date());

  const startSession = (user: { id: string; email: string }): SessionUser => {
    writeLocalSession(jar, user, { secret, secure, now: now() });
    return { id: user.id as SessionUser["id"], email: user.email };
  };

  return {
    mode: "local",

    async signInWithPassword(email, password) {
      const user = await store.verifyPassword(email, password);
      if (user === null) return err({ code: "invalid_credentials" });
      return ok(startSession(user));
    },

    async sendMagicLink(email, { redirectTo }) {
      const user = await store.findUserByEmail(email);
      if (user === null) return ok({ link: null });
      const link = new URL(redirectTo);
      link.searchParams.set("token_hash", createLocalToken(user, "magic", secret, now()));
      link.searchParams.set("type", "magiclink");
      return ok({ link: link.toString() });
    },

    async exchangeCode() {
      // Local links always carry a token hash; there is no code flow.
      return err({ code: "link_invalid" });
    },

    async verifyEmailToken(tokenHash, type) {
      if (type !== "magiclink" && type !== "email") return err({ code: "link_invalid" });
      const payload = verifyLocalToken(tokenHash, secret, "magic", now());
      if (payload === null) return err({ code: "link_invalid" });
      // The user may have been deleted since the link was made.
      const user = await store.findUserById(payload.sub as SessionUser["id"]);
      if (user === null) return err({ code: "link_invalid" });
      return ok(startSession(user));
    },

    async getUser() {
      return readLocalSession(jar, secret, now());
    },

    async refresh() {
      refreshLocalSession(jar, { secret, secure, now: now() });
    },

    async signOut() {
      clearLocalSession(jar, secure);
    },
  };
}
