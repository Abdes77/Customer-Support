import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { CRITERIA, type Criterion, type Thresholds } from "../grade/rubric";
import type { RunManifest } from "./store";
import type { RunSummary, ScenarioAggregate } from "./summary";

/**
 * The saved baseline: the scores of one live run that later runs are compared with.
 *
 * A baseline is a statement about reply quality, so it can only come from a run in which
 * the Claude API wrote the replies and judged them. A mock run has no scores to save, and a
 * file that claims otherwise is refused when it is read: a baseline recorded against
 * stand-ins must never be mistaken for a measurement.
 */

export const BASELINE_FILE = "live.json";

const Score = z.number().min(1).max(5).nullable();
const Scores = z.object(
  Object.fromEntries(CRITERIA.map((criterion) => [criterion, Score])) as Record<
    Criterion,
    typeof Score
  >,
);

export const Baseline = z.object({
  version: z.literal(1),
  /** Always "live". The field exists so that anything else can be refused. */
  mode: z.literal("live"),
  savedAt: z.string(),
  runId: z.string(),
  promptVersion: z.string(),
  models: z.object({ engine: z.string(), customer: z.string(), judge: z.string() }),
  overall: z.number().min(1).max(5),
  criteria: Scores,
  scenarios: z.record(
    z.string(),
    z.object({ overall: Score, passed: z.boolean(), scores: Scores }),
  ),
});
export type Baseline = z.infer<typeof Baseline>;

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineError";
  }
}

/** A baseline from a finished run. Refuses anything that is not a complete live run. */
export function baselineFrom(input: {
  readonly manifest: RunManifest;
  readonly summary: RunSummary;
  readonly scenarios: readonly ScenarioAggregate[];
  readonly promptVersion: string;
  readonly now: Date;
}): Baseline {
  const { manifest, summary, scenarios } = input;
  if (manifest.mode !== "live" || summary.mode !== "live") {
    throw new BaselineError(
      "A baseline can only be saved from a live run. This run used stand-ins for the models, so it has no scores: it says nothing about reply quality.",
    );
  }
  if (summary.unresolved.length > 0) {
    throw new BaselineError(
      `The run is incomplete: ${summary.unresolved.length} conversations have no result. Finish it with --resume before saving a baseline.`,
    );
  }
  if (summary.overall === null) {
    throw new BaselineError("The run has no scores to save.");
  }
  return {
    version: 1,
    mode: "live",
    savedAt: input.now.toISOString(),
    runId: manifest.id,
    promptVersion: input.promptVersion,
    models: manifest.models,
    overall: summary.overall.mean,
    criteria: Object.fromEntries(
      CRITERIA.map((criterion) => [criterion, summary.criteria[criterion].mean]),
    ) as Baseline["criteria"],
    scenarios: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.scenarioId,
        { overall: scenario.overall, passed: scenario.passed, scores: scenario.scores },
      ]),
    ),
  };
}

export async function saveBaseline(file: string, baseline: Baseline): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(Baseline.parse(baseline), null, 2)}\n`);
}

/** The baseline in `file`, or null when there is none. A file that is not a live baseline throws. */
export async function loadBaseline(file: string): Promise<Baseline | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BaselineError(`${file} is not valid JSON.`);
  }
  if ((raw as { mode?: unknown } | null)?.mode !== "live") {
    throw new BaselineError(
      `${file} was not recorded against the Claude API (its mode is not "live"). It cannot be used as a baseline.`,
    );
  }
  const parsed = Baseline.safeParse(raw);
  if (!parsed.success) {
    throw new BaselineError(
      `${file} is not a baseline this version understands: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}.`,
    );
  }
  return parsed.data;
}

export interface Regression {
  readonly kind: "overall" | "criterion" | "scenario" | "newly_failing";
  readonly id: string;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly detail: string;
}

export interface Comparison {
  readonly baselineRunId: string;
  readonly baselineSavedAt: string;
  /** Scenarios present in both. Means are compared over these only. */
  readonly compared: number;
  readonly overall: { readonly baseline: number; readonly current: number } | null;
  readonly criteria: Readonly<
    Record<Criterion, { readonly baseline: number | null; readonly current: number | null }>
  >;
  readonly regressions: readonly Regression[];
  /** Things that make the two runs less comparable (another judge, another prompt). */
  readonly notes: readonly string[];
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
const present = (value: number | null): value is number => value !== null;
const fmt = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));

/**
 * Compares a live run with the baseline, over the scenarios both have. A drop beyond a
 * threshold is a regression; so is a scenario that passed in the baseline and fails now.
 */
export function compareWithBaseline(input: {
  readonly baseline: Baseline;
  readonly scenarios: readonly ScenarioAggregate[];
  readonly manifest: Pick<RunManifest, "models">;
  readonly promptVersion: string;
  readonly thresholds: Thresholds;
}): Comparison {
  const { baseline, scenarios, thresholds } = input;
  const common = scenarios.filter(
    (scenario) => baseline.scenarios[scenario.scenarioId] !== undefined,
  );
  const regressions: Regression[] = [];

  // Means are taken over the same scenarios on both sides: a scenario scored in only one of
  // the two runs would move one mean and not the other.
  const pairs = (
    pick: (scores: {
      readonly overall: number | null;
      readonly scores: Readonly<Record<Criterion, number | null>>;
    }) => number | null,
  ) => {
    const was: number[] = [];
    const now: number[] = [];
    for (const scenario of common) {
      const saved = baseline.scenarios[scenario.scenarioId];
      const before = saved === undefined ? null : pick(saved);
      const after = pick(scenario);
      if (present(before) && present(after)) {
        was.push(before);
        now.push(after);
      }
    }
    return { was: mean(was), now: mean(now) };
  };
  const { was: baselineOverall, now: currentOverall } = pairs((item) => item.overall);
  if (
    baselineOverall !== null &&
    currentOverall !== null &&
    baselineOverall - currentOverall > thresholds.maxOverallDrop
  ) {
    regressions.push({
      kind: "overall",
      id: "overall",
      baseline: baselineOverall,
      current: currentOverall,
      detail: `The mean overall score fell from ${fmt(baselineOverall)} to ${fmt(currentOverall)} (allowed: ${thresholds.maxOverallDrop}).`,
    });
  }

  const criteria = {} as Record<Criterion, { baseline: number | null; current: number | null }>;
  for (const criterion of CRITERIA) {
    const { was, now } = pairs((item) => item.scores[criterion]);
    criteria[criterion] = { baseline: was, current: now };
    if (was !== null && now !== null && was - now > thresholds.maxCriterionDrop) {
      regressions.push({
        kind: "criterion",
        id: criterion,
        baseline: was,
        current: now,
        detail: `${criterion.replaceAll("_", " ")} fell from ${fmt(was)} to ${fmt(now)} (allowed: ${thresholds.maxCriterionDrop}).`,
      });
    }
  }

  for (const scenario of common) {
    const was = baseline.scenarios[scenario.scenarioId];
    if (was === undefined) continue;
    if (
      was.overall !== null &&
      scenario.overall !== null &&
      was.overall - scenario.overall > thresholds.maxScenarioDrop
    ) {
      regressions.push({
        kind: "scenario",
        id: scenario.scenarioId,
        baseline: was.overall,
        current: scenario.overall,
        detail: `${scenario.scenarioId} fell from ${fmt(was.overall)} to ${fmt(scenario.overall)} (allowed: ${thresholds.maxScenarioDrop}).`,
      });
    } else if (was.passed && !scenario.passed) {
      regressions.push({
        kind: "newly_failing",
        id: scenario.scenarioId,
        baseline: was.overall,
        current: scenario.overall,
        detail: `${scenario.scenarioId} passed in the baseline and fails now.`,
      });
    }
  }

  const notes: string[] = [];
  if (common.length < scenarios.length) {
    notes.push(
      `${scenarios.length - common.length} scenarios of this run are not in the baseline and were not compared.`,
    );
  }
  if (baseline.models.judge !== input.manifest.models.judge) {
    notes.push(
      `The baseline was judged by ${baseline.models.judge}, this run by ${input.manifest.models.judge}: scores from different judges are not strictly comparable.`,
    );
  }
  if (baseline.models.customer !== input.manifest.models.customer) {
    notes.push(
      `The customers were played by ${baseline.models.customer} in the baseline and by ${input.manifest.models.customer} in this run.`,
    );
  }
  if (baseline.promptVersion !== input.promptVersion) {
    notes.push(
      `Prompt version: ${baseline.promptVersion} in the baseline, ${input.promptVersion} in this run.`,
    );
  }

  return {
    baselineRunId: baseline.runId,
    baselineSavedAt: baseline.savedAt,
    compared: common.length,
    overall:
      baselineOverall === null || currentOverall === null
        ? null
        : { baseline: baselineOverall, current: currentOverall },
    criteria,
    regressions,
    notes,
  };
}
