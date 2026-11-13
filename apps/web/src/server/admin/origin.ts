/**
 * Cross-site request protection for the admin panel's server actions, the same rule as the
 * sign-in forms (`isSameOriginRequest` in `@/server/auth/redirects`), applied to the headers
 * of the action's request. Next.js compares Origin and Host for every server action too; this
 * is the second, explicit check, and it also refuses a browser's "same-site" request from a
 * sibling subdomain, which Next.js lets through only when the hosts match.
 */
export function isSameOriginHeaders(
  headers: { get(name: string): string | null },
  appUrl: string | undefined,
): boolean {
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = headers.get("origin");
  // Browsers always send Origin with a POST; a request without one is not from a browser
  // form on another site, so forgery is not possible through it.
  if (origin === null) return true;
  const allowed = new Set<string>();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host !== null) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  if (appUrl !== undefined) {
    try {
      allowed.add(new URL(appUrl).origin);
    } catch {
      // A malformed APP_URL is reported by the env loader.
    }
  }
  return allowed.has(origin);
}
