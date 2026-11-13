import { z } from "zod";

import type { Logger } from "@repo/core";

import { isSameOriginRequest, safeNextPath, seeOther, signInUrl } from "./redirects";
import type { AuthFailure, AuthProvider, CookieJar, SessionUser } from "./types";

/*
 * The sign-in flows, as plain functions from a Request to a Response. The route handlers
 * under src/app/auth only build the context and call these, so the flows can be tested
 * without a running Next.js server.
 *
 * Every outcome is a redirect to a path on this site. Failures go back to /sign-in with a
 * short code; the page turns the code into a sentence. Nothing a person typed is put in a
 * URL or a log line.
 */

export interface AuthFlowContext {
  /** Null when no sign-in is configured for this deployment. */
  readonly provider: AuthProvider | null;
  readonly jar: CookieJar;
  /** APP_URL: where links in emails point, and an origin the forms may be posted from. */
  readonly appUrl: string | undefined;
  /** True when the user is a member of something they may enter. */
  hasAccess(user: SessionUser): Promise<boolean>;
  readonly logger: Logger;
}

/** Shown once by the sign-in page in local mode, where no email can be sent. */
export const LOCAL_MAGIC_LINK_COOKIE = "hsrb_local_magic_link";

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const Password = z.string().min(1).max(1024);

async function readForm(request: Request): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  try {
    const form = await request.formData();
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") fields.set(name, value);
    }
  } catch {
    // Not a form post: treated as an empty form, which fails validation below.
  }
  return fields;
}

function baseUrl(request: Request, ctx: AuthFlowContext): string {
  return ctx.appUrl ?? new URL(request.url).origin;
}

/** Lets a signed-in user in, or signs them out again when they belong to nothing. */
async function enter(
  user: SessionUser,
  next: string,
  ctx: AuthFlowContext,
  provider: AuthProvider,
  method: string,
): Promise<Response> {
  if (!(await ctx.hasAccess(user))) {
    await provider.signOut();
    ctx.logger.warn("auth.sign_in.no_access", { userId: user.id, method });
    return seeOther(signInUrl({ error: "no_access" }));
  }
  ctx.logger.info("auth.sign_in", { userId: user.id, method, provider: provider.mode });
  return seeOther(next);
}

function failed(
  failure: AuthFailure,
  next: string,
  ctx: AuthFlowContext,
  method: string,
): Response {
  ctx.logger.warn("auth.sign_in.failed", { reason: failure.code, method });
  return seeOther(signInUrl({ error: failure.code, next }));
}

/** POST /auth/sign-in: email and password. */
export async function passwordSignIn(request: Request, ctx: AuthFlowContext): Promise<Response> {
  if (!isSameOriginRequest(request, ctx.appUrl)) {
    return seeOther(signInUrl({ error: "forbidden_origin" }));
  }
  const form = await readForm(request);
  const next = safeNextPath(form.get("next"));
  if (ctx.provider === null) return seeOther(signInUrl({ error: "not_configured" }));

  const email = Email.safeParse(form.get("email"));
  const password = Password.safeParse(form.get("password"));
  if (!email.success || !password.success) {
    return seeOther(signInUrl({ error: "invalid_credentials", next }));
  }
  const result = await ctx.provider.signInWithPassword(email.data, password.data);
  if (!result.ok) return failed(result.error, next, ctx, "password");
  return enter(result.value, next, ctx, ctx.provider, "password");
}

/** POST /auth/magic-link: email a sign-in link. */
export async function requestMagicLink(request: Request, ctx: AuthFlowContext): Promise<Response> {
  if (!isSameOriginRequest(request, ctx.appUrl)) {
    return seeOther(signInUrl({ error: "forbidden_origin" }));
  }
  const form = await readForm(request);
  const next = safeNextPath(form.get("next"));
  if (ctx.provider === null) return seeOther(signInUrl({ error: "not_configured" }));

  const email = Email.safeParse(form.get("email"));
  if (!email.success) return seeOther(signInUrl({ error: "invalid_email", next }));

  // Supabase's link comes back with ?code= (PKCE), the local one with ?token_hash=.
  const landing = new URL(
    ctx.provider.mode === "supabase" ? "/auth/callback" : "/auth/confirm",
    baseUrl(request, ctx),
  );
  if (next !== safeNextPath(null)) landing.searchParams.set("next", next);

  const result = await ctx.provider.sendMagicLink(email.data, { redirectTo: landing.toString() });
  if (!result.ok) return failed(result.error, next, ctx, "magic_link");
  if (result.value.link !== null) {
    ctx.jar.set(LOCAL_MAGIC_LINK_COOKIE, result.value.link, {
      httpOnly: true,
      sameSite: "lax",
      path: "/sign-in",
      maxAge: 300,
    });
  }
  ctx.logger.info("auth.magic_link.requested", { provider: ctx.provider.mode });
  // The same answer whether or not the address has an account.
  return seeOther(signInUrl({ notice: "link_sent", next }));
}

/** GET /auth/callback?code=...: the link in a Supabase email (PKCE flow). */
export async function completeCodeSignIn(
  request: Request,
  ctx: AuthFlowContext,
): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  if (ctx.provider === null) return seeOther(signInUrl({ error: "not_configured" }));
  if (code === null || code.length === 0 || code.length > 2048) {
    return seeOther(signInUrl({ error: "link_invalid", next }));
  }
  const result = await ctx.provider.exchangeCode(code);
  if (!result.ok) return failed(result.error, next, ctx, "magic_link");
  return enter(result.value, next, ctx, ctx.provider, "magic_link");
}

/** GET /auth/confirm?token_hash=...&type=...: links built from a token hash. */
export async function completeTokenSignIn(
  request: Request,
  ctx: AuthFlowContext,
): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (ctx.provider === null) return seeOther(signInUrl({ error: "not_configured" }));
  if (tokenHash === null || type === null || tokenHash.length === 0 || tokenHash.length > 4096) {
    return seeOther(signInUrl({ error: "link_invalid", next }));
  }
  const result = await ctx.provider.verifyEmailToken(tokenHash, type);
  if (!result.ok) return failed(result.error, next, ctx, "magic_link");
  ctx.jar.set(LOCAL_MAGIC_LINK_COOKIE, "", { path: "/sign-in", maxAge: 0 });
  return enter(result.value, next, ctx, ctx.provider, "magic_link");
}

/** POST /auth/sign-out. */
export async function signOut(request: Request, ctx: AuthFlowContext): Promise<Response> {
  if (!isSameOriginRequest(request, ctx.appUrl)) {
    return seeOther(signInUrl({ error: "forbidden_origin" }));
  }
  if (ctx.provider !== null) {
    const user = await ctx.provider.getUser().catch(() => null);
    await ctx.provider.signOut();
    ctx.logger.info("auth.sign_out", { userId: user?.id ?? null });
  }
  return seeOther(signInUrl({ notice: "signed_out" }));
}
