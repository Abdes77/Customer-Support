import { describeAction } from "../grade/judge";
import {
  CRITERIA,
  type Criterion,
  CRITERION_QUESTIONS,
  CRITERION_TITLES,
  MAX_SCORE,
  type Thresholds,
} from "../grade/rubric";
import type { Comparison } from "../run/baseline";
import type { ErrorRow, ResultRow, RunManifest, TranscriptFile } from "../run/store";
import type { RunSummary, ScenarioAggregate } from "../run/summary";
import type { Verdict } from "../run/verdict";
import { EVAL_BUSINESSES, EVAL_SEGMENTS, type EvalSegment } from "../fixtures/businesses";
import { PERSONAS } from "../scenarios/personas";
import { SETTINGS_PROFILES } from "../scenarios/profiles";
import { PERSONA_IDS, type PersonaId, type ProfileId } from "../scenarios/types";
import type { TranscriptEntry } from "../simulate/transcript";

/**
 * The report an agency reads: one self-contained HTML file, no scripts, no network. It
 * leads with the verdict, shows where the bot is weak (by criterion, by kind of customer,
 * by trade), lists what failed with the evidence, and then every conversation as a chat
 * with what the bot did behind each reply.
 *
 * Every piece of text that comes from a conversation, a model or a fixture goes through
 * `esc`: customers in these conversations write whatever they like, including markup.
 */

export interface ReportInput {
  readonly manifest: RunManifest;
  readonly summary: RunSummary;
  readonly scenarios: readonly ScenarioAggregate[];
  readonly rows: readonly ResultRow[];
  readonly errors: readonly ErrorRow[];
  readonly transcripts: ReadonlyMap<string, TranscriptFile>;
  readonly comparison: Comparison | null;
  readonly verdict: Verdict;
  readonly thresholds: Thresholds;
  readonly promptVersion: string;
}

export function esc(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value === null || value === undefined
          ? ""
          : JSON.stringify(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const anchor = (scenarioId: string) => `c-${scenarioId.replaceAll(/[^a-z0-9]+/gi, "-")}`;
const words = (id: string) => id.replaceAll("_", " ");
const score = (value: number | null) => (value === null ? "–" : value.toFixed(2));
const usd = (value: number) =>
  value >= 100
    ? `$${value.toFixed(0)}`
    : value >= 1
      ? `$${value.toFixed(2)}`
      : `$${value.toFixed(3)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function when(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(iso));
}

function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

type StatusKind = "good" | "critical" | "warning" | "neutral" | "none";

/** A status with its icon and its word: never color alone. */
function status(kind: StatusKind, label: string): string {
  const icon = { good: "✓", critical: "✕", warning: "!", neutral: "✓", none: "–" }[kind];
  return `<span class="status status-${kind}"><span class="status-icon" aria-hidden="true">${icon}</span>${esc(label)}</span>`;
}

const STYLE = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --hairline: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --accent: #2a78d6; --accent-track: #cde2fb; --wash: #f0efec;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b;
  --good-wash: #e7f6e7; --critical-wash: #fbeaea; --warning-wash: #fef3d6;
  --bot-wash: #eaf2fd; --customer-wash: #f0efec;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --hairline: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --accent: #3987e5; --accent-track: #0d366b; --wash: #262624;
    --good-wash: #12301a; --critical-wash: #3a1a1a; --warning-wash: #3a2e0c;
    --bot-wash: #14263d; --customer-wash: #262624;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 40px 0 6px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
p { margin: 6px 0; }
a { color: inherit; }
.lede, .note { color: var(--ink-2); }
.small { font-size: 13px; color: var(--ink-2); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 20px; font-size: 13px; color: var(--ink-2); margin-top: 8px; }
.verdict { margin-top: 20px; border-left: 6px solid var(--axis); }
.verdict.ok { border-left-color: var(--good); }
.verdict.bad { border-left-color: var(--critical); }
.verdict.incomplete { border-left-color: var(--warning); }
.verdict h2 { margin: 0 0 6px; font-size: 22px; }
.verdict ul { margin: 6px 0 0; padding-left: 20px; }
.mock { margin-top: 16px; background: var(--warning-wash); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 16px; }
.tile .label { font-size: 13px; color: var(--ink-2); }
.tile .value { font-size: 28px; font-weight: 600; line-height: 1.2; margin-top: 2px; }
.tile .sub { font-size: 13px; color: var(--ink-2); }
.status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.status-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; font-size: 12px; font-weight: 700; color: #ffffff; background: var(--muted); }
.status-good .status-icon { background: var(--good); }
.status-critical .status-icon { background: var(--critical); }
.status-warning .status-icon { background: var(--warning); color: #0b0b0b; }
.meters { display: grid; gap: 14px; }
.meter-row { display: grid; grid-template-columns: minmax(180px, 280px) 1fr auto; gap: 6px 16px; align-items: center; }
@media (max-width: 640px) {
  .meter-row { grid-template-columns: 1fr auto; }
  .meter-row .meter { grid-column: 1 / -1; grid-row: 2; }
}
.meters .name { font-weight: 600; }
.meters .ask { font-size: 13px; color: var(--ink-2); font-weight: 400; }
.meter { position: relative; height: 8px; border-radius: 4px; background: var(--accent-track); }
.meter .fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }
.meter .mark { position: absolute; top: -4px; width: 2px; height: 16px; background: var(--ink); }
.meters .figure { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
th { font-weight: 600; color: var(--ink-2); font-size: 13px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.grid td { text-align: center; white-space: nowrap; padding: 4px 6px; }
.grid thead th { text-align: center; white-space: normal; }
.grid th.row { text-align: left; font-weight: 400; color: var(--ink); }
.grid a { display: block; text-decoration: none; border-radius: 6px; padding: 4px 6px; }
.grid a:hover, .grid a:focus { outline: 2px solid var(--accent); }
.cell-good { background: var(--good-wash); }
.cell-critical { background: var(--critical-wash); }
.cell-none { background: var(--wash); color: var(--ink-2); }
.cell-score { font-variant-numeric: tabular-nums; font-weight: 600; }
details.conversation { margin-top: 10px; }
details.conversation > summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
details.conversation > summary .title { font-weight: 600; }
.chat { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.bubble { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble .who { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 2px; }
.bubble.customer { align-self: flex-start; background: var(--customer-wash); }
.bubble.bot { align-self: flex-end; background: var(--bot-wash); }
.did, .event { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.did { align-self: flex-end; max-width: 78%; text-align: right; }
.event { align-self: center; text-align: center; border-top: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); padding: 4px 12px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
ul.plain { margin: 4px 0; padding-left: 18px; }
code { font-size: 13px; }
`;

function verdictBlock(verdict: Verdict): string {
  const kind = verdict.ok ? "ok" : verdict.exitCode === 3 ? "incomplete" : "bad";
  const mark = verdict.ok ? "good" : verdict.exitCode === 3 ? "warning" : "critical";
  return `<section class="card verdict ${kind}">
  <h2>${status(mark, verdict.headline)}</h2>
  <ul>${verdict.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>
</section>
${verdict.notes.map((note) => `<p class="mock">${esc(note)}</p>`).join("\n")}`;
}

/**
 * How a conversation's result is shown. In a live run it passed or failed. In a mock run
 * nothing was judged, so "pass" would claim too much: it ran, or it broke a rule the engine
 * enforces in code. A neutral mark, not a green one.
 */
function outcome(mode: RunSummary["mode"], passed: boolean): { kind: StatusKind; label: string } {
  if (mode === "live")
    return passed ? { kind: "good", label: "pass" } : { kind: "critical", label: "fail" };
  return passed ? { kind: "neutral", label: "ran" } : { kind: "critical", label: "rule broken" };
}

function tile(label: string, value: string, sub: string): string {
  return `<div class="card tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function tiles(input: ReportInput): string {
  const { summary, thresholds } = input;
  const live = summary.mode === "live";
  const items = [
    tile(
      live ? "Scenarios passed" : "Conversations without a broken rule",
      `${summary.passed} of ${summary.scenarios}`,
      live
        ? `pass score ${thresholds.passScore} of ${MAX_SCORE}`
        : "rules the engine enforces in code",
    ),
    ...(live && summary.overall !== null
      ? [
          tile(
            "Mean overall score",
            `${summary.overall.mean.toFixed(2)} / ${MAX_SCORE}`,
            summary.overall.halfWidth === null
              ? "one scenario"
              : `± ${summary.overall.halfWidth.toFixed(2)} (95% interval over scenarios)`,
          ),
        ]
      : []),
    tile(
      "Setting-compliance failures",
      String(summary.complianceFailures),
      live ? "the target is zero" : "code-enforced rules only",
    ),
    tile(
      "Not played or judged",
      String(summary.unresolved.length),
      summary.unresolved.length === 0 ? "every conversation has a result" : "not scored; see below",
    ),
    ...(summary.costUsd === null
      ? []
      : [
          tile(
            "Cost of this run",
            usd(summary.costUsd.total),
            `bot ${usd(summary.costUsd.engine)}, customers ${usd(summary.costUsd.customer)}, judge ${usd(summary.costUsd.judge)} at list prices`,
          ),
        ]),
    // Stand-ins answer in no time; a zero here would not be a measurement.
    ...(live && summary.replyLatencyMs !== null && summary.replyLatencyMs.mean > 0
      ? [
          tile(
            "Time to write a reply",
            seconds(summary.replyLatencyMs.mean),
            `model time per reply; slowest ${seconds(summary.replyLatencyMs.max)}`,
          ),
        ]
      : []),
  ];
  return `<div class="tiles">${items.join("")}</div>`;
}

function criteriaBlock(input: ReportInput): string {
  const { summary, comparison, thresholds } = input;
  if (summary.mode !== "live") return "";
  const rows = CRITERIA.map((criterion) => {
    const { mean, scenarios } = summary.criteria[criterion];
    const before = comparison?.criteria[criterion].baseline ?? null;
    const now = comparison?.criteria[criterion].current ?? null;
    const delta = before === null || now === null ? null : now - before;
    const fill = mean === null ? 0 : ((mean - 1) / (MAX_SCORE - 1)) * 100;
    const mark =
      before === null
        ? ""
        : `<span class="mark" style="left:${(((before - 1) / (MAX_SCORE - 1)) * 100).toFixed(1)}%" title="Baseline ${before.toFixed(2)}"></span>`;
    return `<div class="meter-row"><div class="name">${esc(CRITERION_TITLES[criterion])}<div class="ask">${esc(CRITERION_QUESTIONS[criterion])}</div></div>
<div class="meter" role="img" aria-label="${esc(CRITERION_TITLES[criterion])}: ${score(mean)} of ${MAX_SCORE}"><span class="fill" style="width:${fill.toFixed(1)}%"></span>${mark}</div>
<div class="figure"><strong>${score(mean)}</strong> / ${MAX_SCORE}${
      delta === null
        ? ""
        : ` <span class="small">(${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} vs baseline)</span>`
    }<div class="small">${scenarios} scenarios, floor ${thresholds.floors[criterion]}</div></div></div>`;
  });
  return `<h2>Scores by criterion</h2>
<p class="lede">Each conversation is scored from 1 to ${MAX_SCORE} on seven criteria by a judge model. The bar runs from 1 to ${MAX_SCORE}${comparison === null ? "" : "; the vertical mark is the saved baseline"}.</p>
<div class="card"><div class="meters">${rows.join("\n")}</div></div>`;
}

function gridBlock(input: ReportInput): string {
  const { scenarios, summary } = input;
  const byId = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const unresolved = new Set(summary.unresolved.map((key) => key.split("#")[0]));
  const suites = EVAL_SEGMENTS.filter(
    (segment) =>
      scenarios.some((scenario) => scenario.suite === segment) ||
      [...unresolved].some((id) => id?.startsWith(`${segment}.`)),
  );
  const cell = (personaId: PersonaId, segment: EvalSegment): string => {
    const id = `${segment}.${personaId}`;
    const scenario = byId.get(id);
    if (scenario === undefined) {
      return unresolved.has(id)
        ? `<td class="cell-none" title="Not played or judged">${status("warning", "no result")}</td>`
        : `<td class="cell-none">–</td>`;
    }
    const { kind, label } = outcome(summary.mode, scenario.passed);
    const figure =
      scenario.overall === null
        ? ""
        : `<span class="cell-score">${scenario.overall.toFixed(2)}</span> `;
    return `<td class="cell-${kind === "neutral" ? "none" : kind}"><a href="#${anchor(id)}" title="${esc(`${PERSONAS[personaId].title} at ${EVAL_BUSINESSES[segment].name}: ${label}${scenario.overall === null ? "" : `, ${scenario.overall.toFixed(2)} of ${MAX_SCORE}`}`)}">${figure}${status(kind, label)}</a></td>`;
  };
  const group = (key: string, groups: RunSummary["byPersona"]) => {
    const entry = groups[key];
    return entry === undefined
      ? "<td>–</td>"
      : `<td class="num">${entry.passed}/${entry.scenarios}${entry.mean === null ? "" : ` · ${entry.mean.toFixed(2)}`}</td>`;
  };
  return `<h2>By kind of customer and trade</h2>
<p class="lede">One conversation per cell. Select a cell to read it.${summary.mode === "live" ? "" : ' In a mock run "ran" means only that the conversation finished without breaking a rule the engine enforces in code.'}</p>
<div class="card scroll"><table class="grid">
<thead><tr><th class="row">Customer</th>${suites.map((segment) => `<th>${esc(EVAL_BUSINESSES[segment].segmentName)}</th>`).join("")}<th class="num">${summary.mode === "live" ? "Passed · mean" : "No rule broken"}</th></tr></thead>
<tbody>
${PERSONA_IDS.map(
  (personaId) =>
    `<tr><th class="row">${esc(PERSONAS[personaId].title)}</th>${suites.map((segment) => cell(personaId, segment)).join("")}${group(personaId, summary.byPersona)}</tr>`,
).join("\n")}
<tr><th class="row">All customers</th>${suites.map((segment) => group(segment, summary.bySuite)).join("")}<td class="num">${summary.passed}/${summary.scenarios}</td></tr>
</tbody></table></div>`;
}

function failuresBlock(input: ReportInput): string {
  const { rows, errors, summary } = input;
  const failing = rows.filter((row) => !row.grade.passed);
  const parts: string[] = [];
  if (failing.length > 0) {
    parts.push(`<div class="card scroll"><table>
<thead><tr><th>Conversation</th><th>What failed</th></tr></thead><tbody>
${failing
  .map(
    (row) =>
      `<tr><td><a href="#${anchor(row.scenarioId)}">${esc(row.scenarioId)}</a>${row.rep > 0 ? ` <span class="small">run ${row.rep + 1}</span>` : ""}<div class="small">${esc(SETTINGS_PROFILES[row.profile as ProfileId]?.title ?? row.profile)}, ${esc(row.channel)}</div></td><td><ul class="plain">${row.grade.failures.map((failure) => `<li>${esc(failure.detail)}</li>`).join("")}</ul></td></tr>`,
  )
  .join("\n")}
</tbody></table></div>`);
  }
  if (summary.failedChecks.length > 0) {
    parts.push(`<h3>Rules that were broken, by how often</h3>
<div class="card scroll"><table><thead><tr><th>Rule</th><th class="num">Conversations</th></tr></thead><tbody>
${summary.failedChecks.map((check) => `<tr><td>${esc(check.title)}</td><td class="num">${check.conversations}</td></tr>`).join("\n")}
</tbody></table></div>`);
  }
  const open = new Set(summary.unresolved);
  const unresolved = errors.filter((error) => open.has(`${error.scenarioId}#${error.rep}`));
  if (unresolved.length > 0) {
    parts.push(`<h3>Not played or judged</h3>
<p class="lede">These conversations produced nothing to grade, for reasons that are not the bot's. They are not scored. Run again with <code>--resume</code> to finish them.</p>
<div class="card scroll"><table><thead><tr><th>Conversation</th><th>Cause</th><th>What happened</th></tr></thead><tbody>
${unresolved.map((error) => `<tr><td>${esc(error.scenarioId)}</td><td>${esc(error.class)}</td><td>${esc(error.message)}</td></tr>`).join("\n")}
</tbody></table></div>`);
  }
  if (parts.length === 0) return "";
  return `<h2>What failed</h2>\n${parts.join("\n")}`;
}

function profilesBlock(input: ReportInput): string {
  const used = [...new Set(input.rows.map((row) => row.profile))] as ProfileId[];
  if (used.length === 0) return "";
  return `<h2>Settings the bot ran under</h2>
<p class="lede">Every conversation runs under one of these configurations of a business, on top of the defaults and the trade's preset.</p>
<div class="card scroll"><table><thead><tr><th>Profile</th><th>What it sets</th><th class="num">${input.summary.mode === "live" ? "Passed" : "No rule broken"}</th></tr></thead><tbody>
${used
  .map((id) => {
    const profile = SETTINGS_PROFILES[id];
    const group = input.summary.byProfile[id];
    return `<tr><td>${esc(profile?.title ?? id)}</td><td>${esc(profile?.summary ?? "")}</td><td class="num">${group === undefined ? "–" : `${group.passed}/${group.scenarios}`}</td></tr>`;
  })
  .join("\n")}
</tbody></table></div>`;
}

function chat(entries: readonly TranscriptEntry[], timezone: string): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "customer") {
      for (const message of entry.messages) {
        parts.push(
          `<div class="bubble customer"><span class="who">Customer · ${esc(localTime(entry.at, timezone))}${entry.source === "opening" || entry.source === "scripted" ? " · fixed line" : ""}</span>${esc(message.text ?? "")}${message.photo === undefined ? "" : `<span class="who">Photo: ${esc(message.photo)}</span>`}</div>`,
        );
      }
    } else if (entry.kind === "bot") {
      for (const executed of entry.actions) {
        parts.push(`<div class="did">Bot did: ${esc(describeAction(executed))}</div>`);
      }
      if (entry.replies.length === 0) {
        parts.push(
          `<div class="did">${esc(entry.outcome === "refused" ? "The model declined to answer; a person has to take over." : entry.outcome === "failed" ? "The bot failed to produce a reply." : "The bot sent nothing.")}</div>`,
        );
      }
      for (const reply of entry.replies) {
        parts.push(
          `<div class="bubble bot"><span class="who">Bot${entry.trigger === "follow_up" ? ` · follow-up · ${esc(localTime(entry.at, timezone))}` : ""}${reply.subject === undefined || reply.subject === null ? "" : ` · subject: ${esc(reply.subject)}`}</span>${esc(reply.text)}${reply.quickReplies === undefined || reply.quickReplies.length === 0 ? "" : `<span class="who">Buttons: ${esc(reply.quickReplies.join(" | "))}</span>`}</div>`,
        );
      }
      const notes = entry.diagnostics?.guardViolations ?? [];
      if (notes.length > 0) {
        parts.push(
          `<div class="did">The output guard stepped in: ${esc(notes.map(words).join(", "))}</div>`,
        );
      }
    } else {
      parts.push(`<div class="event">${esc(entry.note)}</div>`);
    }
  }
  return `<div class="chat">${parts.join("\n")}</div>`;
}

function conversationBlock(input: ReportInput, row: ResultRow): string {
  const [segment, personaId] = row.scenarioId.split(".") as [EvalSegment, PersonaId];
  const business = EVAL_BUSINESSES[segment];
  const persona = PERSONAS[personaId];
  const file = input.transcripts.get(`${row.scenarioId}#${row.rep}`);
  const live = row.grade.mode === "live";
  const failedChecks = row.checks.filter((check) => !check.passed);
  const routingWords = (value: string | null) => (value === null ? "no decision" : words(value));

  const criteria = live
    ? `<table><thead><tr><th>Criterion</th><th class="num">Score</th><th>Judge's reason</th></tr></thead><tbody>
${CRITERIA.map((criterion: Criterion) => {
  const value = row.grade.scores[criterion];
  const given = row.judge.scores[criterion];
  // Evidence (a failed check, a rule violation, an invented claim) caps a score.
  const capped =
    value !== null && value !== given
      ? `<div class="small">The judge gave ${given ?? "n/a"}; lowered because of the evidence listed under "What failed".</div>`
      : "";
  return `<tr><td>${esc(CRITERION_TITLES[criterion])}</td><td class="num">${value ?? "n/a"}</td><td>${esc(row.judge.reasons[criterion])}${capped}</td></tr>`;
}).join("\n")}
</tbody></table>`
    : `<p class="note">Not judged: this conversation was played and judged by stand-ins.</p>`;

  const evidence = [
    ...row.grade.failures.map((failure) => `<li>${esc(failure.detail)}</li>`),
    ...failedChecks
      .filter((check) => !row.grade.failures.some((failure) => failure.id === check.id))
      .map(
        (check) =>
          `<li><span class="small">Not counted in a mock run (it depends on the model):</span> ${esc(check.title)}: ${esc(check.detail ?? "")}</li>`,
      ),
  ];

  return `<details class="card conversation" id="${anchor(row.scenarioId)}"${row.grade.passed ? "" : " open"}>
<summary><span class="title">${esc(persona?.title ?? personaId)} · ${esc(business?.name ?? segment)}</span>
${status(outcome(row.grade.mode, row.grade.passed).kind, outcome(row.grade.mode, row.grade.passed).label)}
${row.grade.overall === null ? "" : `<span>${row.grade.overall.toFixed(2)} / ${MAX_SCORE}</span>`}
<span class="small">${esc(row.scenarioId)}${row.rep > 0 ? `, run ${row.rep + 1}` : ""} · ${esc(SETTINGS_PROFILES[row.profile as ProfileId]?.title ?? row.profile)} · ${esc(row.channel)} · ${row.customerTurns} customer turns</span></summary>
<p class="lede">${esc(persona?.summary ?? "")}</p>
${evidence.length === 0 ? "" : `<h3>What failed</h3><ul class="plain">${evidence.join("")}</ul>`}
<div class="cols">
<div><h3>Scores</h3>${criteria}${live && row.judge.summary.length > 0 ? `<p>${esc(row.judge.summary)}</p>` : ""}</div>
<div><h3>Outcome</h3>
<ul class="plain">
<li>Ended: ${esc(words(row.ended))}${row.leaveReason === null ? "" : ` (customer: ${esc(words(row.leaveReason))})`}</li>
<li>Lead: ${esc(words(row.lead.status))}; routing ${esc(routingWords(row.lead.routing))}${row.expectedRouting === null ? "" : `; the business's rules give ${esc(row.expectedRouting.map(routingWords).join(" or "))}`}</li>
<li>Recorded: ${esc(row.lead.fields.length === 0 ? "nothing" : row.lead.fields.join(", "))}</li>
<li>Replies written by: ${esc(row.models.engine.join(", ") || "no model")}${row.costUsd.engine === null ? "" : `, ${usd((row.costUsd.engine ?? 0) + (row.costUsd.customer ?? 0) + (row.costUsd.judge ?? 0))} for this conversation`}</li>
</ul>
${
  live && row.judge.discarded.length > 0
    ? `<p class="small">${row.judge.discarded.length} finding${row.judge.discarded.length === 1 ? "" : "s"} of the judge ${row.judge.discarded.length === 1 ? "was" : "were"} not counted because the quoted words are not in the conversation.</p>`
    : ""
}</div>
</div>
<h3>Conversation</h3>
${file === undefined ? `<p class="note">The transcript file is missing.</p>` : chat(file.transcript.entries, business?.timezone ?? "UTC")}
</details>`;
}

export function renderReport(input: ReportInput): string {
  const { manifest, summary, rows } = input;
  // Failures first, then by suite and persona order.
  const order = new Map<string, number>(
    EVAL_SEGMENTS.flatMap((segment, s) =>
      PERSONA_IDS.map((personaId, p): [string, number] => [`${segment}.${personaId}`, s * 100 + p]),
    ),
  );
  const sorted = [...rows].sort(
    (a, b) =>
      Number(a.grade.passed) - Number(b.grade.passed) ||
      (order.get(a.scenarioId) ?? 0) - (order.get(b.scenarioId) ?? 0) ||
      a.rep - b.rep,
  );
  const title = `Evaluation report · ${manifest.id}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Reply bot evaluation</h1>
<p class="lede">Simulated customers wrote to six made-up businesses; the bot answered them exactly as it would answer real ones, with nothing sent and nothing stored. This report says how those conversations went.</p>
<div class="meta">
<span>Run ${esc(manifest.id)}</span>
<span>${esc(when(manifest.startedAt))} UTC</span>
<span>${esc(manifest.selection)}</span>
<span>Bot: ${esc(manifest.models.engine)}</span>
<span>Customers: ${esc(manifest.models.customer)}</span>
<span>Judge: ${esc(manifest.models.judge)}</span>
${input.promptVersion.length === 0 ? "" : `<span>Prompt ${esc(input.promptVersion)}</span>`}
</div>
${verdictBlock(input.verdict)}
${tiles(input)}
${criteriaBlock(input)}
${gridBlock(input)}
${failuresBlock(input)}
${profilesBlock(input)}
<h2>Every conversation</h2>
<p class="lede">${summary.conversations} conversations, the ones that did not pass first. Grey lines on the right are what the bot did behind a reply; the customer never sees them.</p>
${sorted.map((row) => conversationBlock(input, row)).join("\n")}
</main>
</body>
</html>
`;
}
