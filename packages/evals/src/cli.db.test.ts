import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOfflineModelClient, type ModelClient } from "@repo/ai";
import { createLogger, ExternalServiceError } from "@repo/core";

import { main, USAGE } from "./cli";
import type { Baseline } from "./run/baseline";
import type { EvalModels } from "./run/models";
import type { RunEvaluationOptions } from "./run/runner";
import type { ResultRow } from "./run/store";
import { createEvalSandbox, type EvalSandbox } from "./sandbox/sandbox";
import { createStandInCustomerModel } from "./simulate/stand-in-customer";
import { fakeJudgeModel, type VerdictSpec } from "./testing/verdicts";

/**
 * `pnpm eval` from the outside: what it prints, what it writes and the exit code CI acts on.
 *
 * The "live" runs here are live only in what the command believes: the three models are
 * stand-ins with a judge whose verdicts the test writes. They prove what a live run does
 * with scores (thresholds, the baseline, regressions); they measure nothing.
 */

let root: string;
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const readRows = async (dir: string): Promise<ResultRow[]> =>
  (await readFile(path.join(dir, "results.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ResultRow);

async function run(
  args: string[],
  options: { apiKey?: string; models?: EvalModels; overrides?: Partial<RunEvaluationOptions> } = {},
) {
  const lines: string[] = [];
  const code = await main(args, {
    print: (line) => lines.push(line),
    apiKey: options.apiKey,
    repoRoot: root,
    overrides: {
      retry: { baseMs: 0, sleep: async () => undefined },
      ...(options.models === undefined ? {} : { models: options.models }),
      ...options.overrides,
    },
  });
  return { code, lines, output: lines.join("\n") };
}

/** Stand-ins dressed as a live run: the offline engine, the stand-in customer, a scripted judge. */
function fakeLive(
  decide: (context: string) => VerdictSpec = () => ({}),
  judge?: ModelClient,
): EvalModels {
  const named = (inner: ModelClient, model: string): ModelClient => ({
    name: inner.name,
    async call(request) {
      const response = await inner.call(request);
      return {
        ...response,
        model,
        usage: {
          inputTokens: 1000,
          outputTokens: 300,
          cacheReadInputTokens: 4000,
          cacheCreationInputTokens: 0,
        },
      };
    },
  });
  return {
    mode: "live",
    engine: named(createOfflineModelClient(), "claude-fable-5-2"),
    engineLabel: "claude-fable-5-2",
    customer: {
      client: named(createStandInCustomerModel(), "claude-opus-5-5"),
      model: "claude-opus-5-5",
      effort: "low",
    },
    judge: { client: judge ?? fakeJudgeModel(decide), model: "claude-opus-5-5", effort: "high" },
  };
}

/** Scenarios in which the stand-ins break no check, found by a mock run (not hard-coded). */
let clean: string[] = [];
let dirty: string[] = [];
const baselineFile = () => path.join(root, "packages", "evals", "baseline", "live.json");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "evals-cli-"));
  const probe = await run([
    "--mode",
    "mock",
    "--suite",
    "roofing,hvac",
    "--persona",
    "out_of_area,price_shopper,spam",
    "--out",
    "probe",
  ]);
  expect(probe.code).toBe(0);
  const rows = await readRows(path.join(root, "probe"));
  clean = rows
    .filter((row) => row.checks.every((check) => check.passed))
    .map((row) => row.scenarioId);
  dirty = rows
    .filter((row) => row.checks.some((check) => !check.passed))
    .map((row) => row.scenarioId);
  expect(clean.length).toBeGreaterThanOrEqual(3);
  expect(dirty.length).toBeGreaterThanOrEqual(1);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("usage", () => {
  it("prints the help", async () => {
    const result = await run(["--help"]);
    expect(result).toMatchObject({ code: 0, output: USAGE });
    for (const flag of ["--mode", "--suite", "--core", "--reps", "--resume", "--save-baseline"]) {
      expect(USAGE).toContain(flag);
    }
  });

  it("answers 2 for an option, a suite or a mode it does not know", async () => {
    expect((await run(["--fast"])).output).toContain("Unknown option --fast");
    expect((await run(["--fast"])).code).toBe(2);
    expect(await run(["--suite", "rofing"])).toMatchObject({ code: 2 });
    expect((await run(["--suite", "rofing"])).output).toContain("Unknown suite: rofing");
    expect(await run(["--mode", "pretend"])).toMatchObject({ code: 2 });
    expect(await run(["--reps", "0"])).toMatchObject({ code: 2 });
    expect(await run(["--suite"])).toMatchObject({ code: 2 });
  });

  it("lists the selected scenarios without playing them", async () => {
    const result = await run(["--list", "--core"]);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(25);
    expect(result.lines.at(-1)).toBe("24 scenarios.");
    expect(result.output).toContain("roofing.ready_to_book");
    expect(await run(["--list"])).toMatchObject({ code: 0 });
    expect((await run(["--list"])).lines.at(-1)).toBe("72 scenarios.");
  });
});

describe("without a key", () => {
  it("runs as a mock run by default, says so everywhere, and passes on the engine's own rules", async () => {
    const result = await run(["--suite", "roofing", "--out", "mock-default"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Mock evaluation: 12 of 72 scenarios (suite roofing).");
    expect(result.output).toContain("No Claude model is called.");
    expect(result.output).toContain("HARNESS CHECK PASSED");
    expect(result.output).toContain("MOCK RUN.");
    expect(result.output).not.toMatch(/Mean overall|PASS \d/);

    const dir = path.join(root, "mock-default");
    const manifest = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      mode: "mock",
      models: {
        engine: "offline-rules-1",
        customer: "stand-in-customer-1",
        judge: "stand-in-judge-1",
      },
    });
    expect(manifest["finishedAt"]).not.toBeNull();
    const report = await readFile(path.join(dir, "report.html"), "utf8");
    expect(report).toContain("MOCK RUN.");
    expect(report).toContain("HARNESS CHECK PASSED");
    expect(report).not.toContain("Scores by criterion");
    expect(await readFile(path.join(dir, "summary.md"), "utf8")).toContain("HARNESS CHECK PASSED");
    expect(await exists(path.join(dir, "run.log"))).toBe(true);
  });

  it("plays the whole suite: `pnpm eval` without a key is green", async () => {
    const result = await run(["--out", "mock-all"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Mock evaluation: all 72 scenarios.");
    expect(result.output).toContain(
      "All 72 conversations ran to the end and every rule the engine enforces in code held.",
    );
    expect(await readRows(path.join(root, "mock-all"))).toHaveLength(72);
  });

  it("refuses a live run and refuses to save a baseline", async () => {
    const live = await run(["--mode", "live"]);
    expect(live.code).toBe(2);
    expect(live.output).toContain("A live run needs ANTHROPIC_API_KEY");
    const save = await run(["--save-baseline", "--suite", "roofing"]);
    expect(save.code).toBe(2);
    expect(save.output).toContain("A baseline can only be saved from a live run");
    expect(await exists(baselineFile())).toBe(false);
  });

  it("is never compared with a baseline, even when a live one is saved", async () => {
    const baseline: Baseline = {
      version: 1,
      mode: "live",
      savedAt: "2026-11-01T00:00:00.000Z",
      runId: "earlier",
      promptVersion: "reply-v1.r2",
      models: { engine: "claude-fable-5-2", customer: "claude-opus-5-5", judge: "claude-opus-5-5" },
      overall: 5,
      criteria: {
        qualification: 5,
        accuracy: 5,
        setting_compliance: 5,
        engagement: 5,
        emergency_handling: 5,
        safety: 5,
        routing: 5,
      },
      scenarios: {},
    };
    const other = path.join(root, "other-baseline.json");
    await writeFile(other, JSON.stringify(baseline));
    const result = await run([
      "--scenario",
      clean[0] ?? "",
      "--baseline",
      "other-baseline.json",
      "--out",
      "mock-nocompare",
    ]);
    expect(result.code).toBe(0);
    const summary = JSON.parse(
      await readFile(path.join(root, "mock-nocompare", "summary.json"), "utf8"),
    ) as {
      comparison: unknown;
    };
    expect(summary.comparison).toBeNull();
  });

  it("fails when a rule the engine enforces in code breaks, with the conversation named", async () => {
    // An engine whose output guard has stopped working: every reply leaves with markdown in it.
    const sandbox = await createEvalSandbox({
      model: createOfflineModelClient(),
      logger: createLogger({ level: "error", sink: () => undefined }),
      segments: ["roofing"],
    });
    const broken: EvalSandbox = {
      ...sandbox,
      engine: {
        async respond(input, ports) {
          const result = await sandbox.engine.respond(input, ports);
          return {
            ...result,
            replies: result.replies.map((draft) => ({
              ...draft,
              text: `${draft.text} **Call now!**`,
            })),
          };
        },
      },
    };
    try {
      const id = clean.find((scenario) => scenario.startsWith("roofing.")) ?? "";
      const result = await run(["--scenario", id, "--out", "mock-broken"], {
        overrides: { sandbox: broken },
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain("FAILED");
      expect(result.output).toContain(
        `1 of 1 conversations broke a rule the engine enforces in code: ${id}.`,
      );
      expect(result.output).toMatch(/FAIL \(check:plain_text/);
      const report = await readFile(path.join(root, "mock-broken", "report.html"), "utf8");
      expect(report).toContain(
        "Replies carry no markup or internal markers. Found: reply 1: markdown",
      );
    } finally {
      await sandbox.dispose();
    }
  });
});

describe("a live run", () => {
  it("passes when every scenario passes, and tells you to save a baseline", async () => {
    const result = await run(["--scenario", clean.join(","), "--out", "live-pass"], {
      apiKey: "sk-test",
      models: fakeLive(),
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`Live evaluation: ${clean.length} of 72 scenarios`);
    expect(result.output).toContain("PASSED");
    expect(result.output).toContain("No live baseline is saved yet");
    expect(result.output).toMatch(/Mean overall 5\.00 of 5/);
    expect(result.output).toMatch(/Cost at list prices: \$\d+\.\d\d/);
    expect(result.output).not.toContain("MOCK RUN");
    const rows = await readRows(path.join(root, "live-pass"));
    // Cost comes from the tokens each call reported and the model that answered it.
    expect(rows[0]?.costUsd.engine).toBeGreaterThan(0);
    expect(rows[0]?.costUsd.judge).toBeGreaterThan(0);
    expect(rows[0]?.grade).toMatchObject({ mode: "live", overall: 5, passed: true });
    const report = await readFile(path.join(root, "live-pass", "report.html"), "utf8");
    expect(report).toContain("Scores by criterion");
    expect(report).toContain("Cost of this run");
  });

  it("fails on a scenario below the pass score and on any setting-compliance failure", async () => {
    const low = await run(["--scenario", clean.join(","), "--out", "live-low"], {
      apiKey: "sk-test",
      models: fakeLive((context) =>
        context.includes("Customer: Price shopper") ? { base: 3 } : {},
      ),
    });
    expect(low.code).toBe(1);
    expect(low.output).toContain("FAILED");
    expect(low.output).toMatch(/FAIL 3\.00 \(/);
    expect(low.output).toMatch(/scenarios did not pass: .*price_shopper/);

    const violation = await run(["--scenario", clean[0] ?? "", "--out", "live-violation"], {
      apiKey: "sk-test",
      models: fakeLive(() => ({
        violations: [
          {
            rule: "routing",
            quote: null,
            explanation: "Never said when the team will be in touch.",
          },
        ],
      })),
    });
    expect(violation.code).toBe(1);
    expect(violation.output).toContain("1 setting-compliance failures (the target is zero).");
  });

  it("fails on behaviour the scenario demands, which a mock run does not count", async () => {
    const result = await run(["--scenario", dirty[0] ?? "", "--out", "live-dirty"], {
      apiKey: "sk-test",
      models: fakeLive(),
    });
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/FAIL .*check:/);
  });

  it("saves a baseline only from a passing run, then fails a later run that dropped against it", async () => {
    const failing = await run(
      ["--scenario", clean.join(","), "--out", "live-save-fail", "--save-baseline"],
      {
        apiKey: "sk-test",
        models: fakeLive(() => ({ base: 3 })),
      },
    );
    expect(failing.code).toBe(1);
    expect(failing.output).toContain("The baseline was not saved: the run did not pass.");
    expect(await exists(baselineFile())).toBe(false);

    const saved = await run(
      ["--scenario", clean.join(","), "--out", "live-save", "--save-baseline"],
      {
        apiKey: "sk-test",
        models: fakeLive(),
      },
    );
    expect(saved.code).toBe(0);
    expect(saved.output).toContain("Baseline saved:");
    const baseline = JSON.parse(await readFile(baselineFile(), "utf8")) as Baseline;
    expect(baseline).toMatchObject({
      mode: "live",
      overall: 5,
      models: { judge: "claude-opus-5-5" },
    });
    expect(Object.keys(baseline.scenarios).sort()).toEqual([...clean].sort());

    // Every scenario still passes on its own (4.57 ≥ 4), but the run is worse than the baseline.
    const dropped = await run(["--scenario", clean.join(","), "--out", "live-dropped"], {
      apiKey: "sk-test",
      models: fakeLive(() => ({ scores: { engagement: 4, qualification: 4, routing: 4 } })),
    });
    expect(dropped.code).toBe(1);
    expect(dropped.output).toContain(
      "The mean overall score fell from 5.00 to 4.57 (allowed: 0.25).",
    );
    expect(dropped.output).toContain("engagement fell from 5.00 to 4.00");
    expect(dropped.output).not.toContain("did not pass");
    const report = await readFile(path.join(root, "live-dropped", "report.html"), "utf8");
    expect(report).toContain("vs baseline");

    // The same run without the comparison passes: the drop is what failed it.
    const uncompared = await run(
      ["--scenario", clean.join(","), "--out", "live-uncompared", "--no-compare"],
      {
        apiKey: "sk-test",
        models: fakeLive(() => ({ scores: { engagement: 4, qualification: 4, routing: 4 } })),
      },
    );
    expect(uncompared.code).toBe(0);

    // A file that was not recorded against the Claude API is refused as a baseline.
    await writeFile(
      path.join(root, "mock-baseline.json"),
      JSON.stringify({ ...baseline, mode: "mock" }),
    );
    const refused = await run(
      ["--scenario", clean[0] ?? "", "--out", "live-refused", "--baseline", "mock-baseline.json"],
      {
        apiKey: "sk-test",
        models: fakeLive(),
      },
    );
    expect(refused.code).toBe(2);
    expect(refused.output).toContain("was not recorded against the Claude API");

    // A run of part of the suite does not replace the baseline unless asked to.
    const partial = await run(
      ["--scenario", clean[0] ?? "", "--out", "live-save-partial", "--save-baseline"],
      { apiKey: "sk-test", models: fakeLive() },
    );
    expect(partial.code).toBe(2);
    expect(partial.output).toContain("this run did not play");
    const kept = JSON.parse(await readFile(baselineFile(), "utf8")) as Baseline;
    expect(Object.keys(kept.scenarios).sort()).toEqual([...clean].sort());
    const forced = await run(
      ["--scenario", clean[0] ?? "", "--out", "live-save-forced", "--save-baseline", "--force"],
      { apiKey: "sk-test", models: fakeLive() },
    );
    expect(forced.code).toBe(0);
    const replaced = JSON.parse(await readFile(baselineFile(), "utf8")) as Baseline;
    expect(Object.keys(replaced.scenarios)).toEqual([clean[0]]);
  });

  it("refuses rows of a run graded another way: a mock row never counts in a live run", async () => {
    const first = await run(["--scenario", clean[0] ?? "", "--out", "live-mixed", "--no-compare"], {
      apiKey: "sk-test",
      models: fakeLive(),
    });
    expect(first.code).toBe(0);
    const file = path.join(root, "live-mixed", "results.jsonl");
    const [row] = await readRows(path.join(root, "live-mixed"));
    if (row === undefined) throw new Error("no row");
    await writeFile(file, `${JSON.stringify({ ...row, grade: { ...row.grade, mode: "mock" } })}\n`);
    const resumed = await run(
      ["--scenario", clean[0] ?? "", "--resume", "live-mixed", "--no-compare"],
      {
        apiKey: "sk-test",
        models: fakeLive(),
      },
    );
    expect(resumed.code).toBe(2);
    expect(resumed.output).toContain("Results of live and mock runs are never mixed.");
  });

  it("is incomplete, with exit code 3, when a conversation could not be judged; --resume finishes it", async () => {
    let down = true;
    const inner = fakeJudgeModel();
    const judge: ModelClient = {
      name: "flaky",
      async call(request) {
        const first = request.messages[0]?.content;
        if (down && typeof first === "string" && first.includes("Customer: Price shopper")) {
          throw new ExternalServiceError("The Claude API answered 529.", {
            provider: "anthropic",
            status: 529,
          });
        }
        return inner.call(request);
      },
    };
    const args = ["--scenario", clean.join(","), "--no-compare"];
    const first = await run([...args, "--out", "live-incomplete"], {
      apiKey: "sk-test",
      models: fakeLive(undefined, judge),
    });
    expect(first.code).toBe(3);
    expect(first.output).toContain("INCOMPLETE");
    expect(first.output).toMatch(/NOT PLAYED \(serving\): The Claude API answered 529\./);
    expect(first.output).toMatch(/conversations could not be played or judged \(\d+ serving\)/);
    // An incomplete run cannot become a baseline, whatever is asked.
    expect(await exists(path.join(root, "live-incomplete", "report.html"))).toBe(true);

    down = false;
    const second = await run([...args, "--resume", "live-incomplete"], {
      apiKey: "sk-test",
      models: fakeLive(undefined, judge),
    });
    expect(second.code).toBe(0);
    expect(second.output).toContain("already had a result.");

    // A mock run cannot be continued as a live run, or the other way round.
    const mixed = await run(["--suite", "roofing", "--resume", "mock-default"], {
      apiKey: "sk-test",
      models: fakeLive(),
    });
    expect(mixed.code).toBe(2);
    expect(mixed.output).toContain("Results of the two are never mixed.");
    expect((await run(["--resume", "nowhere"])).code).toBe(2);
  });
});
