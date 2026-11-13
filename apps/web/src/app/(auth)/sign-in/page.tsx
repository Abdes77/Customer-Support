import type { Metadata } from "next";
import { cookies } from "next/headers";

import { getSessionUser, resolveAuthMode, safeNextPath } from "@/server/auth";
import { LOCAL_MAGIC_LINK_COOKIE } from "@/server/auth/flows";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Readonly<Record<string, string>> = {
  invalid_credentials: "That email and password do not match. Check both and try again.",
  invalid_email: "Enter the email address your account uses.",
  link_invalid:
    "That sign-in link is no longer valid. Links work once and expire quickly; ask for a new one.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  unavailable: "Sign-in is not available right now. Try again in a moment.",
  no_access:
    "Your account is not linked to an agency or business yet, or logins are switched off for your business. Ask your agency contact for access.",
  forbidden_origin:
    "That request did not come from this site. Open the sign-in page and try again.",
  not_configured: "Sign-in is not set up on this deployment yet.",
};

const NOTICES: Readonly<Record<string, string>> = {
  link_sent:
    "If that address has an account, a sign-in link is on its way. It works once and expires in a few minutes.",
  signed_out: "You are signed out.",
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The local sign-in link as a path on this site; anything else in the cookie is ignored. */
function localLinkPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.pathname === "/auth/confirm" ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}

const inputClass =
  "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";
const labelClass = "block text-sm font-medium text-slate-800";
const primaryButton =
  "inline-flex w-full items-center justify-center rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";
const secondaryButton =
  "inline-flex w-full items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params["next"]));
  const error = ERRORS[first(params["error"]) ?? ""];
  const notice = NOTICES[first(params["notice"]) ?? ""];
  const mode = resolveAuthMode();
  const user = await getSessionUser();
  const localLink =
    mode === "local" && notice !== undefined
      ? localLinkPath((await cookies()).get(LOCAL_MAGIC_LINK_COOKIE)?.value)
      : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-center text-2xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-2 text-center text-sm text-slate-600">
          Home-services reply bot: admin panel and client portal
        </p>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          {error !== undefined && (
            <p
              role="alert"
              className="mb-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </p>
          )}
          {notice !== undefined && (
            <p
              role="status"
              className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              {notice}
            </p>
          )}
          {localLink !== undefined && (
            <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Local sign-in mode sends no email. Your link:{" "}
              <a
                className="font-medium break-all underline"
                href={localLink}
                data-testid="local-magic-link"
              >
                open sign-in link
              </a>
            </p>
          )}

          {mode === "unconfigured" ? (
            <div className="space-y-3 text-sm text-slate-700" data-testid="auth-unconfigured">
              <p className="font-medium text-slate-900">Sign-in is not set up yet.</p>
              <p>
                Set <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code className="rounded bg-slate-100 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> for
                Supabase Auth, or{" "}
                <code className="rounded bg-slate-100 px-1">LOCAL_AUTH_SECRET</code> for local
                development. docs/HUMAN_TODO.md has the steps.
              </p>
            </div>
          ) : user !== null ? (
            <div className="space-y-4" data-testid="signed-in">
              <p className="text-sm text-slate-700">
                You are signed in{user.email === null ? "" : " as "}
                {user.email !== null && (
                  <span className="font-medium text-slate-900">{user.email}</span>
                )}
                .
              </p>
              <a className={primaryButton} href={next}>
                Continue
              </a>
              <form method="post" action="/auth/sign-out">
                <button type="submit" className={secondaryButton}>
                  Sign out
                </button>
              </form>
            </div>
          ) : (
            <>
              <form method="post" action="/auth/sign-in" className="space-y-4">
                <input type="hidden" name="next" value={next} />
                <div className="space-y-1.5">
                  <label htmlFor="email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    required
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="password" className={labelClass}>
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    className={inputClass}
                  />
                </div>
                <button type="submit" className={primaryButton}>
                  Sign in
                </button>
              </form>

              <div className="my-6 flex items-center gap-3 text-xs tracking-wide text-slate-500 uppercase">
                <span className="h-px flex-1 bg-slate-200" />
                or
                <span className="h-px flex-1 bg-slate-200" />
              </div>

              <form method="post" action="/auth/magic-link" className="space-y-4">
                <input type="hidden" name="next" value={next} />
                <div className="space-y-1.5">
                  <label htmlFor="magic-email" className={labelClass}>
                    Email me a sign-in link
                  </label>
                  <input
                    id="magic-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    required
                    className={inputClass}
                  />
                </div>
                <button type="submit" className={secondaryButton}>
                  Send link
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Accounts are created by your agency. There is no public sign-up.
        </p>
      </div>
    </main>
  );
}
