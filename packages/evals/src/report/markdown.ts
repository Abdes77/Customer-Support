import { CRITERIA, CRITERION_TITLES, MAX_SCORE } from "../grade/rubric";
import type { Comparison } from "../run/baseline";
import type { ResultRow, RunManifest } from "../run/store";
import type { RunSummary } from "../run/summary";
import type { Verdict } from "../run/verdict";

/**
 * The run as a few lines of Markdown, for a pull request check or a terminal: the verdict,
 * the numbers, and what failed. The HTML report has the conversations.
 */
export function renderSummaryMarkdown(input: {
  readonly manifest: RunManifest;
  readonly summary: RunSummary;
  readonly rows: readonly ResultRow[];
  readonly comparison: Comparison | null;
  readonly verdict: Verdict;
}): string {
  const { manifest, summary, rows, comparison, verdict } = input;
  const live = summary.mode === "live";
  const lines: string[] = [
    `## Reply bot evaluation: ${verdict.headline}`,
    "",
    ...verdict.reasons.map((reason) => `- ${reason}`),
    ...verdict.notes.map((note) => `- _${note}_`),
    "",
    `Run \`${manifest.id}\` (${manifest.mode}): ${manifest.selection}. Bot ${manifest.models.engine}, customers ${manifest.models.customer}, judge ${manifest.models.judge}.`,
    "",
    "| | |",
    "| --- | --- |",
    `| ${live ? "Scenarios passed" : "Conversations without a broken rule"} | ${summary.passed} of ${summary.scenarios} |`,
    ...(live && summary.overall !== null
      ? [
          `| Mean overall score | ${summary.overall.mean.toFixed(2)} of ${MAX_SCORE}${summary.overall.halfWidth === null ? "" : ` (± ${summary.overall.halfWidth.toFixed(2)})`} |`,
        ]
      : []),
    `| Setting-compliance failures | ${summary.complianceFailures} |`,
    `| Not played or judged | ${summary.unresolved.length} |`,
    ...(summary.costUsd === null
      ? []
      : [`| Cost at list prices | $${summary.costUsd.total.toFixed(2)} |`]),
  ];
  if (live) {
    lines.push("", "| Criterion | Mean | Baseline |", "| --- | --- | --- |");
    for (const criterion of CRITERIA) {
      const mean = summary.criteria[criterion].mean;
      const before = comparison?.criteria[criterion].baseline ?? null;
      lines.push(
        `| ${CRITERION_TITLES[criterion]} | ${mean === null ? "n/a" : mean.toFixed(2)} | ${before === null ? "–" : before.toFixed(2)} |`,
      );
    }
  }
  const failing = rows.filter((row) => !row.grade.passed);
  if (failing.length > 0) {
    lines.push("", "### What failed", "");
    for (const row of failing.slice(0, 25)) {
      lines.push(
        `- \`${row.scenarioId}\`: ${row.grade.failures
          .slice(0, 3)
          .map((failure) => failure.detail.replaceAll("\n", " "))
          .join(" · ")}`,
      );
    }
    if (failing.length > 25) lines.push(`- ... and ${failing.length - 25} more (see report.html)`);
  }
  return `${lines.join("\n")}\n`;
}
