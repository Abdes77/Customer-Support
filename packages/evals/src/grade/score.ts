import type { CheckResult } from "./checks";
import type { JudgeResult } from "./judge";
import { CRITERIA, type Criterion, type Thresholds } from "./rubric";

/**
 * From the checks and the judge's verdict of one conversation to its grade: a score per
 * criterion, an overall score, and whether the conversation passes.
 *
 * Two kinds of run are graded differently, on purpose:
 * - "live": the Claude API wrote the replies, played the customer and judged. Everything
 *   counts.
 * - "mock": stand-ins did. There are no scores (a stand-in judge evaluates nothing), and
 *   the only thing that can fail a conversation is a rule the engine enforces in code,
 *   because that is the only part of the product a mock run really exercises.
 */

export type RunMode = "live" | "mock";

export interface GradeFailure {
  /** score: below the pass score. floor: one criterion too low. check, rule, claim: evidence. */
  readonly kind: "score" | "floor" | "check" | "rule" | "claim";
  readonly id: string;
  readonly criterion: Criterion | null;
  readonly detail: string;
}

export interface ScenarioGrade {
  readonly mode: RunMode;
  /** 1 to 5; null when the criterion does not apply, or when nothing judged it (mock). */
  readonly scores: Readonly<Record<Criterion, number | null>>;
  /** The mean of the applicable criteria; null when there is none. */
  readonly overall: number | null;
  readonly failures: readonly GradeFailure[];
  /** Failed setting-compliance checks plus rule violations the judge evidenced. */
  readonly complianceFailures: number;
  readonly passed: boolean;
}

/** A criterion with evidence against it cannot score higher than this. */
const CAP_FAILED_CHECK = 2;
const CAP_RULE_VIOLATION = 3;
const CAP_INVENTED_CLAIM = 2;

const isCriterion = (group: string): group is Criterion =>
  (CRITERIA as readonly string[]).includes(group);

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function gradeConversation(input: {
  readonly mode: RunMode;
  readonly checks: readonly CheckResult[];
  readonly judge: JudgeResult;
  readonly thresholds: Thresholds;
}): ScenarioGrade {
  const { mode, checks, judge, thresholds } = input;
  if (mode === "live" && judge.standIn) {
    // A stand-in verdict has no scores; in a live run it would pass on checks alone.
    throw new Error("A live run cannot be graded by the stand-in judge.");
  }
  const judged = mode === "live";
  const failures: GradeFailure[] = [];

  const gating = checks.filter((check) => mode === "live" || check.guarantee === "code");
  const failedChecks = gating.filter((check) => !check.passed);
  for (const check of failedChecks) {
    failures.push({
      kind: "check",
      id: check.id,
      criterion: isCriterion(check.group) ? check.group : null,
      detail: `${check.title}. Found: ${check.detail ?? "it does not hold"}.`,
    });
  }
  let complianceFailures = failedChecks.filter(
    (check) => check.group === "setting_compliance",
  ).length;

  const scores = Object.fromEntries(CRITERIA.map((criterion) => [criterion, null])) as Record<
    Criterion,
    number | null
  >;
  if (judged) {
    for (const criterion of CRITERIA) scores[criterion] = judge.criteria[criterion].score;
    const cap = (criterion: Criterion, limit: number) => {
      scores[criterion] = Math.min(scores[criterion] ?? limit, limit);
    };
    for (const check of failedChecks) {
      if (isCriterion(check.group)) cap(check.group, CAP_FAILED_CHECK);
    }
    for (const violation of judge.violations) {
      complianceFailures += 1;
      cap("setting_compliance", CAP_RULE_VIOLATION);
      failures.push({
        kind: "rule",
        id: violation.rule,
        criterion: "setting_compliance",
        detail: `Rule "${violation.rule}" was not followed: ${violation.explanation}${
          violation.quote === null ? "" : ` ("${violation.quote}")`
        }`,
      });
    }
    for (const claim of judge.claims) {
      cap("accuracy", CAP_INVENTED_CLAIM);
      failures.push({
        kind: "claim",
        id: claim.kind,
        criterion: "accuracy",
        detail: `Stated without support (${claim.kind.replaceAll("_", " ")}): "${claim.quote}". ${claim.explanation}`,
      });
    }
    for (const criterion of CRITERIA) {
      const score = scores[criterion];
      const floor = thresholds.floors[criterion];
      // A criterion that evidence already failed is listed once, by its evidence.
      const explained = failures.some((failure) => failure.criterion === criterion);
      if (score !== null && score < floor && !explained) {
        failures.push({
          kind: "floor",
          id: criterion,
          criterion,
          detail: `${criterion.replaceAll("_", " ")} scored ${score}, below its floor of ${floor}: ${judge.criteria[criterion].reason}`,
        });
      }
    }
  }

  const applicable = CRITERIA.map((criterion) => scores[criterion]).filter(
    (score): score is number => score !== null,
  );
  const overall =
    applicable.length === 0
      ? null
      : round(applicable.reduce((total, score) => total + score, 0) / applicable.length);
  if (judged && overall !== null && overall < thresholds.passScore) {
    failures.push({
      kind: "score",
      id: "overall",
      criterion: null,
      detail: `Overall ${overall.toFixed(2)}, below the pass score of ${thresholds.passScore}.`,
    });
  }

  return {
    mode,
    scores,
    overall,
    failures,
    complianceFailures,
    passed: failures.length === 0,
  };
}
