import type { PlaybookSection } from "@repo/core";

/*
 * The shape of each playbook section's entries, for the viewer and the editor. Fixed by the
 * `PlaybookDocument` contract (C6); a section is a list of entries with these fields.
 */

export interface EntryField {
  readonly name: string;
  readonly label: string;
  readonly kind: "short" | "long" | "number" | "level" | "url" | "nullable_long";
}

/** Null: the entries are plain sentences. */
export const SECTION_FIELDS: Readonly<Record<PlaybookSection, readonly EntryField[] | null>> = {
  commonJobs: [
    { name: "name", label: "Job", kind: "short" },
    { name: "scope", label: "What it involves", kind: "long" },
  ],
  customerLanguage: [
    { name: "phrase", label: "What customers say", kind: "short" },
    { name: "meaning", label: "What it usually means", kind: "long" },
  ],
  urgencySignals: [
    { name: "signal", label: "Signal", kind: "long" },
    { name: "level", label: "Level", kind: "level" },
  ],
  qualificationQuestions: [
    { name: "question", label: "Question", kind: "long" },
    { name: "why", label: "Why it matters", kind: "long" },
  ],
  objections: [
    { name: "objection", label: "Objection", kind: "long" },
    { name: "response", label: "A good answer", kind: "long" },
  ],
  seasonalPatterns: null,
  priceNorms: [
    { name: "job", label: "Job", kind: "short" },
    { name: "lowUsd", label: "Low (USD)", kind: "number" },
    { name: "highUsd", label: "High (USD)", kind: "number" },
    { name: "unit", label: "Unit", kind: "short" },
    { name: "region", label: "Region", kind: "short" },
    { name: "notes", label: "Notes", kind: "nullable_long" },
  ],
  permitsAndRegulations: null,
  vocabulary: [
    { name: "term", label: "Term", kind: "short" },
    { name: "definition", label: "Meaning", kind: "long" },
  ],
  sources: [
    { name: "title", label: "Title", kind: "short" },
    { name: "url", label: "Address", kind: "url" },
  ],
};

export const URGENCY_LEVELS = ["emergency", "urgent", "routine"] as const;

export function blankEntry(section: PlaybookSection): unknown {
  const fields = SECTION_FIELDS[section];
  if (fields === null) return "";
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.kind === "number"
        ? 0
        : field.kind === "level"
          ? "routine"
          : field.kind === "nullable_long"
            ? null
            : "",
    ]),
  );
}
