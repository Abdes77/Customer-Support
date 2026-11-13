import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { createLogger, type LogRecord } from "@repo/core";
import { EFFORT_LEVELS, type EffortLevel } from "@repo/settings";

import { calibrateJudge } from "./calibration/calibrate";
import { createJudge } from "./grade/judge";
import { DEFAULT_THRESHOLDS, MAX_SCORE, type Thresholds } from "./grade/rubric";
import type { RunMode } from "./grade/score";
import { renderReport } from "./report/html";
import { renderSummaryMarkdown } from "./report/markdown";
import {
  BASELINE_FILE,
  type Baseline,
  BaselineError,
  baselineFrom,
  compareWithBaseline,
  type Comparison,
  loadBaseline,
  saveBaseline,
} from "./run/baseline";
import { liveModels, mockModels } from "./run/models";
import {
  type ProgressEvent,
  runEvaluation,
  type RunEvaluationOptions,
  type RunEvaluationResult,
} from "./run/runner";
import { createRunStore, rowKey, type RunManifest, type TranscriptFile } from "./run/store";
import { summarizeRun } from "./run/summary";
import { decideVerdict } from "./run/verdict";
import { allScenarios, selectScenarios } from "./scenarios/matrix";

/**
 * `pnpm eval`: plays the evaluation suite, writes the results and the report, compares a
 * live run with the saved baseline and returns the exit code CI acts on.
 */

export const USAGE = `Usage: pnpm eval [options]

Plays simulated customers against the reply bot (dry run: nothing is sent, nothing is
stored) and grades the conversations.

Which run
  --mode live|mock      live: the Claude API writes the replies, plays the customers and
                        judges (needs ANTHROPIC_API_KEY). mock: stand-ins do; it checks the
                        harness and the rules the engine enforces in code, not reply quality.
                        Default: live when the key is set, otherwise mock.

Which scenarios (default: all 72)
  --suite <trade>       roofing, hvac, plumbing, electrical, remodeling, pest_control
  --persona <id>        ready_to_book, price_shopper, tire_kicker, renter, out_of_area,
                        emergency, angry_past_job, one_word, spam, prompt_injection,
                        broken_english, silent_returner
  --profile <id>        default, booking_with_ranges, contact_only, transparent_pricing, strict
  --scenario <id>       for example roofing.ready_to_book
  --core                the 24-scenario core selection (two trades per persona)
  --limit <n>           the first n of the selection
  --list                list the selected scenarios and stop
                        (the selecting options can be repeated or take a,b,c)

How
  --reps <n>            play every scenario n times (default 1)
  --concurrency <n>     conversations in flight at once (default 6)
  --timeout-s <n>       ceiling for one conversation with its judging (default 900)
  --max-turns <n>       cap the customer turns of every conversation
  --customer-model <id> --customer-effort <level>
  --judge-model <id>    --judge-effort <level>
  --no-strict           for organizations where strict tools are not available

Checking the judge
  --calibrate-judge     run the judge over eight hand-made conversations with known faults
                        and report where its verdict is the expected one (live only). Do
                        this before trusting the first live run, and after changing the
                        judge model or the rubric.

Results and baseline
  --out <dir>           where to write (default evals-output/<run id>)
  --resume <dir>        continue a run: play only what has no result yet
  --baseline <file>     the baseline to compare a live run with
                        (default packages/evals/baseline/live.json)
  --no-compare          do not compare with the baseline
  --save-baseline       save this live run as the baseline (only when it passed)
  --force               with --save-baseline: save even though the run did not pass

Exit codes: 0 passed, 1 failed, 2 usage or configuration, 3 incomplete.`;

export interface CliDeps {
  readonly print: (line: string) => void;
  /** From the environment (`getEnv()`), read by the script, not here. */
  readonly apiKey: string | undefined;
  readonly baseUrl?: string | undefined;
  /** The repository root: results go to <root>/evals-output, the baseline lives in the package. */
  readonly repoRoot: string;
  readonly now?: () => Date;
  /** Tests replace parts of the run (the sandbox, the models, retry waits). */
  readonly overrides?: Partial<RunEvaluationOptions>;
}

interface Options {
  mode: RunMode | null;
  suites: string[];
  personas: string[];
  profiles: string[];
  scenarios: string[];
  core: boolean;
  limit: number | undefined;
  list: boolean;
  help: boolean;
  calibrate: boolean;
  reps: number;
  concurrency: number;
  timeoutS: number;
  maxTurns: number | undefined;
  out: string | undefined;
  resume: string | undefined;
  baseline: string | undefined;
  compare: boolean;
  saveBaseline: boolean;
  force: boolean;
  strict: boolean;
  customerModel: string | undefined;
  customerEffort: EffortLevel | undefined;
  judgeModel: string | undefined;
  judgeEffort: EffortLevel | undefined;
}

export class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    mode: null,
    suites: [],
    personas: [],
    profiles: [],
    scenarios: [],
    core: false,
    limit: undefined,
    list: false,
    help: false,
    calibrate: false,
    reps: 1,
    concurrency: 6,
    timeoutS: 900,
    maxTurns: undefined,
    out: undefined,
    resume: undefined,
    baseline: undefined,
    compare: true,
    saveBaseline: false,
    force: false,
    strict: true,
    customerModel: undefined,
    customerEffort: undefined,
    judgeModel: undefined,
    judgeEffort: undefined,
  };
  const args = [...argv];
  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value.`);
    return next;
  };
  const list = (flag: string) =>
    value(flag)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  const whole = (flag: string, min: number): number => {
    const number = Number(value(flag));
    if (!Number.isInteger(number) || number < min) {
      throw new UsageError(`${flag} needs a whole number of at least ${min}.`);
    }
    return number;
  };
  const effort = (flag: string): EffortLevel => {
    const level = value(flag);
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      throw new UsageError(`${flag} is one of: ${EFFORT_LEVELS.join(", ")}.`);
    }
    return level as EffortLevel;
  };
  for (let flag = args.shift(); flag !== undefined; flag = args.shift()) {
    switch (flag) {
      case "--":
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--mode": {
        const mode = value(flag);
        if (mode !== "live" && mode !== "mock") throw new UsageError("--mode is live or mock.");
        options.mode = mode;
        break;
      }
      case "--suite":
        options.suites.push(...list(flag));
        break;
      case "--persona":
        options.personas.push(...list(flag));
        break;
      case "--profile":
        options.profiles.push(...list(flag));
        break;
      case "--scenario":
        options.scenarios.push(...list(flag));
        break;
      case "--core":
        options.core = true;
        break;
      case "--limit":
        options.limit = whole(flag, 1);
        break;
      case "--list":
        options.list = true;
        break;
      case "--calibrate-judge":
        options.calibrate = true;
        break;
      case "--reps":
        options.reps = whole(flag, 1);
        break;
      case "--concurrency":
        options.concurrency = whole(flag, 1);
        break;
      case "--timeout-s":
        options.timeoutS = whole(flag, 1);
        break;
      case "--max-turns":
        options.maxTurns = whole(flag, 1);
        break;
      case "--out":
        options.out = value(flag);
        break;
      case "--resume":
        options.resume = value(flag);
        break;
      case "--baseline":
        options.baseline = value(flag);
        break;
      case "--no-compare":
        options.compare = false;
        break;
      case "--save-baseline":
        options.saveBaseline = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--no-strict":
        options.strict = false;
        break;
      case "--customer-model":
        options.customerModel = value(flag);
        break;
      case "--customer-effort":
        options.customerEffort = effort(flag);
        break;
      case "--judge-model":
        options.judgeModel = value(flag);
        break;
      case "--judge-effort":
        options.judgeEffort = effort(flag);
        break;
      default:
        throw new UsageError(`Unknown option ${flag}. Try --help.`);
    }
  }
  return options;
}

function runId(now: Date, mode: RunMode): string {
  const stamp = now.toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${mode}`;
}

function describeSelection(options: Options, count: number): string {
  const parts = [
    options.core ? "core selection" : null,
    options.suites.length > 0 ? `suite ${options.suites.join(", ")}` : null,
    options.personas.length > 0 ? `persona ${options.personas.join(", ")}` : null,
    options.profiles.length > 0 ? `profile ${options.profiles.join(", ")}` : null,
    options.scenarios.length > 0 ? `scenario ${options.scenarios.join(", ")}` : null,
    options.limit === undefined ? null : `first ${options.limit}`,
  ].filter((part) => part !== null);
  const total = allScenarios().length;
  return parts.length === 0
    ? `all ${count} scenarios`
    : `${count} of ${total} scenarios (${parts.join("; ")})`;
}

function progressLine(event: ProgressEvent): string {
  const counter = `[${String(event.done).padStart(String(event.total).length)}/${event.total}]`;
  if (event.kind === "error") {
    return `${counter} ${event.scenarioId.padEnd(30)} NOT PLAYED (${event.class}): ${event.message}`;
  }
  const { row } = event;
  const cost =
    row.costUsd.engine === null
      ? ""
      : `, $${((row.costUsd.engine ?? 0) + (row.costUsd.customer ?? 0) + (row.costUsd.judge ?? 0)).toFixed(2)}`;
  const result = row.grade.passed
    ? row.grade.overall === null
      ? "ok"
      : `PASS ${row.grade.overall.toFixed(2)}`
    : `FAIL${row.grade.overall === null ? "" : ` ${row.grade.overall.toFixed(2)}`} (${row.grade.failures
        .slice(0, 3)
        .map((failure) => `${failure.kind}:${failure.id}`)
        .join(", ")})`;
  return `${counter} ${row.scenarioId.padEnd(30)} ${result}  ${row.customerTurns} turns, ${(row.durationMs / 1000).toFixed(1)} s${cost}`;
}

/** Runs the command. Returns the exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { print } = deps;
  const now = deps.now ?? (() => new Date());
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    print(error instanceof UsageError ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    print(USAGE);
    return 0;
  }

  let scenarios;
  try {
    scenarios = selectScenarios({
      suites: options.suites,
      personas: options.personas,
      profiles: options.profiles,
      scenarios: options.scenarios,
      core: options.core,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (scenarios.length === 0) {
    print("No scenario matches this selection.");
    return 2;
  }
  if (options.list) {
    for (const scenario of scenarios) {
      const expected = scenario.expect.routing;
      print(
        `${scenario.id.padEnd(30)} ${scenario.profile.id.padEnd(20)} ${scenario.channel.padEnd(10)} ${scenario.core ? "core" : "    "} ${
          expected === undefined
            ? ""
            : `routing: ${expected.map((item) => item ?? "none").join(" | ")}`
        }`,
      );
    }
    print(`${scenarios.length} scenarios.`);
    return 0;
  }

  const mode: RunMode = options.mode ?? (deps.apiKey === undefined ? "mock" : "live");
  if (mode === "live" && deps.apiKey === undefined) {
    print(
      "A live run needs ANTHROPIC_API_KEY (docs/HUMAN_TODO.md, step 4). Without a key, run `pnpm eval --mode mock`.",
    );
    return 2;
  }
  if (options.saveBaseline && mode !== "live") {
    print(
      "A baseline can only be saved from a live run: a mock run has no scores and says nothing about reply quality.",
    );
    return 2;
  }
  const models =
    deps.overrides?.models ??
    (mode === "live"
      ? liveModels(
          { apiKey: deps.apiKey, baseUrl: deps.baseUrl },
          {
            ...(options.customerModel === undefined
              ? {}
              : { customerModel: options.customerModel }),
            ...(options.customerEffort === undefined
              ? {}
              : { customerEffort: options.customerEffort }),
            ...(options.judgeModel === undefined ? {} : { judgeModel: options.judgeModel }),
            ...(options.judgeEffort === undefined ? {} : { judgeEffort: options.judgeEffort }),
          },
        )
      : mockModels());
  if (models.mode !== mode) {
    // The runner grades by the models' mode, the summary by the run's: they must agree.
    print(`The models are set up for a ${models.mode} run, not a ${mode} run.`);
    return 2;
  }
  const thresholds: Thresholds = DEFAULT_THRESHOLDS;

  if (options.calibrate) {
    if (mode !== "live") {
      print(
        "Calibrating the judge needs the Claude API: a stand-in judge evaluates nothing. Set ANTHROPIC_API_KEY (docs/HUMAN_TODO.md, step 4).",
      );
      return 2;
    }
    print(
      `Calibrating the judge (${models.judge.model}) on hand-made conversations with known faults.`,
    );
    const calibration = await calibrateJudge({
      judge: createJudge({
        ...models.judge,
        logger: createLogger({ level: "error", sink: () => undefined }),
        strictTools: options.strict,
      }),
      ...(deps.overrides?.retry === undefined ? {} : { retry: deps.overrides.retry }),
      onProbe: (probe) => {
        print(
          `${probe.agreed ? "agrees   " : "DISAGREES"} ${probe.id.padEnd(30)} ${probe.title}${
            probe.agreed ? "" : `\n            The judge ${probe.problems.join("; ")}.`
          }${probe.error === null ? "" : `\n            ${probe.error}`}${
            probe.said.length === 0 ? "" : `\n            It said: ${probe.said}`
          }`,
        );
      },
    });
    print("");
    print(
      calibration.agreed === calibration.total
        ? `The judge gave the expected verdict on all ${calibration.total} conversations.`
        : `The judge gave the expected verdict on ${calibration.agreed} of ${calibration.total} conversations. Read the disagreements before trusting its scores: change the judge model (--judge-model) or the rubric (packages/evals/src/grade/rubric.ts) and run this again.`,
    );
    return calibration.agreed === calibration.total ? 0 : 1;
  }

  // Where the run lives: a new directory, or the one being resumed.
  const started = now();
  const id = runId(started, mode);
  const dir = path.resolve(
    deps.repoRoot,
    options.resume ?? options.out ?? path.join("evals-output", id),
  );
  const store = createRunStore(dir);
  const existing = await store.readManifest();
  if (options.resume !== undefined && existing === null) {
    print(`There is no run to resume in ${dir}.`);
    return 2;
  }
  if (existing !== null && existing.mode !== mode) {
    print(
      `The run in ${dir} is a ${existing.mode} run; it cannot be continued as a ${mode} run. Results of the two are never mixed.`,
    );
    return 2;
  }
  if (existing !== null && options.resume === undefined) {
    print(`${dir} already holds a run. Use --resume to continue it, or another --out.`);
    return 2;
  }
  const manifest: RunManifest = {
    id: existing?.id ?? id,
    mode,
    startedAt: existing?.startedAt ?? started.toISOString(),
    finishedAt: null,
    models: {
      engine: models.engineLabel,
      customer: models.customer.model,
      judge: models.judge.model,
    },
    reps: options.reps,
    concurrency: options.concurrency,
    thresholds,
    scenarioIds: scenarios.map((scenario) => scenario.id),
    selection: describeSelection(options, scenarios.length),
  };
  await store.writeManifest(manifest);

  // The engine's own log lines (model calls with tokens, guard findings) go to a file.
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "run.log");
  const logger = createLogger({
    level: "info",
    sink: (record: LogRecord) => appendFileSync(logFile, `${JSON.stringify(record)}\n`),
  });

  print(
    `${mode === "live" ? "Live" : "Mock"} evaluation: ${manifest.selection}${options.reps > 1 ? `, ${options.reps} times each` : ""}.`,
  );
  if (mode === "mock") {
    print(
      "No Claude model is called. This checks the harness and the rules the engine enforces in code; it does not measure reply quality.",
    );
  } else {
    print(
      `Bot: the model of each scenario's settings (${models.engineLabel} by default). Customers: ${models.customer.model}. Judge: ${models.judge.model}.`,
    );
  }

  let result: RunEvaluationResult;
  try {
    result = await runEvaluation({
      scenarios,
      models,
      store,
      thresholds,
      logger,
      reps: options.reps,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutS * 1000,
      strictTools: options.strict,
      ...(options.maxTurns === undefined ? {} : { maxCustomerTurns: options.maxTurns }),
      onProgress: (event) => print(progressLine(event)),
      ...deps.overrides,
    });
  } catch (error) {
    // Conversations report their own failures; what throws here is the sandbox not starting.
    print(
      `The evaluation could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    print(
      "It plays in a throwaway database on local PostgreSQL (TEST_DATABASE_URL). Start it with `pnpm services:up`.",
    );
    return 2;
  }
  if (result.skipped > 0) print(`${result.skipped} conversations already had a result.`);

  // Everything below is computed from what is on disk.
  const selected = new Set(manifest.scenarioIds);
  const rows = (await store.readResults()).filter(
    (row) => selected.has(row.scenarioId) && row.rep < options.reps,
  );
  // Every row must have been graded the way this run grades: a mock row in a live run (or a
  // live row graded by the stand-in judge) would count without a score.
  const foreign = rows.filter(
    (row) => row.grade.mode !== mode || (mode === "live" && row.judge.standIn),
  );
  if (foreign.length > 0) {
    print(
      `${dir} holds ${foreign.length} results that were not graded as a ${mode} run (${foreign
        .slice(0, 3)
        .map((row) => rowKey(row.scenarioId, row.rep))
        .join(", ")}). Results of live and mock runs are never mixed.`,
    );
    return 2;
  }
  const errors = await store.readErrors();
  const expected = scenarios.flatMap((scenario) =>
    Array.from({ length: options.reps }, (_, rep) => ({ scenarioId: scenario.id, rep })),
  );
  const { summary, scenarios: aggregates } = summarizeRun({ mode, rows, errors, expected });
  const promptVersion = rows.find((row) => row.promptVersion.length > 0)?.promptVersion ?? "";

  // A live run is compared with the live baseline; a mock run with nothing.
  const baselineFile = path.resolve(
    deps.repoRoot,
    options.baseline ?? path.join("packages", "evals", "baseline", BASELINE_FILE),
  );
  let comparison: Comparison | null = null;
  let baselineStatus: "compared" | "missing" | "skipped" = "skipped";
  if (mode === "live" && options.compare) {
    try {
      const baseline = await loadBaseline(baselineFile);
      if (baseline === null) baselineStatus = "missing";
      else {
        comparison = compareWithBaseline({
          baseline,
          scenarios: aggregates,
          manifest,
          promptVersion,
          thresholds,
        });
        baselineStatus = "compared";
      }
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error;
      print(error.message);
      return 2;
    }
  }

  const verdict = decideVerdict({
    mode,
    summary,
    scenarios: aggregates,
    comparison,
    baselineStatus,
    turnRowCounts: result.turnRowCounts,
    fatal: result.fatal,
    servedByOther: {
      engine: rows.filter((row) =>
        row.models.engine.some((model) => model !== manifest.models.engine),
      ).length,
      judge: rows.filter((row) => row.judge.model !== manifest.models.judge).length,
    },
  });

  const transcripts = new Map<string, TranscriptFile>();
  for (const row of rows) {
    const file = await store.readTranscript(row);
    if (file !== null) transcripts.set(`${row.scenarioId}#${row.rep}`, file);
  }
  const finished: RunManifest = { ...manifest, finishedAt: now().toISOString() };
  await store.writeManifest(finished);
  const reportFile = await store.writeFile(
    "report.html",
    renderReport({
      manifest: finished,
      summary,
      scenarios: aggregates,
      rows,
      errors,
      transcripts,
      comparison,
      verdict,
      thresholds,
      promptVersion,
    }),
  );
  await store.writeFile(
    "summary.md",
    renderSummaryMarkdown({ manifest: finished, summary, rows, comparison, verdict }),
  );
  await store.writeFile(
    "summary.json",
    `${JSON.stringify({ verdict, summary, comparison }, null, 2)}\n`,
  );

  print("");
  print(`${verdict.headline}`);
  for (const reason of verdict.reasons) print(`  ${reason}`);
  for (const note of verdict.notes) print(`  Note: ${note}`);
  if (mode === "live" && summary.overall !== null) {
    print(
      `  Mean overall ${summary.overall.mean.toFixed(2)} of ${MAX_SCORE}${summary.overall.halfWidth === null ? "" : ` (± ${summary.overall.halfWidth.toFixed(2)})`}; ${summary.passed} of ${summary.scenarios} scenarios passed.`,
    );
  }
  if (summary.costUsd !== null) {
    print(
      `  Cost at list prices: $${summary.costUsd.total.toFixed(2)} (bot $${summary.costUsd.engine.toFixed(2)}, customers $${summary.costUsd.customer.toFixed(2)}, judge $${summary.costUsd.judge.toFixed(2)}).`,
    );
  }
  print(`  Report: ${reportFile}`);

  if (options.saveBaseline) {
    // Saving replaces the whole file: a run of part of the suite (--core, --suite) would
    // silently drop the other scenarios from every later comparison.
    let previous: Baseline | null = null;
    try {
      previous = await loadBaseline(baselineFile);
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error;
    }
    const dropped =
      previous === null ? [] : Object.keys(previous.scenarios).filter((id) => !selected.has(id));
    if (!verdict.ok && !options.force) {
      print(
        "The baseline was not saved: the run did not pass. Fix what failed, or pass --force to save it anyway.",
      );
    } else if (dropped.length > 0 && !options.force) {
      print(
        `The baseline was not saved: it holds ${dropped.length} scenarios this run did not play (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", ..." : ""}), and replacing it would drop them from every later comparison. Run the whole suite, or pass --force to replace it anyway.`,
      );
      return verdict.exitCode === 0 ? 2 : verdict.exitCode;
    } else {
      try {
        await saveBaseline(
          baselineFile,
          baselineFrom({
            manifest: finished,
            summary,
            scenarios: aggregates,
            promptVersion,
            now: now(),
          }),
        );
        print(`  Baseline saved: ${baselineFile}. Commit it.`);
      } catch (error) {
        if (!(error instanceof BaselineError)) throw error;
        print(error.message);
        return verdict.exitCode === 0 ? 1 : verdict.exitCode;
      }
    }
  }
  return verdict.exitCode;
}
