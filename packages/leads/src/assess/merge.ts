import type { LeadFieldValue } from "@repo/core";

import { plain } from "./text";

/** A field as the model sends it with `update_lead_fields`. */
export interface IncomingField {
  readonly key: string;
  readonly value: LeadFieldValue["value"];
  readonly confidence: number;
  readonly evidence: string | null;
}

export interface MergeResult {
  readonly fields: Record<string, LeadFieldValue>;
  /** Keys whose stored row changes. */
  readonly changed: readonly string[];
  /** Keys that were sent but kept as they were (a weaker statement than the stored one). */
  readonly kept: readonly string[];
}

/** Evidence is a short quote or paraphrase; it is stored as one line. */
export const MAX_EVIDENCE_CHARACTERS = 300;

/**
 * Merges what a turn learned into the lead record. The newest statement wins, with two
 * exceptions that keep a stated answer from being lost: a guess (lower confidence) does not
 * replace a firmer answer that already counts, and "would not say" (null) does not erase an
 * answer that counts. A stored value below the minimum confidence is always replaced.
 */
export function mergeFields(
  existing: Readonly<Record<string, LeadFieldValue>>,
  incoming: readonly IncomingField[],
  now: string,
  minimumConfidence: number,
): MergeResult {
  const fields: Record<string, LeadFieldValue> = { ...existing };
  const changed: string[] = [];
  const kept: string[] = [];
  for (const entry of incoming) {
    const before = fields[entry.key];
    const evidence =
      entry.evidence === null ? null : plain(entry.evidence, MAX_EVIDENCE_CHARACTERS) || null;
    if (before !== undefined) {
      const beforeCounts = before.value !== null && before.confidence >= minimumConfidence;
      const weaker = entry.confidence < before.confidence;
      if (beforeCounts && (entry.value === null || weaker)) {
        kept.push(entry.key);
        continue;
      }
      if (
        JSON.stringify(before.value) === JSON.stringify(entry.value) &&
        before.confidence === entry.confidence &&
        before.evidence === evidence
      ) {
        continue;
      }
    }
    fields[entry.key] = {
      key: entry.key,
      value: entry.value,
      confidence: entry.confidence,
      evidence,
      updatedAt: now,
    };
    if (!changed.includes(entry.key)) changed.push(entry.key);
  }
  return { fields, changed, kept: [...new Set(kept)].filter((key) => !changed.includes(key)) };
}
