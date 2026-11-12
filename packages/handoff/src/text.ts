/**
 * Customer-written text on its way to staff (alerts by email, SMS and WhatsApp). It is data:
 * flattened, stripped of markup and control characters, and with web addresses made inert,
 * so an alert never carries a live link or markup a customer wrote. The only links in an
 * alert are the ones code builds (the conversation, the acknowledgement page).
 */

/* eslint-disable no-control-regex -- control characters are exactly what this removes */
const CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

/** Writes web addresses and e-mail-looking hosts so no client turns them into links. */
export function inertLinks(text: string): string {
  return (
    text
      .replace(/:\/\//g, "[:]//")
      .replace(/\bwww\./gi, (match) => `${match.slice(0, -1)}[.]`)
      // A dot between letters and a likely top-level domain: example.com -> example[.]com.
      .replace(/([\p{L}\p{N}-])\.([a-z]{2,24})(?=$|[^\p{L}\p{N}])/giu, "$1[.]$2")
  );
}

/** One line of customer-written text, at most `max` characters. */
export function plainLine(value: string | null | undefined, max = 200): string {
  if (value === null || value === undefined) return "";
  const flat = value
    .replace(CONTROL, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\s{2,}/g, " ")
    .trim();
  const inert = inertLinks(flat);
  return inert.length <= max ? inert : `${inert.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Several lines of customer-written text (a lead report), each made plain, at most `max`. */
export function plainBlock(value: string | null | undefined, max = 6000): string {
  if (value === null || value === undefined) return "";
  const lines = value
    .replace(CONTROL, " ")
    .split(/\r?\n/)
    .map((line) =>
      inertLinks(
        line
          .replace(/\t/g, " ")
          .replace(/</g, "‹")
          .replace(/>/g, "›")
          .replace(/\s{2,}/g, " ")
          .trimEnd(),
      ),
    );
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A name staff entered or a person's label: one line, no control characters, links kept. */
export function oneLine(value: string | null | undefined, max = 120): string {
  if (value === null || value === undefined) return "";
  const line = value
    .replace(CONTROL, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A header value (an email subject): one line, no line breaks that could start a header. */
export function headerValue(value: string, max = 200): string {
  return plainLine(value, max);
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A phone number shown in a log or an admin list without its middle digits. */
export function maskPhone(phone: string): string {
  return phone.length <= 6 ? "***" : `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}
