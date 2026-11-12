import type { z } from "zod";

import { moneyAmounts } from "@repo/ai";
import {
  PLAYBOOK_SECTION_LABELS,
  PLAYBOOK_SECTION_SCHEMAS,
  PLAYBOOK_SECTIONS,
  PlaybookDocument,
  type PlaybookSection,
} from "@repo/core";

import { looksLikeInstruction } from "../knowledge/text";

/**
 * Checking a playbook document. Three levels:
 *
 * 1. the schema (`PlaybookDocument` in @repo/core): shape and length limits;
 * 2. the rules every stored document follows (`documentRuleIssues`): dollar figures only in
 *    the price norms, no duplicate entries, sources that are distinct web pages;
 * 3. completeness (`completenessIssues`): enough content in every section for the document
 *    to be a playbook. Required of a generated document; a warning for a hand edit, because
 *    an agency may deliberately cut a section down.
 *
 * Every problem is an issue with the place it is in and a sentence that can be shown to an
 * admin or returned to the model as it is.
 */

export interface PlaybookIssue {
  /** Null when the problem is not inside one section (the value is not an object at all). */
  readonly section: PlaybookSection | null;
  /** "priceNorms[2].highUsd", "sources", "" for the document itself. */
  readonly path: string;
  readonly message: string;
}

export type ParsedPlaybook =
  | { readonly ok: true; readonly document: PlaybookDocument }
  | { readonly ok: false; readonly issues: readonly PlaybookIssue[] };

function pathOf(parts: readonly PropertyKey[]): string {
  let out = "";
  for (const part of parts) {
    out += typeof part === "number" ? `[${part}]` : `${out.length > 0 ? "." : ""}${String(part)}`;
  }
  return out;
}

function sectionOf(parts: readonly PropertyKey[]): PlaybookSection | null {
  const first = parts[0];
  return typeof first === "string" && (PLAYBOOK_SECTIONS as readonly string[]).includes(first)
    ? (first as PlaybookSection)
    : null;
}

function zodIssues(error: z.ZodError, prefix: readonly PropertyKey[] = []): PlaybookIssue[] {
  return error.issues.map((issue) => {
    const parts = [...prefix, ...issue.path];
    return { section: sectionOf(parts), path: pathOf(parts), message: issue.message };
  });
}

function key(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/** A URL without what does not identify the page: fragment, a trailing slash, letter case of the host. */
export function normalizeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  const path = url.pathname.replace(/\/+$/, "");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return `${host}${url.port.length > 0 ? `:${url.port}` : ""}${path}${url.search}`;
}

interface TextEntry {
  readonly section: PlaybookSection;
  readonly path: string;
  readonly text: string;
}

/** Every text of the document outside the price norms and the sources, with its place. */
function textsOutsidePrices(document: PlaybookDocument): TextEntry[] {
  const out: TextEntry[] = [];
  const add = (section: PlaybookSection, index: number, field: string | null, text: string) =>
    out.push({ section, path: `${section}[${index}]${field === null ? "" : `.${field}`}`, text });
  document.commonJobs.forEach((item, index) => {
    add("commonJobs", index, "name", item.name);
    add("commonJobs", index, "scope", item.scope);
  });
  document.customerLanguage.forEach((item, index) => {
    add("customerLanguage", index, "phrase", item.phrase);
    add("customerLanguage", index, "meaning", item.meaning);
  });
  document.urgencySignals.forEach((item, index) =>
    add("urgencySignals", index, "signal", item.signal),
  );
  document.qualificationQuestions.forEach((item, index) => {
    add("qualificationQuestions", index, "question", item.question);
    add("qualificationQuestions", index, "why", item.why);
  });
  document.objections.forEach((item, index) => {
    add("objections", index, "objection", item.objection);
    add("objections", index, "response", item.response);
  });
  document.seasonalPatterns.forEach((item, index) => add("seasonalPatterns", index, null, item));
  document.permitsAndRegulations.forEach((item, index) =>
    add("permitsAndRegulations", index, null, item),
  );
  document.vocabulary.forEach((item, index) => {
    add("vocabulary", index, "term", item.term);
    add("vocabulary", index, "definition", item.definition);
  });
  return out;
}

function duplicates<T>(
  section: PlaybookSection,
  items: readonly T[],
  identity: (item: T) => string,
  what: string,
): PlaybookIssue[] {
  const seen = new Map<string, number>();
  const issues: PlaybookIssue[] = [];
  items.forEach((item, index) => {
    const id = identity(item);
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, index);
      return;
    }
    issues.push({
      section,
      path: `${section}[${index}]`,
      message: `This ${what} is already in the list (entry ${first + 1}).`,
    });
  });
  return issues;
}

/**
 * The rules every stored playbook follows beyond its schema.
 *
 * The first one is what keeps "price norms reach a customer only as the pricing settings
 * allow" true: the engine hides the price norms when the settings say so, which only works
 * if no other section carries a price.
 */
export function documentRuleIssues(document: PlaybookDocument): PlaybookIssue[] {
  const issues: PlaybookIssue[] = [];
  for (const entry of textsOutsidePrices(document)) {
    if (moneyAmounts(entry.text).length > 0) {
      issues.push({
        section: entry.section,
        path: entry.path,
        message:
          "Dollar figures belong in the price norms only: move the figure there or describe it without a number.",
      });
    }
  }
  // A playbook is written from web pages and reaches every business of the segment: text
  // that addresses the assistant (a page's injected instruction carried over) is refused.
  const instructionTexts: TextEntry[] = [
    ...textsOutsidePrices(document),
    ...document.priceNorms.flatMap((norm, index) =>
      [norm.job, norm.unit, norm.region, norm.notes ?? ""].map((text) => ({
        section: "priceNorms" as const,
        path: `priceNorms[${index}]`,
        text,
      })),
    ),
    ...document.sources.map((source, index) => ({
      section: "sources" as const,
      path: `sources[${index}].title`,
      text: source.title,
    })),
  ];
  const flagged = new Set<string>();
  for (const entry of instructionTexts) {
    if (flagged.has(entry.path) || !looksLikeInstruction(entry.text)) continue;
    flagged.add(entry.path);
    issues.push({
      section: entry.section,
      path: entry.path,
      message:
        "This reads like an instruction to an AI assistant, not trade knowledge: describe the trade, never address the assistant.",
    });
  }
  issues.push(
    ...duplicates("commonJobs", document.commonJobs, (item) => key(item.name), "job"),
    ...duplicates("customerLanguage", document.customerLanguage, (i) => key(i.phrase), "phrase"),
    ...duplicates("urgencySignals", document.urgencySignals, (item) => key(item.signal), "signal"),
    ...duplicates(
      "qualificationQuestions",
      document.qualificationQuestions,
      (item) => key(item.question),
      "question",
    ),
    ...duplicates("objections", document.objections, (item) => key(item.objection), "objection"),
    ...duplicates("vocabulary", document.vocabulary, (item) => key(item.term), "term"),
    ...duplicates(
      "priceNorms",
      document.priceNorms,
      (item) => `${key(item.job)}|${key(item.unit)}|${key(item.region)}`,
      "price norm (same job, unit and region)",
    ),
    ...duplicates(
      "sources",
      document.sources,
      (item) => normalizeUrl(item.url) ?? item.url,
      "source",
    ),
  );
  return issues;
}

/** Checks the schema only. The parsed document has every text trimmed. */
export function parsePlaybookSchema(value: unknown): ParsedPlaybook {
  const parsed = PlaybookDocument.safeParse(value);
  return parsed.success
    ? { ok: true, document: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

/** Checks the schema, then the rules. The parsed document has every text trimmed. */
export function parsePlaybookDocument(value: unknown): ParsedPlaybook {
  const parsed = parsePlaybookSchema(value);
  if (!parsed.ok) return parsed;
  const issues = documentRuleIssues(parsed.document);
  return issues.length > 0 ? { ok: false, issues } : parsed;
}

export type ParsedSection<S extends PlaybookSection = PlaybookSection> =
  | { readonly ok: true; readonly content: PlaybookDocument[S] }
  | { readonly ok: false; readonly issues: readonly PlaybookIssue[] };

const EMPTY_DOCUMENT: PlaybookDocument = {
  commonJobs: [],
  customerLanguage: [],
  urgencySignals: [],
  qualificationQuestions: [],
  objections: [],
  seasonalPatterns: [],
  priceNorms: [],
  permitsAndRegulations: [],
  vocabulary: [],
  sources: [],
};

/** Checks the content of one section (a per-business override) against schema and rules. */
export function parsePlaybookSection<S extends PlaybookSection>(
  section: S,
  content: unknown,
): ParsedSection<S> {
  const schema: z.ZodType = PLAYBOOK_SECTION_SCHEMAS[section];
  const parsed = schema.safeParse(content);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, [section]) };
  const value = parsed.data as PlaybookDocument[S];
  const issues = documentRuleIssues({ ...EMPTY_DOCUMENT, [section]: value });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, content: value };
}

/** The least a generated playbook holds in each section. */
export const COMPLETENESS_MINIMUMS: Readonly<Record<PlaybookSection, number>> = {
  commonJobs: 4,
  customerLanguage: 4,
  urgencySignals: 3,
  qualificationQuestions: 4,
  objections: 3,
  seasonalPatterns: 2,
  priceNorms: 2,
  permitsAndRegulations: 1,
  vocabulary: 5,
  sources: 3,
};

/** What a complete playbook is missing. Empty for a complete one. */
export function completenessIssues(document: PlaybookDocument): PlaybookIssue[] {
  const issues: PlaybookIssue[] = [];
  for (const section of PLAYBOOK_SECTIONS) {
    const minimum = COMPLETENESS_MINIMUMS[section];
    const count = document[section].length;
    if (count < minimum) {
      issues.push({
        section,
        path: section,
        message: `"${PLAYBOOK_SECTION_LABELS[section]}" needs at least ${minimum} ${minimum === 1 ? "entry" : "entries"}; it has ${count}.`,
      });
    }
  }
  if (
    document.urgencySignals.length > 0 &&
    !document.urgencySignals.some((item) => item.level !== "routine")
  ) {
    issues.push({
      section: "urgencySignals",
      path: "urgencySignals",
      message:
        "At least one urgency signal has to be urgent or an emergency, so the bot can tell a routine request from one that cannot wait.",
    });
  }
  if (
    document.urgencySignals.length > 0 &&
    !document.urgencySignals.some((item) => item.level === "routine")
  ) {
    issues.push({
      section: "urgencySignals",
      path: "urgencySignals",
      message: "Include at least one routine signal, so the bot can tell what is not urgent.",
    });
  }
  document.priceNorms.forEach((norm, index) => {
    if (norm.highUsd <= 0) {
      issues.push({
        section: "priceNorms",
        path: `priceNorms[${index}].highUsd`,
        message: "A price norm needs a range above zero.",
      });
    }
  });
  return issues;
}

/** Issues as the lines of a list, for a model's tool result or an error message. */
export function describeIssues(issues: readonly PlaybookIssue[], limit = 25): string {
  const lines = issues
    .slice(0, limit)
    .map((issue) => `- ${issue.path.length > 0 ? `${issue.path}: ` : ""}${issue.message}`);
  if (issues.length > limit) lines.push(`- and ${issues.length - limit} more.`);
  return lines.join("\n");
}
