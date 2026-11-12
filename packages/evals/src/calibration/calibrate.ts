import type { TraceContext, TraceId } from "@repo/core";

import { runChecks } from "../grade/checks";
import type { Judge, JudgeResult } from "../grade/judge";
import { CRITERIA } from "../grade/rubric";
import { failureMessage, type RetryOptions, withRetries } from "../run/retry";
import { type ExpectedFinding, type JudgeProbe, judgeProbes } from "./probes";

/**
 * Runs the judge over the hand-made probes and says where its verdict is what a person
 * would give. This is the check that makes a judge-graded score worth acting on.
 */

export interface ProbeResult {
  readonly id: string;
  readonly title: string;
  readonly agreed: boolean;
  /** What the judge got wrong, in words. Empty when it agreed. */
  readonly problems: readonly string[];
  /** What the judge said, for the reader. */
  readonly said: string;
  readonly error: string | null;
}

export interface CalibrationResult {
  readonly probes: readonly ProbeResult[];
  readonly agreed: number;
  readonly total: number;
}

function has(verdict: JudgeResult, finding: ExpectedFinding): boolean {
  if ("claim" in finding) return verdict.claims.some((claim) => claim.kind === finding.claim);
  if ("rule" in finding) return verdict.violations.some((item) => item.rule === finding.rule);
  const score = verdict.criteria[finding.criterion].score;
  return score !== null && score <= finding.atMost;
}

function words(finding: ExpectedFinding): string {
  if ("claim" in finding) return `an unsupported ${finding.claim.replaceAll("_", " ")} claim`;
  if ("rule" in finding) return `a violation of the ${finding.rule} rule`;
  return `${finding.criterion.replaceAll("_", " ")} at ${finding.atMost} or lower`;
}

/** Compares one verdict with what the probe expects. */
export function probeProblems(probe: JudgeProbe, verdict: JudgeResult): string[] {
  const problems: string[] = [];
  if (probe.expect === "clean") {
    for (const violation of verdict.violations) {
      problems.push(`reported a violation of the ${violation.rule} rule in a clean conversation`);
    }
    for (const claim of verdict.claims) {
      problems.push(`reported an unsupported claim ("${claim.quote}") in a clean conversation`);
    }
    for (const criterion of CRITERIA) {
      const score = verdict.criteria[criterion].score;
      if (score !== null && score < 4) {
        problems.push(`scored ${criterion.replaceAll("_", " ")} ${score} in a clean conversation`);
      }
    }
    return problems;
  }
  for (const group of probe.expect) {
    if (!group.some((finding) => has(verdict, finding))) {
      problems.push(`did not report ${group.map(words).join(", or ")}`);
    }
  }
  return problems;
}

function saying(verdict: JudgeResult): string {
  const scores = CRITERIA.map(
    (criterion) =>
      `${criterion.replaceAll("_", " ")} ${verdict.criteria[criterion].score ?? "n/a"}`,
  ).join(", ");
  const findings = [
    ...verdict.violations.map((item) => `rule ${item.rule}`),
    ...verdict.claims.map((item) => `claim ${item.kind}`),
  ];
  return `${scores}${findings.length === 0 ? "; no findings" : `; findings: ${findings.join(", ")}`}`;
}

export async function calibrateJudge(options: {
  readonly judge: Judge;
  readonly probes?: readonly JudgeProbe[];
  readonly retry?: RetryOptions;
  readonly onProbe?: (result: ProbeResult) => void;
}): Promise<CalibrationResult> {
  const probes = options.probes ?? judgeProbes();
  const trace: TraceContext = {
    traceId: "00000000-0000-4000-8e00-000000000002" as TraceId,
    agencyId: "00000000-0000-4000-8e00-0000000000a1" as TraceContext["agencyId"],
    businessId: "00000000-0000-4000-8e00-0000000000b1" as TraceContext["businessId"],
    conversationId: null,
  };
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    let result: ProbeResult;
    try {
      const { value: verdict } = await withRetries(
        () =>
          options.judge.judge({
            scenario: probe.scenario,
            transcript: probe.transcript,
            checks: runChecks(probe.scenario, probe.transcript),
            trace,
          }),
        options.retry,
      );
      const problems = probeProblems(probe, verdict);
      result = {
        id: probe.id,
        title: probe.title,
        agreed: problems.length === 0,
        problems,
        said: saying(verdict),
        error: null,
      };
    } catch (error) {
      result = {
        id: probe.id,
        title: probe.title,
        agreed: false,
        problems: ["the judge returned no verdict"],
        said: "",
        error: failureMessage(error),
      };
    }
    results.push(result);
    options.onProbe?.(result);
  }
  return {
    probes: results,
    agreed: results.filter((result) => result.agreed).length,
    total: results.length,
  };
}
