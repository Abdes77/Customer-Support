import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS } from "../grade/rubric";
import type { ErrorRow, ResultRow, RunManifest, TranscriptFile } from "../run/store";
import { summarizeRun } from "../run/summary";
import { decideVerdict } from "../run/verdict";
import { rowWith } from "../testing/rows";
import { botSays, customerSays, did, scenarioWith, transcriptOf } from "../testing/transcripts";
import { esc, renderReport } from "./html";
import { renderSummaryMarkdown } from "./markdown";

const ATTACK = `<script>alert("x")</script><img src=x onerror=alert(1)>`;

function report(
  mode: "live" | "mock",
  rows: ResultRow[],
  errors: ErrorRow[] = [],
  ids = rows.map((row) => row.scenarioId),
) {
  const manifest: RunManifest = {
    id: "20261112-100000-test",
    mode,
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:20:00.000Z",
    models: { engine: "claude-fable-5-2", customer: "claude-opus-5-5", judge: "claude-opus-5-5" },
    reps: 1,
    concurrency: 6,
    thresholds: DEFAULT_THRESHOLDS,
    scenarioIds: ids,
    selection: `${ids.length} of 72 scenarios`,
  };
  const { summary, scenarios } = summarizeRun({
    mode,
    rows,
    errors,
    expected: ids.map((scenarioId) => ({ scenarioId, rep: 0 })),
  });
  const verdict = decideVerdict({
    mode,
    summary,
    scenarios,
    comparison: null,
    baselineStatus: "missing",
    turnRowCounts: {},
    fatal: null,
  });
  const transcripts = new Map<string, TranscriptFile>();
  for (const row of rows) {
    const scenario = scenarioWith({ suite: row.suite as never, persona: row.persona as never });
    transcripts.set(`${row.scenarioId}#${row.rep}`, {
      scenarioId: row.scenarioId,
      rep: row.rep,
      row,
      transcript: transcriptOf(scenario, [
        customerSays(1, [`my roof leaks ${ATTACK}`]),
        botSays(1, [`Sorry to hear that ${ATTACK}. What's the ZIP code?`], {
          actions: [
            did({
              type: "update_lead_fields",
              fields: [
                { key: "service_type", value: `leak ${ATTACK}`, confidence: 1, evidence: null },
              ],
            }),
          ],
          diagnostics: { guardViolations: ["disclosure_added"] },
        }),
        {
          kind: "event",
          at: "2026-11-03T18:00:00.000Z",
          event: "customer_silent",
          note: `quiet ${ATTACK}`,
        },
      ]),
    });
  }
  const html = renderReport({
    manifest,
    summary,
    scenarios,
    rows,
    errors,
    transcripts,
    comparison: null,
    verdict,
    thresholds: DEFAULT_THRESHOLDS,
    promptVersion: "reply-v1.r2",
  });
  return { html, summary, verdict, manifest };
}

describe("renderReport", () => {
  const failing = rowWith("roofing.price_shopper", {
    scores: { accuracy: 2, engagement: 3 },
    complianceFailures: 1,
    failures: [
      {
        kind: "claim",
        id: "price",
        criterion: "accuracy",
        detail: `Stated without support (price): "about $900 ${ATTACK}".`,
      },
      {
        kind: "rule",
        id: "pricing",
        criterion: "setting_compliance",
        detail: 'Rule "pricing" was not followed: gave a number.',
      },
    ],
  });
  const rows = [
    rowWith("roofing.ready_to_book"),
    failing,
    {
      ...rowWith("hvac.spam", { scores: { qualification: null, engagement: null } }),
      judge: { ...rowWith("hvac.spam").judge, summary: `Fine ${ATTACK}` },
    },
  ];

  it("escapes everything a customer, the bot or a model wrote", () => {
    const { html } = report("live", rows);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    // It appears, escaped, where each of them wrote it: the customer, the bot, a saved field,
    // a harness note, a failure and the judge's summary.
    expect(html.split("&lt;script&gt;").length - 1).toBeGreaterThanOrEqual(6);
    expect(esc(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;");
    expect(html.match(/<script/gi)).toBeNull();
  });

  it("leads with the verdict and the numbers, then what failed, then every conversation", () => {
    const { html } = report("live", rows);
    const order = [
      "Reply bot evaluation",
      "FAILED",
      "Scenarios passed",
      "Scores by criterion",
      "By kind of customer and trade",
      "What failed",
      "Settings the bot ran under",
      "Every conversation",
    ].map((heading) => html.indexOf(heading));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("2 of 3");
    expect(html).toContain("Accuracy against business knowledge");
    // A failing conversation is first and opened; a passing one is closed.
    const first = html.indexOf('id="c-roofing-price-shopper"');
    const second = html.indexOf('id="c-roofing-ready-to-book"');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(html).toMatch(/id="c-roofing-price-shopper" open>/);
    expect(html).toMatch(/id="c-roofing-ready-to-book">/);
    // The grid links to the conversation, and says pass or fail in words, not only in color.
    expect(html).toContain('href="#c-roofing-price-shopper"');
    expect(html).toMatch(
      /status-critical"><span class="status-icon" aria-hidden="true">✕<\/span>fail/,
    );
    expect(html).toMatch(/status-good"><span class="status-icon" aria-hidden="true">✓<\/span>pass/);
  });

  it("shows what the bot did behind a reply and what the guard changed", () => {
    const { html } = report("live", rows);
    expect(html).toContain("Bot did: saved lead fields: service_type =");
    expect(html).toContain("The output guard stepped in: disclosure added");
    expect(html).toContain("n/a");
  });

  it("is one file with no script and no outside resource", () => {
    const { html } = report("live", rows);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<link|src="http|url\(http|@import/i);
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("lists conversations that could not be played apart from the scores", () => {
    const errors: ErrorRow[] = [
      {
        scenarioId: "hvac.renter",
        rep: 0,
        class: "serving",
        message: "The Claude API answered 529.",
        at: "2026-11-12T10:05:00.000Z",
        durationMs: 5,
      },
    ];
    const { html, verdict } = report("live", rows.slice(0, 1), errors, [
      "roofing.ready_to_book",
      "hvac.renter",
    ]);
    expect(verdict.headline).toBe("INCOMPLETE");
    expect(html).toContain("Not played or judged");
    expect(html).toContain("The Claude API answered 529.");
    expect(html).toContain("no result");
  });

  it("shows no scores for a mock run and says what it is at the top", () => {
    const mock = ["roofing.ready_to_book", "roofing.renter"].map((id) =>
      rowWith(id, { mode: "mock", scores: null, costUsd: null }),
    );
    const { html } = report("mock", mock);
    expect(html).toContain("HARNESS CHECK PASSED");
    expect(html).toContain("MOCK RUN.");
    expect(html.indexOf("MOCK RUN.")).toBeLessThan(html.indexOf("By kind of customer and trade"));
    expect(html).not.toContain("Scores by criterion");
    expect(html).not.toContain("Mean overall score");
    expect(html).not.toContain("Cost of this run");
    expect(html).toContain("Not judged: this conversation was played and judged by stand-ins.");
    expect(html).toContain("Conversations without a broken rule");
    // Nothing was judged, so nothing is called a pass: a neutral mark and "ran".
    expect(html).toMatch(
      /status-neutral"><span class="status-icon" aria-hidden="true">✓<\/span>ran/,
    );
    expect(html).not.toMatch(/<\/span>pass</);
    expect(html).not.toContain('class="cell-good"');
  });
});

describe("renderSummaryMarkdown", () => {
  it("is the verdict, the numbers and the failures in a few lines", () => {
    const rows = [
      rowWith("roofing.ready_to_book"),
      rowWith("roofing.renter", {
        scores: 3,
        failures: [
          {
            kind: "score",
            id: "overall",
            criterion: null,
            detail: "Overall 3.00, below the pass score of 4.",
          },
        ],
      }),
    ];
    const { summary, verdict, manifest } = report("live", rows);
    const markdown = renderSummaryMarkdown({ manifest, summary, rows, comparison: null, verdict });
    expect(markdown).toContain("## Reply bot evaluation: FAILED");
    expect(markdown).toContain("| Scenarios passed | 1 of 2 |");
    expect(markdown).toContain("| Mean overall score | 4.00 of 5");
    expect(markdown).toContain("| Correct routing | 4.00 | – |");
    expect(markdown).toContain("- `roofing.renter`: Overall 3.00, below the pass score of 4.");
  });
});
