import type { ModelContentBlock } from "@repo/ai";

import { normalizeUrl } from "./document";

/**
 * What the web search actually returned during a playbook generation. A generated playbook
 * may cite only pages in this ledger: a source the search never returned is a source the
 * model made up or remembered, and neither grounds the document.
 *
 * Pages are collected from every `web_search_result` (the results of a search) and every
 * `web_search_result_location` (a citation on the model's text), wherever they sit in a
 * response: directly in a `web_search_tool_result` block, or nested in the result of a code
 * execution call when a tool version with dynamic filtering is used.
 */

export interface SearchSource {
  readonly url: string;
  readonly title: string;
  /** When the page was last updated, as the search reports it ("April 30, 2025"). */
  readonly pageAge: string | null;
}

export interface SearchLedger {
  /** Pages by normalized URL (`normalizeUrl`). */
  readonly sources: Map<string, SearchSource>;
  /** Searches the model ran. */
  searches: number;
  /** Searches that came back as an error, by error code. */
  readonly errors: Map<string, number>;
}

export function createSearchLedger(): SearchLedger {
  return { sources: new Map(), searches: 0, errors: new Map() };
}

const MAX_DEPTH = 12;

function visit(value: unknown, ledger: SearchLedger, depth: number): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, ledger, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (type === "web_search_result" || type === "web_search_result_location") {
    const url = record["url"];
    const key = typeof url === "string" ? normalizeUrl(url) : null;
    if (typeof url === "string" && key !== null && !ledger.sources.has(key)) {
      const title = record["title"];
      const pageAge = record["page_age"];
      ledger.sources.set(key, {
        url,
        title: typeof title === "string" && title.trim().length > 0 ? title.trim() : url,
        pageAge: typeof pageAge === "string" && pageAge.trim().length > 0 ? pageAge.trim() : null,
      });
    }
    return;
  }
  if (type === "server_tool_use" && record["name"] === "web_search") {
    ledger.searches += 1;
    return;
  }
  if (type === "web_search_tool_result_error") {
    const code = typeof record["error_code"] === "string" ? record["error_code"] : "unknown";
    ledger.errors.set(code, (ledger.errors.get(code) ?? 0) + 1);
    return;
  }
  for (const child of Object.values(record)) visit(child, ledger, depth + 1);
}

/** Adds the searches, pages and errors of one response to the ledger. */
export function recordSearches(ledger: SearchLedger, content: readonly ModelContentBlock[]): void {
  visit(content, ledger, 0);
}

/** The page the search returned for this URL, if it did. */
export function findSource(ledger: SearchLedger, url: string): SearchSource | null {
  const key = normalizeUrl(url);
  return key === null ? null : (ledger.sources.get(key) ?? null);
}
