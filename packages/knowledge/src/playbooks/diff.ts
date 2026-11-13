import { PLAYBOOK_SECTIONS, type PlaybookDocument, type PlaybookSection } from "@repo/core";

import { normalizeUrl } from "./document";

/**
 * The difference between two playbook documents, section by section, for the version
 * history in the admin panel. Entries are matched by what names them (a job by its name, a
 * source by its URL), so rewording an answer shows as one changed entry and not as one
 * removed and one added.
 */

type Entry<S extends PlaybookSection> = PlaybookDocument[S][number];

export interface SectionDiff<S extends PlaybookSection = PlaybookSection> {
  readonly section: S;
  readonly added: readonly Entry<S>[];
  readonly removed: readonly Entry<S>[];
  readonly changed: readonly { readonly before: Entry<S>; readonly after: Entry<S> }[];
  readonly unchanged: number;
  /** The entries present in both are in a different order (it matters for the questions). */
  readonly reordered: boolean;
}

export interface PlaybookDiff {
  readonly sections: readonly SectionDiff[];
  /** Sections with any difference, in document order. */
  readonly changedSections: readonly PlaybookSection[];
  readonly identical: boolean;
}

function text(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

const IDENTITY: { readonly [S in PlaybookSection]: (entry: Entry<S>) => string } = {
  commonJobs: (entry) => text(entry.name),
  customerLanguage: (entry) => text(entry.phrase),
  urgencySignals: (entry) => text(entry.signal),
  qualificationQuestions: (entry) => text(entry.question),
  objections: (entry) => text(entry.objection),
  seasonalPatterns: (entry) => text(entry),
  priceNorms: (entry) => `${text(entry.job)}|${text(entry.unit)}|${text(entry.region)}`,
  permitsAndRegulations: (entry) => text(entry),
  vocabulary: (entry) => text(entry.term),
  sources: (entry) => normalizeUrl(entry.url) ?? entry.url,
};

/** Stable JSON: the keys of an entry in sorted order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
    .join(",")}}`;
}

function diffSection<S extends PlaybookSection>(
  section: S,
  before: readonly Entry<S>[],
  after: readonly Entry<S>[],
): SectionDiff<S> {
  const identity = IDENTITY[section];
  const earlier = new Map<string, Entry<S>>();
  for (const entry of before) {
    const id = identity(entry);
    if (!earlier.has(id)) earlier.set(id, entry);
  }
  const added: Entry<S>[] = [];
  const changed: { before: Entry<S>; after: Entry<S> }[] = [];
  const keptOrder: string[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  for (const entry of after) {
    const id = identity(entry);
    const previous = earlier.get(id);
    if (previous === undefined || seen.has(id)) {
      added.push(entry);
      continue;
    }
    seen.add(id);
    keptOrder.push(id);
    if (canonical(previous) === canonical(entry)) unchanged += 1;
    else changed.push({ before: previous, after: entry });
  }
  const removed = [...earlier.entries()].filter(([id]) => !seen.has(id)).map(([, entry]) => entry);
  const earlierOrder = [...earlier.keys()].filter((id) => seen.has(id));
  const reordered = earlierOrder.some((id, index) => keptOrder[index] !== id);
  return { section, added, removed, changed, unchanged, reordered };
}

export function diffPlaybooks(before: PlaybookDocument, after: PlaybookDocument): PlaybookDiff {
  const sections = PLAYBOOK_SECTIONS.map((section): SectionDiff =>
    diffSection(section, before[section] as never[], after[section] as never[]),
  );
  const changedSections = sections
    .filter(
      (diff) =>
        diff.added.length > 0 ||
        diff.removed.length > 0 ||
        diff.changed.length > 0 ||
        diff.reordered,
    )
    .map((diff) => diff.section);
  return { sections, changedSections, identical: changedSections.length === 0 };
}

/** "3 sections changed: common jobs (+1, ~2), price norms (-1)". For audit entries. */
export function summarizeDiff(diff: PlaybookDiff): string {
  if (diff.identical) return "No changes";
  const parts = diff.sections
    .filter((section) => diff.changedSections.includes(section.section))
    .map((section) => {
      const counts = [
        section.added.length > 0 ? `+${section.added.length}` : null,
        section.removed.length > 0 ? `-${section.removed.length}` : null,
        section.changed.length > 0 ? `~${section.changed.length}` : null,
        section.reordered ? "reordered" : null,
      ].filter((part): part is string => part !== null);
      return `${section.section} (${counts.join(", ")})`;
    });
  return parts.join("; ");
}
