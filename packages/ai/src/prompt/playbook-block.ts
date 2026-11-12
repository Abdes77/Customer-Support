import type { BusinessProfile, PlaybookDocument, PlaybookSnapshot } from "@repo/core";

import { placeholderPlaybook } from "./placeholder-playbooks";
import { dataLine, dataText, lines } from "./text";

/**
 * The playbook section of the system prompt: the second cached block, shared by every
 * business of the segment that uses the same playbook version. A playbook is generated from
 * web research and edited by the agency, so its text is placed as data (angle brackets
 * neutralized) inside one tag; the core prompt says how to use it.
 */

function section<T>(title: string, items: readonly T[], line: (item: T, index: number) => string) {
  if (items.length === 0) return null;
  return lines(`# ${title}`, ...items.map(line));
}

function renderDocument(document: PlaybookDocument): string {
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
      "Price norms for the trade (general figures; state one only when the business's pricing rules allow playbook ranges)",
      document.priceNorms,
      (item) =>
        `- ${dataLine(item.job)}: ${dataLine(item.range)}${
          item.notes === null || item.notes.trim().length === 0 ? "" : ` (${dataLine(item.notes)})`
        }`,
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
    return { label: `${playbook.segmentSlug} v${playbook.version}`, document: playbook.document };
  }
  const placeholder = placeholderPlaybook(business.segment.slug);
  return { label: `${placeholder.slug} (built-in placeholder)`, document: placeholder.document };
}

export function renderPlaybookBlock(
  playbook: PlaybookSnapshot | null,
  business: BusinessProfile,
): string {
  const { label, document } = effectivePlaybook(playbook, business);
  return `<playbook trade="${dataLine(business.segment.name)}" source="${dataLine(label)}">\n${renderDocument(document)}\n</playbook>`;
}
