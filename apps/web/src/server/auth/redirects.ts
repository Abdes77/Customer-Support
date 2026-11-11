/** Where to go when no destination was asked for. */
export const DEFAULT_AFTER_SIGN_IN = "/";

/**
 * Makes a "next" parameter safe to redirect to: a path on this site, or the default. An
 * attacker-supplied `next=https://evil.example` or `next=//evil.example` must never send a
 * freshly signed-in user off-site.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (next == null || next.length === 0 || next.length > 512) return DEFAULT_AFTER_SIGN_IN;
  // One leading slash, then anything but a second slash or a backslash (browsers treat
  // "/\" like "//"), and no control characters anywhere.
  if (!/^\/(?![/\\])/.test(next)) return DEFAULT_AFTER_SIGN_IN;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_SIGN_IN;
  // The auth endpoints themselves are never a destination.
  if (next === "/sign-in" || next.startsWith("/sign-in?") || next.startsWith("/auth/")) {
    return DEFAULT_AFTER_SIGN_IN;
  }
  return next;
}

/** `/sign-in` with the given query parameters; empty and undefined values are left out. */
export function signInUrl(params: Readonly<Record<string, string | undefined>> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== "" &&
      !(key === "next" && value === DEFAULT_AFTER_SIGN_IN)
    ) {
      query.set(key, value);
    }
  }
  const text = query.toString();
  return text === "" ? "/sign-in" : `/sign-in?${text}`;
}

/**
 * True unless a browser says the request came from another site. Guards the sign-in and
 * sign-out form posts against cross-site request forgery (including "login CSRF", where an
 * attacker signs the victim in to the attacker's account). Requests without the headers
 * (scripts, tests) are let through: forgery needs a browser.
 */
export function isSameOriginRequest(request: Request, appUrl: string | undefined): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // A relative request URL cannot vouch for an origin.
  }
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedHost !== null) {
    allowed.add(`https://${forwardedHost}`);
    allowed.add(`http://${forwardedHost}`);
  }
  if (appUrl !== undefined) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      // Ignore a malformed APP_URL here; the env loader reports it.
    }
  }
  return allowed.has(origin);
}

/** A redirect that turns the POST into a GET. The location is always a path on this site. */
export function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path } });
}
