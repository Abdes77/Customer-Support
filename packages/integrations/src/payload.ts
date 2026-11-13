import { createHash } from "node:crypto";

import type { LeadSyncPayload } from "@repo/core";

/*
 * Pure helpers around the canonical payload: derived name parts and ZIP code, the
 * fingerprint that tells whether anything changed since the last push, and the plain-text
 * notes a CRM receives. Customer-written text is never interpreted here; `textToHtml` escapes
 * it for the CRMs whose notes are rich text.
 */

/** `name` split at the last space; one word is a first name. */
export function splitName(name: string | null): {
  readonly firstName: string | null;
  readonly lastName: string | null;
} {
  const clean = (name ?? "").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { firstName: null, lastName: null };
  const at = clean.lastIndexOf(" ");
  if (at <= 0) return { firstName: clean, lastName: null };
  return { firstName: clean.slice(0, at), lastName: clean.slice(at + 1) };
}

/** The last five-digit ZIP code (optionally ZIP+4) in the texts, first text first. */
export function findPostalCode(...texts: readonly (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (text === null || text === undefined) continue;
    const matches = [...text.matchAll(/(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/g)];
    const last = matches.at(-1)?.[1];
    if (last !== undefined) return last;
  }
  return null;
}

/** Stable JSON: object keys sorted, so the same payload always gives the same text. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/**
 * What a CRM would receive, as a hash: the mapped fields and the notes. Times that change on
 * every turn (`lead.updatedAt`) and the trigger are left out, so a turn that changed nothing
 * a CRM sees does not cause an update.
 */
export function payloadFingerprint(parts: unknown): string {
  return createHash("sha256").update(stable(parts)).digest("hex").slice(0, 32);
}

/** The report note: the summary, the report, the link to the conversation. Plain text. */
export function reportNote(payload: LeadSyncPayload): string | null {
  if (payload.lead.report === null) return null;
  const lines = [
    `Lead report (score ${Math.round(payload.lead.score)}, ${payload.lead.band})`,
    "",
    payload.lead.report.markdown.trim(),
    "",
    `Conversation: ${payload.conversation.url}`,
  ];
  return lines.join("\n").slice(0, 60_000);
}

/** The transcript note, when the payload carries one. Plain text. */
export function transcriptNote(payload: LeadSyncPayload): string | null {
  if (payload.transcript === null || payload.transcript === undefined) return null;
  return `Conversation transcript\n\n${payload.transcript}`.slice(0, 60_000);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Plain text as inert HTML (escaped, line breaks kept), for rich-text note fields. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/** A short title for a CRM record: the service asked about, else a generic one. */
export function leadTitle(payload: LeadSyncPayload): string {
  const service = payload.lead.fields["service_type"];
  const text = typeof service === "string" ? service.replace(/\s+/g, " ").trim() : "";
  return (text.length > 0 ? `${text} (${payload.business.name})` : "New lead").slice(0, 200);
}
