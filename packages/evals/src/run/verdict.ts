import type { RunMode } from "../grade/score";
import type { Comparison } from "./baseline";
import type { RunSummary, ScenarioAggregate } from "./summary";

/**
 * What a run comes to: one headline, the reasons, and the exit code of `pnpm eval`.
 *
 *   0  passed
 *   1  failed: a conversation did not pass, quality dropped against the baseline, or a dry
 *      run wrote to the database
 *   3  incomplete: some conversations could not be played or judged, so nothing can be said
 *
 * (2 is a usage or configuration error and never gets this far.)
 */
export interface Verdict {
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 3;
  readonly headline: string;
  readonly reasons: readonly string[];
  /** Said with every result, pass or fail. */
  readonly notes: readonly string[];
}

export const MOCK_NOTICE =
  "MOCK RUN. No Claude model wrote, played or judged these conversations: stand-ins did. It proves that the harness runs and that the rules the engine enforces in code hold. It says nothing about how the bot treats customers, and it is never compared with or saved as a baseline.";

export function decideVerdict(input: {
  readonly mode: RunMode;
  readonly summary: RunSummary;
  readonly scenarios: readonly ScenarioAggregate[];
  readonly comparison: Comparison | null;
  /** Null: no live baseline has been saved yet. */
  readonly baselineStatus: "compared" | "missing" | "skipped";
  readonly turnRowCounts: Readonly<Record<string, number>>;
  readonly fatal: string | null;
  /** Conversations in which a model other than the one asked for answered (a fallback). */
  readonly servedByOther?: { readonly engine: number; readonly judge: number };
}): Verdict {
  const { mode, summary, scenarios, comparison } = input;
  const reasons: string[] = [];
  const notes: string[] = [];
  if (mode === "mock") notes.push(MOCK_NOTICE);

  const written = Object.entries(input.turnRowCounts).filter(([, rows]) => rows > 0);
  if (written.length > 0) {
    reasons.push(
      `A dry run wrote to the database (${written.map(([table, rows]) => `${table}: ${rows}`).join(", ")}). Dry-run mode must write nothing.`,
    );
  }

  const failing = scenarios.filter((scenario) => !scenario.passed);
  if (failing.length > 0) {
    const shown = failing.slice(0, 8).map((scenario) => scenario.scenarioId);
    reasons.push(
      mode === "live"
        ? `${failing.length} of ${scenarios.length} scenarios did not pass: ${shown.join(", ")}${failing.length > shown.length ? ", ..." : ""}.`
        : `${failing.length} of ${scenarios.length} conversations broke a rule the engine enforces in code: ${shown.join(", ")}${failing.length > shown.length ? ", ..." : ""}.`,
    );
  }
  if (mode === "live" && summary.complianceFailures > 0) {
    reasons.push(`${summary.complianceFailures} setting-compliance failures (the target is zero).`);
  }
  for (const regression of comparison?.regressions ?? []) reasons.push(regression.detail);

  if (mode === "live") {
    if (input.baselineStatus === "missing") {
      notes.push(
        "No live baseline is saved yet, so this run was judged by the pass thresholds alone. Save one from a passing run with `pnpm eval --save-baseline`.",
      );
    }
    notes.push(...(comparison?.notes ?? []));
    const other = input.servedByOther;
    if (other !== undefined && other.engine > 0) {
      notes.push(
        `In ${other.engine} conversations a reply was written by a fallback model after the bot's own model declined (the report names the model per conversation).`,
      );
    }
    if (other !== undefined && other.judge > 0) {
      notes.push(
        `${other.judge} conversations were judged by a fallback model, not the judge that was asked for: their scores are less comparable with the rest.`,
      );
    }
  }

  if (input.fatal !== null || summary.unresolved.length > 0) {
    const errors = Object.entries(summary.errors)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    return {
      ok: false,
      exitCode: 3,
      headline: "INCOMPLETE",
      reasons: [
        input.fatal ??
          `${summary.unresolved.length} conversations could not be played or judged (${errors}). They are not scored; run again with --resume to finish.`,
        ...reasons,
      ],
      notes,
    };
  }
  if (reasons.length > 0) return { ok: false, exitCode: 1, headline: "FAILED", reasons, notes };
  return {
    ok: true,
    exitCode: 0,
    headline: mode === "live" ? "PASSED" : "HARNESS CHECK PASSED",
    reasons: [
      mode === "live"
        ? `All ${scenarios.length} scenarios are at or above the pass thresholds with no setting-compliance failure${comparison === null ? "" : " and no drop against the baseline"}.`
        : `All ${scenarios.length} conversations ran to the end and every rule the engine enforces in code held.`,
    ],
    notes,
  };
}
