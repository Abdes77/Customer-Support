import {
  type BusinessProfile,
  formatPriceNorm,
  type PlaybookDocument,
  type PlaybookPriceNorm,
  type PlaybookSnapshot,
} from "@repo/core";
import type { AppSettings } from "@repo/settings";

import { moneyAmounts } from "../guard/money";
import { placeholderPlaybook } from "./placeholder-playbooks";
import { dataLine, dataText, lines } from "./text";

/**
 * The playbook section of the system prompt: the second cached block, shared by every
 * business of the segment that uses the same playbook version and the same pricing rules. A
 * playbook is generated from web research and edited by the agency, so its text is placed as
 * data (angle brackets neutralized) inside one tag; the core prompt says how to use it.
 *
 * Price norms are the exception to "the whole playbook is shown": they are general figures
 * for a trade and a region, not this business's prices, so the model sees them only when the
 * business's pricing settings let the bot use them (`playbookPricesAllowed`). The output
 * guard allows a playbook figure under the same condition and from the same list
 * (`playbookPriceAmounts`), so what the model is shown and what it may say cannot drift apart.
 */

/**
 * Whether the playbook's price norms may reach the customer: prices are disclosed at all,
 * and the business chose to fall back on industry ranges.
 */
export function playbookPricesAllowed(
  values: Pick<AppSettings, "pricing.disclosure" | "pricing.use_playbook_ranges">,
): boolean {
  return values["pricing.disclosure"] !== "never" && values["pricing.use_playbook_ranges"];
}

/** The price norms the model is shown: all of them when allowed, none otherwise. */
export function visiblePriceNorms(
  document: PlaybookDocument,
  values: Pick<AppSettings, "pricing.disclosure" | "pricing.use_playbook_ranges">,
): readonly PlaybookPriceNorm[] {
  return playbookPricesAllowed(values) ? document.priceNorms : [];
}

function priceNormLine(norm: PlaybookPriceNorm): string {
  const notes =
    norm.notes === null || norm.notes.trim().length === 0 ? "" : ` (${dataLine(norm.notes)})`;
  return `- ${dataLine(norm.job)}: ${dataLine(formatPriceNorm(norm))}${notes}`;
}

/**
 * Every dollar figure in the price norms as the model is shown them: the two ends of each
 * range and any figure in its notes. This is the list the output guard allows.
 */
export function playbookPriceAmounts(norms: readonly PlaybookPriceNorm[]): number[] {
  return [...new Set(norms.flatMap((norm) => moneyAmounts(priceNormLine(norm))))];
}

function section<T>(title: string, items: readonly T[], line: (item: T, index: number) => string) {
  if (items.length === 0) return null;
  return lines(`# ${title}`, ...items.map(line));
}

function renderDocument(
  document: PlaybookDocument,
  priceNorms: readonly PlaybookPriceNorm[],
): string {
  const parts = [
    section(
      "Common jobs",
      document.commonJobs,
      (job) => `- ${dataLine(job.name)}: ${dataLine(job.scope)}`,
    ),
    section(
      "How customers describe problems",
      document.customerLanguage,
      (item) => `- "${dataLine(item.phrase)}": ${dataLine(item.meaning)}`,
    ),
    section(
      "Urgency signals",
      document.urgencySignals,
      (item) => `- [${item.level}] ${dataLine(item.signal)}`,
    ),
    section(
      "Qualification questions, in the order they are usually asked",
      document.qualificationQuestions,
      (item, index) => `${index + 1}. ${dataLine(item.question)} (${dataLine(item.why)})`,
    ),
    section(
      "Objections and good answers",
      document.objections,
      (item) => `- "${dataLine(item.objection)}": ${dataLine(item.response)}`,
    ),
    section("Seasonal patterns", document.seasonalPatterns, (item) => `- ${dataLine(item)}`),
    section(
      "Price norms for the trade (general figures for the region named, never this business's own prices; the business's pricing rules say when you may state one)",
      priceNorms,
      priceNormLine,
    ),
    section(
      "Permits and regulations (mention carefully, never as legal advice)",
      document.permitsAndRegulations,
      (item) => `- ${dataLine(item)}`,
    ),
    section(
      "Vocabulary",
      document.vocabulary,
      (item) => `- ${dataLine(item.term)}: ${dataText(item.definition).replaceAll(/\s+/g, " ")}`,
    ),
  ];
  return parts.filter((part): part is string => part !== null).join("\n\n");
}

/** The playbook in force, or the built-in placeholder when the segment has none yet. */
export function effectivePlaybook(
  playbook: PlaybookSnapshot | null,
  business: BusinessProfile,
): { readonly label: string; readonly document: PlaybookDocument } {
  if (playbook !== null) {
    const own =
      (playbook.overriddenSections ?? []).length > 0 ? ", with this business's own sections" : "";
    return {
      label: `${playbook.segmentSlug} v${playbook.version}${own}`,
      document: playbook.document,
    };
  }
  const placeholder = placeholderPlaybook(business.segment.slug);
  return { label: `${placeholder.slug} (built-in placeholder)`, document: placeholder.document };
}

export function renderPlaybookBlock(
  playbook: PlaybookSnapshot | null,
  business: BusinessProfile,
  values: Pick<AppSettings, "pricing.disclosure" | "pricing.use_playbook_ranges">,
): string {
  const { label, document } = effectivePlaybook(playbook, business);
  const body = renderDocument(document, visiblePriceNorms(document, values));
  return `<playbook trade="${dataLine(business.segment.name)}" source="${dataLine(label)}">\n${body}\n</playbook>`;
}
