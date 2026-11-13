import { ConfigError, ExternalServiceError, type UserId } from "@repo/core";
import { type DeploymentInfo, deploymentInfo, type Env, getEnv, requireEnv } from "@repo/core/env";
import {
  createSupabaseAuthAdmin,
  type Directory,
  getDatabase,
  type LocalAuthStore,
  type SupabaseAuthAdmin,
} from "@repo/db";

import { resolveAuthMode } from "@/server/auth/mode";
import { createLocalToken } from "@/server/auth/local-session";

/*
 * Letting a person know they were given access (C18, people management). One answer whether
 * or not the address already had an account, so the add form cannot be used to find out who
 * has one:
 *
 * - Supabase: a new address gets Supabase's "Invite user" email (the account is created by
 *   Supabase's server-side admin API with the service-role key); an existing account gets the
 *   "Magic Link" email instead. Both links come back to `/auth/confirm` (token hash), as the
 *   email templates in docs/HUMAN_TODO.md say. The key is read here, on the server, and goes
 *   nowhere else.
 * - Local sign-in (development and the browser tests): the account is created in the local
 *   store and the sign-in link is handed back to be shown, as the sign-in page does, since no
 *   email can be sent.
 *
 * Nothing here logs or returns the address.
 */

export interface Invitation {
  readonly userId: UserId;
  /** Local sign-in only: the link to give the person. Null when an email was sent. */
  readonly link: string | null;
}

export interface Inviter {
  readonly mode: "supabase" | "local";
  invite(email: string): Promise<Invitation>;
}

/** Where invitation and sign-in links land: the token-hash route of the sign-in flows. */
export function confirmUrl(appUrl: string): string {
  return new URL("/auth/confirm", appUrl).toString();
}

export function createSupabaseInviter(options: {
  readonly admin: SupabaseAuthAdmin;
  readonly directory: Pick<Directory, "findUserByEmail">;
  readonly appUrl: string;
}): Inviter {
  const redirectTo = confirmUrl(options.appUrl);
  const signInLink = async (email: string, userId: UserId): Promise<Invitation> => {
    await options.admin.sendSignInLink({ email, redirectTo });
    return { userId, link: null };
  };
  return {
    mode: "supabase",
    async invite(email) {
      // Supabase mirrors every auth user into public.users (migration 0002's trigger).
      const existing = await options.directory.findUserByEmail(email);
      if (existing !== null) return signInLink(email, existing.id);
      const invited = await options.admin.inviteUser({ email, redirectTo });
      if (invited !== "exists") return { userId: invited.id, link: null };
      // The account appeared in between (or the profile mirror lags): look it up again.
      const late = await options.directory.findUserByEmail(email);
      if (late === null) {
        throw new ExternalServiceError(
          "Supabase Auth says the address has an account, but no profile was found for it.",
          { provider: "supabase_auth", retryable: true },
        );
      }
      return signInLink(email, late.id);
    },
  };
}

export function createLocalInviter(options: {
  readonly store: LocalAuthStore;
  /** LOCAL_AUTH_SECRET. */
  readonly secret: string;
  readonly appUrl: string;
  readonly now?: () => Date;
}): Inviter {
  const now = options.now ?? (() => new Date());
  return {
    mode: "local",
    async invite(email) {
      const user =
        (await options.store.findUserByEmail(email)) ?? (await options.store.upsertUser({ email }));
      const link = new URL(confirmUrl(options.appUrl));
      link.searchParams.set("token_hash", createLocalToken(user, "magic", options.secret, now()));
      link.searchParams.set("type", "magiclink");
      return { userId: user.id, link: `${link.pathname}${link.search}` };
    },
  };
}

/**
 * The inviter for this deployment, or the reason there is none: Supabase needs the
 * service-role key on the server; local sign-in needs its secret.
 */
export function inviterForDeployment(
  env: Env = getEnv(),
  deployment: DeploymentInfo = deploymentInfo(),
): Inviter | { readonly unavailable: string } {
  const mode = resolveAuthMode(env, deployment);
  if (mode === "supabase") {
    if (env.SUPABASE_SERVICE_ROLE_KEY === undefined || env.APP_URL === undefined) {
      return {
        unavailable:
          "Inviting people needs SUPABASE_SERVICE_ROLE_KEY and APP_URL on the server (docs/HUMAN_TODO.md).",
      };
    }
    const config = requireEnv(
      env,
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "APP_URL",
    );
    return createSupabaseInviter({
      admin: createSupabaseAuthAdmin({
        url: config.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
      }),
      directory: getDatabase().directory,
      appUrl: config.APP_URL,
    });
  }
  if (mode === "local") {
    if (env.LOCAL_AUTH_SECRET === undefined) throw new ConfigError("LOCAL_AUTH_SECRET is not set.");
    return createLocalInviter({
      store: getDatabase().localAuth,
      secret: env.LOCAL_AUTH_SECRET,
      appUrl: env.APP_URL ?? "http://localhost:3000",
    });
  }
  return { unavailable: "Sign-in is not configured on this deployment." };
}
