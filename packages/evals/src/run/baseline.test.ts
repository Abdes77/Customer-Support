import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS } from "../grade/rubric";
import { rowWith } from "../testing/rows";
import {
  BaselineError,
  baselineFrom,
  compareWithBaseline,
  loadBaseline,
  saveBaseline,
} from "./baseline";
import type { ErrorRow, ResultRow, RunManifest } from "./store";
import { summarizeRun } from "./summary";
import { decideVerdict, MOCK_NOTICE } from "./verdict";

const IDS = ["roofing.ready_to_book", "roofing.renter", "hvac.spam", "hvac.emergency"];
const now = new Date("2026-11-12T10:00:00.000Z");

function manifest(mode: "live" | "mock", ids = IDS): RunManifest {
  return {
    id: `run-${mode}`,
    mode,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    models: { engine: "claude-fable-5-2", customer: "claude-opus-5-5", judge: "claude-opus-5-5" },
    reps: 1,
    concurrency: 4,
    thresholds: DEFAULT_THRESHOLDS,
    scenarioIds: ids,
    selection: "test",
  };
}

function run(
  rows: ResultRow[],
  mode: "live" | "mock" = "live",
  errors: ErrorRow[] = [],
  ids = IDS,
) {
  return summarizeRun({
    mode,
    rows,
    errors,
    expected: ids.map((scenarioId) => ({ scenarioId, rep: 0 })),
  });
}

const zeroRows = { conversations: 0, messages: 0 };
const verdictOf = (
  result: ReturnType<typeof run>,
  mode: "live" | "mock",
  extra: Partial<Parameters<typeof decideVerdict>[0]> = {},
) =>
  decideVerdict({
    mode,
    summary: result.summary,
    scenarios: result.scenarios,
    comparison: null,
    baselineStatus: "skipped",
    turnRowCounts: zeroRows,
    fatal: null,
    ...extra,
  });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "evals-baseline-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("summarizeRun", () => {
  it("recomputes everything from the rows: means, interval, groups, cost", () => {
    const { summary, scenarios } = run([
      rowWith("roofing.ready_to_book", { scores: 5 }),
      rowWith("roofing.renter", { scores: 4 }),
      rowWith("hvac.spam", { scores: { qualification: null, engagement: null, routing: 4 } }),
      rowWith("hvac.emergency", {
        scores: 3,
        complianceFailures: 2,
        failures: [{ kind: "score", id: "overall", criterion: null, detail: "Overall 3.00." }],
      }),
    ]);
    expect(summary).toMatchObject({
      conversations: 4,
      scenarios: 4,
      passed: 3,
      failed: 1,
      complianceFailures: 2,
    });
    expect(summary.overall?.mean).toBe(4.2);
    expect(summary.overall?.halfWidth).toBeGreaterThan(0);
    // Qualification does not apply to spam: three scenarios, not four.
    expect(summary.criteria.qualification).toEqual({ mean: 4, scenarios: 3 });
    expect(summary.bySuite["hvac"]).toEqual({ scenarios: 2, passed: 1, mean: 3.9 });
    expect(summary.byPersona["renter"]).toEqual({ scenarios: 1, passed: 1, mean: 4 });
    expect(summary.costUsd?.total).toBeCloseTo(4 * 0.55, 5);
    expect(summary.unresolved).toEqual([]);
    expect(
      scenarios.find((scenario) => scenario.scenarioId === "hvac.emergency")?.failures,
    ).toEqual(["score:overall"]);
  });

  it("averages the repetitions of a scenario and passes it only when every one passed", () => {
    const { scenarios, summary } = summarizeRun({
      mode: "live",
      rows: [
        rowWith("roofing.renter", { scores: 5 }),
        rowWith("roofing.renter", {
          rep: 1,
          scores: 3,
          failures: [{ kind: "score", id: "overall", criterion: null, detail: "low" }],
        }),
      ],
      errors: [],
      expected: [
        { scenarioId: "roofing.renter", rep: 0 },
        { scenarioId: "roofing.renter", rep: 1 },
      ],
    });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({ reps: 2, overall: 4, passed: false });
    expect(summary).toMatchObject({ conversations: 2, scenarios: 1, passed: 0 });
  });

  it("keeps conversations that could not be played out of the scores, and lists them", () => {
    const errors: ErrorRow[] = [
      {
        scenarioId: "hvac.spam",
        rep: 0,
        class: "serving",
        message: "The Claude API answered 529.",
        at: now.toISOString(),
        durationMs: 10,
      },
      {
        scenarioId: "hvac.emergency",
        rep: 0,
        class: "timeout",
        message: "Stopped.",
        at: now.toISOString(),
        durationMs: 10,
      },
      // An earlier failed attempt of a conversation that then succeeded.
      {
        scenarioId: "roofing.renter",
        rep: 0,
        class: "serving",
        message: "429",
        at: now.toISOString(),
        durationMs: 10,
      },
    ];
    const { summary } = run(
      [rowWith("roofing.ready_to_book"), rowWith("roofing.renter")],
      "live",
      errors,
    );
    expect(summary.unresolved).toEqual(["hvac.spam#0", "hvac.emergency#0"]);
    expect(summary.errors).toEqual({ serving: 2, timeout: 1 });
    expect(summary.scenarios).toBe(2);
    expect(summary.overall?.mean).toBe(5);
  });

  it("has no cost and no scores for a mock run", () => {
    const { summary } = run(
      IDS.map((id) => rowWith(id, { mode: "mock", scores: null, costUsd: null })),
      "mock",
    );
    expect(summary.costUsd).toBeNull();
    expect(summary.overall).toBeNull();
    expect(summary.passed).toBe(4);
  });
});

describe("the baseline", () => {
  const rows = IDS.map((id) => rowWith(id, { scores: 4.5 as number }));

  it("is saved from a complete live run and read back", async () => {
    const result = run(rows);
    const baseline = baselineFrom({
      manifest: manifest("live"),
      ...result,
      promptVersion: "reply-v1.r2",
      now,
    });
    expect(baseline).toMatchObject({
      mode: "live",
      overall: 4.5,
      runId: "run-live",
      promptVersion: "reply-v1.r2",
    });
    expect(Object.keys(baseline.scenarios)).toEqual(IDS);
    const file = path.join(dir, "nested", "live.json");
    await saveBaseline(file, baseline);
    expect(await loadBaseline(file)).toEqual(baseline);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, mode: "live" });
    expect(await loadBaseline(path.join(dir, "missing.json"))).toBeNull();
  });

  it("cannot be made from a mock run", () => {
    const mock = run(
      IDS.map((id) => rowWith(id, { mode: "mock", scores: null, costUsd: null })),
      "mock",
    );
    expect(() =>
      baselineFrom({ manifest: manifest("mock"), ...mock, promptVersion: "", now }),
    ).toThrow(BaselineError);
    expect(() =>
      baselineFrom({ manifest: manifest("mock"), ...mock, promptVersion: "", now }),
    ).toThrow(/only be saved from a live run/);
    // Not even when someone hands a mock summary to a manifest that says "live".
    expect(() =>
      baselineFrom({ manifest: manifest("live"), ...mock, promptVersion: "", now }),
    ).toThrow(BaselineError);
  });

  it("cannot be made from an incomplete run", () => {
    const partial = run(rows.slice(0, 3));
    expect(() =>
      baselineFrom({ manifest: manifest("live"), ...partial, promptVersion: "", now }),
    ).toThrow(/incomplete: 1 conversations have no result/);
  });

  it("refuses to read a file that was not recorded against the Claude API", async () => {
    const result = run(rows);
    const live = baselineFrom({ manifest: manifest("live"), ...result, promptVersion: "p", now });
    const forged = path.join(dir, "mock.json");
    await writeFile(forged, JSON.stringify({ ...live, mode: "mock" }));
    await expect(loadBaseline(forged)).rejects.toThrow(/was not recorded against the Claude API/);
    const unlabeled = path.join(dir, "unlabeled.json");
    const { mode: _mode, ...rest } = live;
    await writeFile(unlabeled, JSON.stringify(rest));
    await expect(loadBaseline(unlabeled)).rejects.toThrow(BaselineError);
    const garbage = path.join(dir, "garbage.json");
    await writeFile(garbage, "{not json");
    await expect(loadBaseline(garbage)).rejects.toThrow(/not valid JSON/);
  });
});

describe("compareWithBaseline", () => {
  const before = run(IDS.map((id) => rowWith(id, { scores: 4.5 as number })));
  const baseline = baselineFrom({
    manifest: manifest("live"),
    ...before,
    promptVersion: "reply-v1.r2",
    now,
  });
  const compare = (
    rows: ResultRow[],
    overrides: Partial<Parameters<typeof compareWithBaseline>[0]> = {},
  ) =>
    compareWithBaseline({
      baseline,
      scenarios: run(rows).scenarios,
      manifest: manifest("live"),
      promptVersion: "reply-v1.r2",
      thresholds: DEFAULT_THRESHOLDS,
      ...overrides,
    });

  it("finds nothing when the scores hold or move within the thresholds", () => {
    const same = compare(IDS.map((id) => rowWith(id, { scores: 4.5 as number })));
    expect(same).toMatchObject({ compared: 4, regressions: [], notes: [] });
    expect(same.overall).toEqual({ baseline: 4.5, current: 4.5 });
    expect(compare(IDS.map((id) => rowWith(id, { scores: 4.3 as number }))).regressions).toEqual(
      [],
    );
    expect(compare(IDS.map((id) => rowWith(id, { scores: 5 }))).regressions).toEqual([]);
  });

  it("reports a drop of the overall mean beyond the threshold", () => {
    const worse = compare(IDS.map((id) => rowWith(id, { scores: 4.2 as number })));
    expect(worse.regressions.map((item) => item.kind)).toEqual(["overall"]);
    expect(worse.regressions[0]?.detail).toBe(
      "The mean overall score fell from 4.50 to 4.20 (allowed: 0.25).",
    );
  });

  it("reports one criterion that fell while the average held", () => {
    const rows = IDS.map((id) => rowWith(id, { scores: { ...allAt(4.6), engagement: 3.9 } }));
    const result = compare(rows);
    expect(result.regressions.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "criterion:engagement",
    ]);
  });

  it("compares a criterion's means over the scenarios scored on both sides only", () => {
    // Routing scored 1 in the baseline for one scenario that has it not applicable now; the
    // others hold at 4.5. Without the pairing, routing would seem to rise and hide a fall.
    const low = baselineFrom({
      manifest: manifest("live"),
      ...run(
        IDS.map((id, index) =>
          rowWith(id, { scores: { ...allAt(4.5), routing: index === 0 ? 1 : 4.5 } }),
        ),
      ),
      promptVersion: "reply-v1.r2",
      now,
    });
    const rows = IDS.map((id, index) =>
      rowWith(id, { scores: { ...allAt(4.5), routing: index === 0 ? null : 4 } }),
    );
    const result = compare(rows, { baseline: low });
    expect(result.criteria.routing).toEqual({ baseline: 4.5, current: 4 });
    expect(result.regressions.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "criterion:routing",
    ]);
  });

  it("reports one scenario that fell far, and one that passed before and fails now", () => {
    const rows = [
      rowWith("roofing.ready_to_book", { scores: 3.4 as number }),
      rowWith("roofing.renter", {
        scores: 4.5 as number,
        failures: [{ kind: "rule", id: "pricing", criterion: "setting_compliance", detail: "x" }],
      }),
      rowWith("hvac.spam", { scores: 5 }),
      rowWith("hvac.emergency", { scores: 5 }),
    ];
    const kinds = compare(rows).regressions.map((item) => `${item.kind}:${item.id}`);
    expect(kinds).toContain("scenario:roofing.ready_to_book");
    expect(kinds).toContain("newly_failing:roofing.renter");
  });

  it("compares only the scenarios both runs have, and says what makes them less comparable", () => {
    const rows = [
      rowWith("roofing.ready_to_book", { scores: 4.5 as number }),
      rowWith("plumbing.spam", { scores: 1 }),
    ];
    const result = compareWithBaseline({
      baseline,
      scenarios: run(rows, "live", [], ["roofing.ready_to_book", "plumbing.spam"]).scenarios,
      manifest: {
        models: {
          engine: "claude-fable-5-2",
          customer: "claude-opus-5-5",
          judge: "claude-sonnet-5-5",
        },
      },
      promptVersion: "reply-v2.r1",
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(result.compared).toBe(1);
    expect(result.regressions).toEqual([]);
    expect(result.notes).toHaveLength(3);
    expect(result.notes.join(" ")).toContain(
      "judged by claude-opus-5-5, this run by claude-sonnet-5-5",
    );
    expect(result.notes.join(" ")).toContain(
      "reply-v1.r2 in the baseline, reply-v2.r1 in this run",
    );
  });
});

function allAt(score: number) {
  return {
    qualification: score,
    accuracy: score,
    setting_compliance: score,
    engagement: score,
    emergency_handling: score,
    safety: score,
    routing: score,
  };
}

describe("decideVerdict", () => {
  it("passes a live run in which everything passed, and says when there is no baseline yet", () => {
    const verdict = verdictOf(run(IDS.map((id) => rowWith(id))), "live", {
      baselineStatus: "missing",
    });
    expect(verdict).toMatchObject({ ok: true, exitCode: 0, headline: "PASSED" });
    expect(verdict.notes.join(" ")).toContain("No live baseline is saved yet");
  });

  it("fails a live run on a failing scenario, a compliance failure or a regression", () => {
    const failing = run([
      ...IDS.slice(1).map((id) => rowWith(id)),
      rowWith(IDS[0] ?? "", {
        complianceFailures: 1,
        failures: [{ kind: "rule", id: "pricing", criterion: "setting_compliance", detail: "x" }],
      }),
    ]);
    const verdict = verdictOf(failing, "live");
    expect(verdict).toMatchObject({ ok: false, exitCode: 1, headline: "FAILED" });
    expect(verdict.reasons[0]).toContain("1 of 4 scenarios did not pass: roofing.ready_to_book.");
    expect(verdict.reasons[1]).toContain("1 setting-compliance failures");

    const regressed = verdictOf(run(IDS.map((id) => rowWith(id))), "live", {
      baselineStatus: "compared",
      comparison: {
        baselineRunId: "b",
        baselineSavedAt: now.toISOString(),
        compared: 4,
        overall: { baseline: 5, current: 4.5 },
        criteria: {} as never,
        regressions: [
          {
            kind: "overall",
            id: "overall",
            baseline: 5,
            current: 4.5,
            detail: "The mean overall score fell.",
          },
        ],
        notes: [],
      },
    });
    expect(regressed).toMatchObject({ ok: false, exitCode: 1 });
    expect(regressed.reasons).toContain("The mean overall score fell.");
  });

  it("is incomplete, never passed, when conversations could not be played", () => {
    const partial = run([rowWith(IDS[0] ?? "")], "live", [
      {
        scenarioId: IDS[1] ?? "",
        rep: 0,
        class: "serving",
        message: "529",
        at: now.toISOString(),
        durationMs: 1,
      },
    ]);
    const verdict = verdictOf(partial, "live");
    expect(verdict).toMatchObject({ ok: false, exitCode: 3, headline: "INCOMPLETE" });
    expect(verdict.reasons[0]).toContain(
      "3 conversations could not be played or judged (1 serving)",
    );
    const fatal = verdictOf(partial, "live", { fatal: "The Claude API rejected the API key." });
    expect(fatal.reasons[0]).toBe("The Claude API rejected the API key.");
  });

  it("says when a fallback model wrote replies or judged, without failing the run for it", () => {
    const verdict = verdictOf(run(IDS.map((id) => rowWith(id))), "live", {
      servedByOther: { engine: 2, judge: 1 },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(" ")).toContain(
      "In 2 conversations a reply was written by a fallback model",
    );
    expect(verdict.notes.join(" ")).toContain("1 conversations were judged by a fallback model");
  });

  it("fails any run in which a dry run wrote to the database", () => {
    const verdict = verdictOf(run(IDS.map((id) => rowWith(id))), "live", {
      turnRowCounts: { conversations: 0, messages: 2, leads: 1 },
    });
    expect(verdict.exitCode).toBe(1);
    expect(verdict.reasons[0]).toContain("A dry run wrote to the database (messages: 2, leads: 1)");
  });

  it("calls a mock run what it is, pass or fail", () => {
    const mockRows = IDS.map((id) => rowWith(id, { mode: "mock", scores: null, costUsd: null }));
    const passed = verdictOf(run(mockRows, "mock"), "mock");
    expect(passed).toMatchObject({ ok: true, exitCode: 0, headline: "HARNESS CHECK PASSED" });
    expect(passed.notes).toEqual([MOCK_NOTICE]);
    expect(passed.reasons[0]).not.toMatch(/quality|score/i);
    const broken = verdictOf(
      run(
        [
          ...mockRows.slice(1),
          rowWith(IDS[0] ?? "", {
            mode: "mock",
            scores: null,
            costUsd: null,
            failures: [
              { kind: "check", id: "reply_length", criterion: "setting_compliance", detail: "x" },
            ],
          }),
        ],
        "mock",
      ),
      "mock",
    );
    expect(broken).toMatchObject({ ok: false, exitCode: 1 });
    expect(broken.reasons[0]).toContain("broke a rule the engine enforces in code");
  });
});
