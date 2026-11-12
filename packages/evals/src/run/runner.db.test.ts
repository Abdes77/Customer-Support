import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ModelClient, ModelRequest } from "@repo/ai";
import { ConfigError, createLogger, ExternalServiceError } from "@repo/core";

import { DEFAULT_THRESHOLDS } from "../grade/rubric";
import { createStandInJudgeModel } from "../grade/stand-in-judge";
import { selectScenarios } from "../scenarios/matrix";
import { type EvalModels, mockModels } from "./models";
import { type ProgressEvent, runEvaluation } from "./runner";
import { createRunStore } from "./store";
import { summarizeRun } from "./summary";

/**
 * The runner end to end against the sandbox, with the stand-ins for all three models: this
 * is the proof that the harness works without a key.
 */

const logger = createLogger({ level: "error", sink: () => undefined });
const noWait = { baseMs: 0, sleep: async () => undefined };
const roofing = selectScenarios({ suites: ["roofing"] });
let root: string;
let counter = 0;
const freshDir = () => path.join(root, `run-${(counter += 1)}`);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "evals-runner-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The mock models with a judge that a test can make fail for chosen conversations. */
function modelsWithJudge(judge: ModelClient): EvalModels {
  const models = mockModels();
  return { ...models, judge: { ...models.judge, client: judge } };
}

const contextOf = (request: ModelRequest) => {
  const first = request.messages[0]?.content;
  return typeof first === "string" ? first : "";
};

describe("runEvaluation with stand-in models", () => {
  it("plays a whole suite, saves a row and a transcript per conversation, and writes nothing else", async () => {
    const store = createRunStore(freshDir());
    const events: ProgressEvent[] = [];
    const result = await runEvaluation({
      scenarios: roofing,
      models: mockModels(),
      store,
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      onProgress: (event) => events.push(event),
    });
    expect(result).toMatchObject({ played: 12, skipped: 0, fatal: null });
    expect(result.promptVersion).toMatch(/^reply-v\d+\.r\d+$/);
    // Invariant I8: a dry run leaves the tables a live turn writes empty.
    expect(Object.values(result.turnRowCounts).every((rows) => rows === 0)).toBe(true);

    const rows = await store.readResults();
    expect(rows.map((row) => row.scenarioId).sort()).toEqual(
      roofing.map((scenario) => scenario.id).sort(),
    );
    expect(await store.readErrors()).toEqual([]);
    expect(events).toHaveLength(12);
    expect(events.at(-1)).toMatchObject({ kind: "result", done: 12, total: 12 });

    for (const row of rows) {
      // A mock run has no scores and no cost: nothing judged it, nothing was billed.
      expect(row.grade).toMatchObject({ mode: "mock", overall: null });
      expect(row.judge.standIn).toBe(true);
      // (A conversation without a simulated customer made no customer call: that is a real zero.)
      expect(row.costUsd).toEqual({
        engine: null,
        customer: row.persona === "spam" ? 0 : null,
        judge: null,
      });
      expect(row.models).toEqual({
        engine: ["offline-rules-1"],
        customer: row.persona === "spam" ? [] : ["stand-in-customer-1"],
        judge: "stand-in-judge-1",
      });
      expect(row.customerTurns).toBeGreaterThan(0);
      expect(row.checks.length).toBeGreaterThan(8);
      const file = await store.readTranscript(row);
      expect(file?.transcript.entries.length).toBeGreaterThan(1);
      expect(file?.row.scenarioId).toBe(row.scenarioId);
    }
    // The rules the engine enforces in code hold in every conversation of the suite.
    expect(
      rows.flatMap((row) =>
        row.checks.filter((check) => check.guarantee === "code" && !check.passed),
      ),
    ).toEqual([]);
    expect(rows.every((row) => row.grade.passed)).toBe(true);
  });

  it("resumes: a conversation that has a row is not played again", async () => {
    const store = createRunStore(freshDir());
    const base = { models: mockModels(), store, thresholds: DEFAULT_THRESHOLDS, logger };
    const first = await runEvaluation({ ...base, scenarios: roofing.slice(0, 4) });
    expect(first.played).toBe(4);
    const second = await runEvaluation({ ...base, scenarios: roofing.slice(0, 6) });
    expect(second).toMatchObject({ played: 2, skipped: 4 });
    expect(await store.readResults()).toHaveLength(6);
    const lines = (await readFile(path.join(store.dir, "results.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(6);
  });

  it("plays every scenario as often as asked", async () => {
    const store = createRunStore(freshDir());
    const result = await runEvaluation({
      scenarios: roofing.slice(0, 2),
      models: mockModels(),
      store,
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      reps: 3,
    });
    expect(result.played).toBe(6);
    const rows = await store.readResults();
    expect(rows.map((row) => `${row.scenarioId}#${row.rep}`).sort()).toEqual(
      roofing
        .slice(0, 2)
        .flatMap((scenario) => [0, 1, 2].map((rep) => `${scenario.id}#${rep}`))
        .sort(),
    );
    expect(new Set(rows.map((row) => row.transcriptFile)).size).toBe(6);
  });

  it("runs conversations side by side, never more than the limit", async () => {
    let active = 0;
    let peak = 0;
    let arrived = 0;
    let open: () => void = () => undefined;
    // The first three conversations to reach the judge wait there for each other, so the
    // result does not depend on how fast the machine is: with a limit of three, three are
    // in flight at once, and a fourth never joins them.
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inner = createStandInJudgeModel();
    const judge: ModelClient = {
      name: "gated-judge",
      async call(request) {
        active += 1;
        peak = Math.max(peak, active);
        arrived += 1;
        if (arrived === 3) open();
        if (arrived <= 3) {
          await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 20_000))]);
        }
        active -= 1;
        return inner.call(request);
      },
    };
    const both = selectScenarios({ suites: ["roofing", "hvac"] });
    await runEvaluation({
      scenarios: both,
      models: modelsWithJudge(judge),
      store: createRunStore(freshDir()),
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      concurrency: 3,
    });
    expect(arrived).toBe(24);
    expect(peak).toBe(3);
  });
});

describe("attempts that produce nothing to grade", () => {
  it("go to errors.jsonl with their cause, never into the results, and are played on resume", async () => {
    const inner = createStandInJudgeModel();
    let broken = true;
    const judge: ModelClient = {
      name: "flaky-judge",
      async call(request) {
        if (broken && contextOf(request).includes("Customer: Renter")) {
          throw new ExternalServiceError("The Claude API answered 529.", {
            provider: "anthropic",
            status: 529,
          });
        }
        return inner.call(request);
      },
    };
    const store = createRunStore(freshDir());
    const options = {
      scenarios: roofing,
      models: modelsWithJudge(judge),
      store,
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      retry: noWait,
    };
    const first = await runEvaluation(options);
    expect(first).toMatchObject({ played: 11, fatal: null });
    const errors = await store.readErrors();
    expect(errors).toEqual([
      expect.objectContaining({
        scenarioId: "roofing.renter",
        rep: 0,
        class: "serving",
        message: "The Claude API answered 529.",
      }),
    ]);
    expect((await store.readResults()).some((row) => row.scenarioId === "roofing.renter")).toBe(
      false,
    );

    const expected = roofing.map((scenario) => ({ scenarioId: scenario.id, rep: 0 }));
    const partial = summarizeRun({
      mode: "mock",
      rows: await store.readResults(),
      errors,
      expected,
    });
    expect(partial.summary.unresolved).toEqual(["roofing.renter#0"]);

    // The API recovers: the resumed run plays exactly the one that is missing.
    broken = false;
    const second = await runEvaluation(options);
    expect(second).toMatchObject({ played: 1, skipped: 11 });
    const done = summarizeRun({
      mode: "mock",
      rows: await store.readResults(),
      errors: await store.readErrors(),
      expected,
    });
    expect(done.summary.unresolved).toEqual([]);
    // The failed attempt stays on record.
    expect(done.summary.errors).toEqual({ serving: 1 });
  });

  it("stops a conversation at its wall-clock ceiling and frees the slot", async () => {
    const inner = createStandInJudgeModel();
    const judge: ModelClient = {
      name: "hanging-judge",
      call(request) {
        if (contextOf(request).includes("Customer: Spam")) return new Promise(() => undefined);
        return inner.call(request);
      },
    };
    const store = createRunStore(freshDir());
    const started = Date.now();
    const result = await runEvaluation({
      scenarios: roofing.filter((scenario) => ["spam", "renter"].includes(scenario.persona.id)),
      models: modelsWithJudge(judge),
      store,
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      // Long enough for the conversation that is fine, on a busy machine too.
      timeoutMs: 2500,
      concurrency: 1,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.played).toBe(1);
    expect(await store.readErrors()).toEqual([
      expect.objectContaining({ scenarioId: "roofing.spam", class: "timeout" }),
    ]);
  });

  it("stops the whole run when the key is missing or refused: no later conversation could work", async () => {
    const models = mockModels();
    let calls = 0;
    const engine: ModelClient = {
      name: "no-key",
      async call() {
        calls += 1;
        throw new ConfigError(
          "The Claude API rejected the API key. Check ANTHROPIC_API_KEY (docs/HUMAN_TODO.md).",
        );
      },
    };
    const store = createRunStore(freshDir());
    const result = await runEvaluation({
      scenarios: roofing,
      models: { ...models, engine },
      store,
      thresholds: DEFAULT_THRESHOLDS,
      logger,
      concurrency: 1,
      retry: noWait,
    });
    expect(result.fatal).toContain("not configured, or it refused the key");
    expect(result.played).toBe(0);
    // One conversation found out; the other eleven were not started.
    expect(calls).toBe(1);
    expect(await store.readErrors()).toEqual([expect.objectContaining({ class: "config" })]);
  });
});
