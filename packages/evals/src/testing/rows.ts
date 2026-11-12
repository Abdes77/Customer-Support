import type { CheckResult } from "../grade/checks";
import { CRITERIA, type Criterion } from "../grade/rubric";
import type { GradeFailure, RunMode } from "../grade/score";
import type { ResultRow } from "../run/store";
import { NO_USAGE } from "../simulate/transcript";

/** A result row with the given scores, for the tests of summaries, baselines and reports. */
export function rowWith(
  scenarioId: string,
  options: {
    readonly mode?: RunMode;
    readonly rep?: number;
    /** One number for every criterion, or a score per criterion. Null: not judged. */
    readonly scores?: number | null | Partial<Record<Criterion, number | null>>;
    readonly failures?: readonly GradeFailure[];
    readonly complianceFailures?: number;
    readonly checks?: readonly CheckResult[];
    readonly costUsd?: number | null;
  } = {},
): ResultRow {
  const [suite = "roofing", persona = "ready_to_book"] = scenarioId.split(".");
  const given = options.scores === undefined ? 5 : options.scores;
  const scores = Object.fromEntries(
    CRITERIA.map((criterion) => [
      criterion,
      given === null || typeof given === "number"
        ? given
        : criterion in given
          ? (given[criterion] ?? null)
          : 5,
    ]),
  ) as Record<Criterion, number | null>;
  const applicable = Object.values(scores).filter((score): score is number => score !== null);
  const overall =
    applicable.length === 0
      ? null
      : Math.round((applicable.reduce((a, b) => a + b, 0) / applicable.length) * 100) / 100;
  const failures = options.failures ?? [];
  const cost = options.costUsd === undefined ? 0.4 : options.costUsd;
  return {
    scenarioId,
    suite,
    persona,
    profile: "default",
    channel: "whatsapp",
    rep: options.rep ?? 0,
    grade: {
      mode: options.mode ?? "live",
      scores,
      overall,
      failures,
      complianceFailures: options.complianceFailures ?? 0,
      passed: failures.length === 0,
    },
    checks: options.checks ?? [],
    judge: {
      model: "claude-opus-5-5",
      standIn: options.mode === "mock",
      scores,
      reasons: Object.fromEntries(CRITERIA.map((criterion) => [criterion, "Reason."])) as Record<
        Criterion,
        string
      >,
      rules: [],
      violations: [],
      claims: [],
      discarded: [],
      summary: "Summary.",
    },
    ended: "customer_left",
    leaveReason: "satisfied",
    customerTurns: 4,
    botMessages: 4,
    lead: { status: "qualified", routing: "book_meeting", score: 88, fields: ["service_type"] },
    expectedRouting: ["book_meeting"],
    refused: false,
    usage: { engine: NO_USAGE, customer: NO_USAGE, judge: NO_USAGE },
    costUsd: {
      engine: cost,
      customer: cost === null ? null : 0.05,
      judge: cost === null ? null : 0.1,
    },
    models: {
      engine: ["claude-fable-5-2"],
      customer: ["claude-opus-5-5"],
      judge: "claude-opus-5-5",
    },
    replyLatencyMs: { mean: 9000, max: 14_000 },
    retries: 0,
    durationMs: 60_000,
    promptVersion: "reply-v1.r2",
    transcriptFile: `transcripts/${scenarioId}.rep${options.rep ?? 0}.json`,
  };
}
