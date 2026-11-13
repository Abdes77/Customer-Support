import { z } from "zod";

/** Mail address helpers shared by parsing, classification and composition. */

const Email = z.email();

/** Lower-cased, trimmed address, or null when it is not a valid address. */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .toLowerCase();
  return Email.safeParse(trimmed).success ? trimmed : null;
}

/** The domain of an address (lower case), or null. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at < 0 ? null : address.slice(at + 1).toLowerCase();
}

/**
 * Domains of public mail services. A business that uses one of these for its inbox shares
 * the domain with its customers, so "same domain as the inbox" must not mean internal mail.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.us",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "frontier.com",
  "windstream.net",
]);

/** True for a domain or one of its subdomains in `domains`. */
export function domainMatches(domain: string, domains: Iterable<string>): boolean {
  const lower = domain.toLowerCase();
  for (const candidate of domains) {
    const item = candidate.trim().toLowerCase().replace(/^@/, "");
    if (item.length === 0) continue;
    if (lower === item || lower.endsWith(`.${item}`)) return true;
  }
  return false;
}

/** Local parts of addresses that never read replies. */
const NO_REPLY =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|bounces?|mailer[-_.]?daemon|postmaster|notifications?|alerts?)(?:[-_+.].*)?$/i;

/** True for addresses such as `noreply@…`, `notifications@…`, `mailer-daemon@…`. */
export function isNoReplyAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = at < 0 ? address : address.slice(0, at);
  return NO_REPLY.test(local);
}

/** "Maria Lopez" <maria@example.com> as one header value. */
export function formatAddress(address: string, name: string | null | undefined): string {
  const display = (name ?? "").replace(/[\r\n"\\]/g, " ").trim();
  return display.length === 0 ? address : `"${display}" <${address}>`;
}
