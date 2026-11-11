import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { logger } from "@repo/core";
import { getEnv } from "@repo/core/env";
import {
  getDatabase,
  hasAnyAccess,
  loadUserAccess,
  type UserAccess,
  type UserScope,
} from "@repo/db";

import { jarFromCookieStore } from "./cookies";
import type { AuthFlowContext } from "./flows";
import { createAuthProvider } from "./provider";
import { safeNextPath, signInUrl } from "./redirects";
import type { SessionUser } from "./types";

/*
 * Who is asking? Server components, server actions and route handlers start here. Nothing
 * in this file is an authorization layer on its own: it establishes the user and their
 * memberships, the caller decides what that allows (`requireAgencyRole`,
 * `requireBusinessRole` from @repo/db), and row-level security has the last word.
 */

export interface SessionAccess {
  readonly user: SessionUser;
  readonly access: UserAccess;
}

/** The user of the request's session, verified, or null. Memoized per render. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const provider = createAuthProvider(jarFromCookieStore(await cookies()));
  if (provider === null) return null;
  try {
    return await provider.getUser();
  } catch (error) {
    logger.error("auth.session.failed", { error });
    return null;
  }
});

/** The database as this user: row-level security applies to everything done through it. */
export function userDatabase(user: SessionUser): UserScope {
  return getDatabase().asUser({ id: user.id, email: user.email });
}

/** The user and their memberships, or null when nobody is signed in. Memoized per render. */
export const getAccess = cache(async (): Promise<SessionAccess | null> => {
  const user = await getSessionUser();
  if (user === null) return null;
  const access = await userDatabase(user).run((ctx) => loadUserAccess(ctx));
  return { user, access };
});

/** The signed-in user, or a redirect to the sign-in page that comes back to `next`. */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) redirect(signInUrl({ next: safeNextPath(next) }) as Route);
  return user;
}

/**
 * The signed-in user with their memberships. Redirects to the sign-in page when nobody is
 * signed in, and when the user is a member of nothing they may enter.
 */
export async function requireAccess(next?: string): Promise<SessionAccess> {
  const session = await getAccess();
  if (session === null) redirect(signInUrl({ next: safeNextPath(next) }) as Route);
  if (!hasAnyAccess(session.access)) redirect(signInUrl({ error: "no_access" }) as Route);
  return session;
}

/** The context the sign-in flows run in, for a route handler. */
export async function authFlowContext(): Promise<AuthFlowContext> {
  const jar = jarFromCookieStore(await cookies());
  return {
    provider: createAuthProvider(jar),
    jar,
    appUrl: getEnv().APP_URL,
    hasAccess: async (user) =>
      hasAnyAccess(await userDatabase(user).run((ctx) => loadUserAccess(ctx))),
    logger: logger.child({ area: "auth" }),
  };
}
