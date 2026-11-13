import { CRITERIA, type Criterion } from "../grade/rubric";
import type { RunMode } from "../grade/score";
import { addUsage, NO_USAGE, type Usage } from "../simulate/transcript";
import type { FailureClass } from "./retry";
import { type ErrorRow, type ResultRow, rowKey } from "./store";

/**
 * A run in numbers. Everything here is recomputed from the rows of `results.jsonl` and
 * `errors.jsonl`; nothing is carried along as a running total, so the summary of a resumed
 * run and of a run that went through in one go are the same.
 */

/** One scenario over its repetitions. */
export interface ScenarioAggregate {
  readonly scenarioId: string;
  readonly suite: string;
  readonly persona: string;
  readonly profile: string;
  readonly channel: string;
  readonly reps: number;
  /** Mean over the repetitions that have a score. */
  readonly overall: number | null;
  readonly scores: Readonly<Record<Criterion, number | null>>;
  /** True when every repetition passed. */
  readonly passed: boolean;
  readonly complianceFailures: number;
  /** Ids of everything that failed in any repetition ("check:reply_length", "rule:pricing"). */
  readonly failures: readonly string[];
}

export interface GroupSummary {
  readonly scenarios: number;
  readonly passed: number;
  readonly mean: number | null;
}

export interface RunSummary {
  readonly mode: RunMode;
  readonly conversations: number;
  readonly scenarios: number;
  readonly passed: number;
  readonly failed: number;
  /** Mean overall score of the scenarios, with the half-width of its 95% interval. */
  readonly overall: { readonly mean: number; readonly halfWidth: number | null } | null;
  readonly criteria: Readonly<
    Record<Criterion, { readonly mean: number | null; readonly scenarios: number }>
  >;
  readonly complianceFailures: number;
  readonly failedChecks: readonly {
    readonly id: string;
    readonly title: string;
    readonly conversations: number;
  }[];
  readonly unsupportedClaims: number;
  readonly refusals: number;
  readonly bySuite: Readonly<Record<string, GroupSummary>>;
  readonly byPersona: Readonly<Record<string, GroupSummary>>;
  readonly byProfile: Readonly<Record<string, GroupSummary>>;
  readonly tokens: { readonly engine: Usage; readonly customer: Usage; readonly judge: Usage };
  /** List prices; null when a stand-in answered (nothing was billed). */
  readonly costUsd: {
    readonly engine: number;
    readonly customer: number;
    readonly judge: number;
    readonly total: number;
  } | null;
  readonly replyLatencyMs: { readonly mean: number; readonly max: number } | null;
  readonly retries: number;
  /** Attempts that produced nothing to grade, by cause. */
  readonly errors: Readonly<Partial<Record<FailureClass, number>>>;
  /** Conversations of the selection that still have no result ("scenario#rep"). */
  readonly unresolved: readonly string[];
}

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

const present = (value: number | null): value is number => value !== null;

export function aggregateScenarios(rows: readonly ResultRow[]): ScenarioAggregate[] {
  const byScenario = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byScenario.get(row.scenarioId) ?? [];
    list.push(row);
    byScenario.set(row.scenarioId, list);
  }
  return [...byScenario.entries()].flatMap(([scenarioId, list]) => {
    const [first] = list;
    if (first === undefined) return [];
    const overall = mean(list.map((row) => row.grade.overall).filter(present));
    const scores = Object.fromEntries(
      CRITERIA.map((criterion) => {
        const value = mean(list.map((row) => row.grade.scores[criterion]).filter(present));
        return [criterion, value === null ? null : round(value)];
      }),
    ) as Record<Criterion, number | null>;
    const aggregate: ScenarioAggregate = {
      scenarioId,
      suite: first.suite,
      persona: first.persona,
      profile: first.profile,
      channel: first.channel,
      reps: list.length,
      overall: overall === null ? null : round(overall),
      scores,
      passed: list.every((row) => row.grade.passed),
      complianceFailures: list.reduce((total, row) => total + row.grade.complianceFailures, 0),
      failures: [
        ...new Set(
          list.flatMap((row) => row.grade.failures.map((item) => `${item.kind}:${item.id}`)),
        ),
      ],
    };
    return [aggregate];
  });
}

function group(
  scenarios: readonly ScenarioAggregate[],
  key: (scenario: ScenarioAggregate) => string,
): Record<string, GroupSummary> {
  const groups: Record<string, ScenarioAggregate[]> = {};
  for (const scenario of scenarios) (groups[key(scenario)] ??= []).push(scenario);
  return Object.fromEntries(
    Object.entries(groups).map(([name, list]) => {
      const value = mean(list.map((scenario) => scenario.overall).filter(present));
      return [
        name,
        {
          scenarios: list.length,
          passed: list.filter((scenario) => scenario.passed).length,
          mean: value === null ? null : round(value),
        },
      ];
    }),
  );
}

export function summarizeRun(input: {
  readonly mode: RunMode;
  readonly rows: readonly ResultRow[];
  readonly errors: readonly ErrorRow[];
  /** Every (scenario, rep) the run was asked for. */
  readonly expected: readonly { readonly scenarioId: string; readonly rep: number }[];
}): { readonly summary: RunSummary; readonly scenarios: ScenarioAggregate[] } {
  const { mode, rows, errors, expected } = input;
  const scenarios = aggregateScenarios(rows);
  const overalls = scenarios.map((scenario) => scenario.overall).filter(present);
  const overallMean = mean(overalls);
  let halfWidth: number | null = null;
  if (overallMean !== null && overalls.length >= 2) {
    const variance =
      overalls.reduce((total, value) => total + (value - overallMean) ** 2, 0) /
      (overalls.length - 1);
    halfWidth = round((1.96 * Math.sqrt(variance)) / Math.sqrt(overalls.length));
  }

  const failedChecks = new Map<string, { title: string; conversations: number }>();
  for (const row of rows) {
    const gating = new Set(
      row.grade.failures.filter((item) => item.kind === "check").map((item) => item.id),
    );
    for (const check of row.checks) {
      if (!gating.has(check.id)) continue;
      const entry = failedChecks.get(check.id) ?? { title: check.title, conversations: 0 };
      entry.conversations += 1;
      failedChecks.set(check.id, entry);
    }
  }

  const done = new Set(rows.map((row) => rowKey(row.scenarioId, row.rep)));
  const errorCounts: Partial<Record<FailureClass, number>> = {};
  for (const error of errors) errorCounts[error.class] = (errorCounts[error.class] ?? 0) + 1;

  const sum = (pick: (row: ResultRow) => Usage) =>
    rows.reduce((total, row) => addUsage(total, pick(row)), NO_USAGE);
  const cost = (pick: (row: ResultRow) => number | null): number | null => {
    let total = 0;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  const engineCost = cost((row) => row.costUsd.engine);
  const customerCost = cost((row) => row.costUsd.customer);
  const judgeCost = cost((row) => row.costUsd.judge);
  const latencies = rows.filter((row) => row.botMessages > 0);

  const summary: RunSummary = {
    mode,
    conversations: rows.length,
    scenarios: scenarios.length,
    passed: scenarios.filter((scenario) => scenario.passed).length,
    failed: scenarios.filter((scenario) => !scenario.passed).length,
    overall: overallMean === null ? null : { mean: round(overallMean), halfWidth },
    criteria: Object.fromEntries(
      CRITERIA.map((criterion) => {
        const values = scenarios.map((scenario) => scenario.scores[criterion]).filter(present);
        const value = mean(values);
        return [
          criterion,
          { mean: value === null ? null : round(value), scenarios: values.length },
        ];
      }),
    ) as RunSummary["criteria"],
    complianceFailures: rows.reduce((total, row) => total + row.grade.complianceFailures, 0),
    failedChecks: [...failedChecks.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => b.conversations - a.conversations || a.id.localeCompare(b.id)),
    unsupportedClaims: rows.reduce((total, row) => total + row.judge.claims.length, 0),
    refusals: rows.filter((row) => row.refused).length,
    bySuite: group(scenarios, (scenario) => scenario.suite),
    byPersona: group(scenarios, (scenario) => scenario.persona),
    byProfile: group(scenarios, (scenario) => scenario.profile),
    tokens: {
      engine: sum((row) => row.usage.engine),
      customer: sum((row) => row.usage.customer),
      judge: sum((row) => row.usage.judge),
    },
    costUsd:
      engineCost === null || customerCost === null || judgeCost === null || rows.length === 0
        ? null
        : {
            engine: round(engineCost, 4),
            customer: round(customerCost, 4),
            judge: round(judgeCost, 4),
            total: round(engineCost + customerCost + judgeCost, 4),
          },
    replyLatencyMs:
      latencies.length === 0
        ? null
        : {
            mean: Math.round(mean(latencies.map((row) => row.replyLatencyMs.mean)) ?? 0),
            max: Math.max(...latencies.map((row) => row.replyLatencyMs.max)),
          },
    retries: rows.reduce((total, row) => total + row.retries, 0),
    errors: errorCounts,
    unresolved: expected
      .map((item) => rowKey(item.scenarioId, item.rep))
      .filter((key) => !done.has(key)),
  };
  return { summary, scenarios };
}
