/**
 * Allowed origins (`channels.widget.allowed_origins`). An origin is compared as scheme, host
 * and port: `https://example.com` does not allow `https://www.example.com` or
 * `http://example.com`. An empty list allows nothing.
 */

/** `scheme://host[:port]` in lower case without a default port, or null when it is not one. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // An origin has no path; tolerate a trailing slash in a stored setting.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin.toLowerCase();
}

export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  return allowed.some((entry) => normalizeOrigin(entry) === normalized);
}
