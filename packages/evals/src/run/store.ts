import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RoutingOutcome } from "@repo/core";

import type { CheckResult } from "../grade/checks";
import type { DiscardedFinding, RuleVerdict, UnsupportedClaim } from "../grade/judge";
import type { Criterion, Thresholds } from "../grade/rubric";
import type { RunMode, ScenarioGrade } from "../grade/score";
import type { EndReason, Transcript, Usage } from "../simulate/transcript";
import type { FailureClass } from "./retry";

/**
 * Where a run keeps its results:
 *
 *   <dir>/run.json                         what was run, with which models and thresholds
 *   <dir>/results.jsonl                    one line per graded conversation (scenario, rep)
 *   <dir>/errors.jsonl                     one line per attempt that produced nothing to grade
 *   <dir>/transcripts/<scenario>.rep<k>.json   the whole conversation, every action, the verdict
 *   <dir>/report.html, summary.md          for people
 *
 * A row is appended as its conversation finishes, so a crash loses nothing that was done,
 * and a resumed run plays only what has no row yet. An attempt that failed for reasons that
 * are not the bot's (the API, a time limit, the harness) never gets a row: it goes to
 * `errors.jsonl`, where it can neither count as a score nor stop the resume from trying again.
 */

export interface ResultRow {
  readonly scenarioId: string;
  readonly suite: string;
  readonly persona: string;
  readonly profile: string;
  readonly channel: string;
  readonly rep: number;
  readonly grade: ScenarioGrade;
  readonly checks: readonly CheckResult[];
  readonly judge: {
    readonly model: string;
    readonly standIn: boolean;
    /** The scores as the judge gave them, before evidence capped any of them. */
    readonly scores: Readonly<Record<Criterion, number | null>>;
    readonly reasons: Readonly<Record<Criterion, string>>;
    readonly rules: readonly RuleVerdict[];
    readonly violations: readonly RuleVerdict[];
    readonly claims: readonly UnsupportedClaim[];
    readonly discarded: readonly DiscardedFinding[];
    readonly summary: string;
  };
  readonly ended: EndReason;
  readonly leaveReason: string | null;
  readonly customerTurns: number;
  readonly botMessages: number;
  readonly lead: {
    readonly status: string;
    readonly routing: RoutingOutcome | null;
    readonly score: number | null;
    readonly fields: readonly string[];
  };
  readonly expectedRouting: readonly (RoutingOutcome | null)[] | null;
  /** True when the model declined to answer at some point (production hands off to a person). */
  readonly refused: boolean;
  readonly usage: { readonly engine: Usage; readonly customer: Usage; readonly judge: Usage };
  /** List-price cost in US dollars; null where a stand-in answered. */
  readonly costUsd: {
    readonly engine: number | null;
    readonly customer: number | null;
    readonly judge: number | null;
  };
  /** The models that answered, as the API named them. */
  readonly models: {
    readonly engine: readonly string[];
    readonly customer: readonly string[];
    readonly judge: string;
  };
  /** Model time of the bot's replies, in milliseconds. */
  readonly replyLatencyMs: { readonly mean: number; readonly max: number };
  readonly retries: number;
  readonly durationMs: number;
  readonly promptVersion: string;
  /** Path of the transcript file, relative to the run directory. */
  readonly transcriptFile: string;
}

export interface ErrorRow {
  readonly scenarioId: string;
  readonly rep: number;
  readonly class: FailureClass;
  readonly message: string;
  readonly at: string;
  readonly durationMs: number;
}

export interface RunManifest {
  readonly id: string;
  readonly mode: RunMode;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly models: { readonly engine: string; readonly customer: string; readonly judge: string };
  readonly reps: number;
  readonly concurrency: number;
  readonly thresholds: Thresholds;
  /** The scenarios this run was asked to play. */
  readonly scenarioIds: readonly string[];
  /** How the selection was made, in words ("all 72 scenarios", "suite roofing"). */
  readonly selection: string;
}

/** What is saved next to a row: the conversation and the full verdict. */
export interface TranscriptFile {
  readonly scenarioId: string;
  readonly rep: number;
  readonly transcript: Transcript;
  readonly row: ResultRow;
}

export const rowKey = (scenarioId: string, rep: number) => `${scenarioId}#${rep}`;

async function readLines<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export interface RunStore {
  readonly dir: string;
  writeManifest(manifest: RunManifest): Promise<void>;
  readManifest(): Promise<RunManifest | null>;
  appendResult(row: ResultRow, transcript: Transcript): Promise<void>;
  appendError(row: ErrorRow): Promise<void>;
  /** The newest row of every (scenario, rep). */
  readResults(): Promise<ResultRow[]>;
  readErrors(): Promise<ErrorRow[]>;
  readTranscript(row: Pick<ResultRow, "transcriptFile">): Promise<TranscriptFile | null>;
  writeFile(name: string, content: string): Promise<string>;
}

export function transcriptFileName(scenarioId: string, rep: number): string {
  return path.posix.join("transcripts", `${scenarioId}.rep${rep}.json`);
}

export function createRunStore(dir: string): RunStore {
  const results = path.join(dir, "results.jsonl");
  const errors = path.join(dir, "errors.jsonl");
  const manifest = path.join(dir, "run.json");
  // Appends are serialized: two conversations finishing together must not interleave lines.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    dir,
    async writeManifest(value) {
      await mkdir(dir, { recursive: true });
      await writeFile(manifest, `${JSON.stringify(value, null, 2)}\n`);
    },
    async readManifest() {
      try {
        return JSON.parse(await readFile(manifest, "utf8")) as RunManifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    appendResult(row, transcript) {
      return enqueue(async () => {
        await mkdir(path.join(dir, "transcripts"), { recursive: true });
        const file: TranscriptFile = {
          scenarioId: row.scenarioId,
          rep: row.rep,
          transcript,
          row,
        };
        // The transcript first: a row never points at a file that is not there.
        await writeFile(path.join(dir, row.transcriptFile), `${JSON.stringify(file, null, 2)}\n`);
        await appendFile(results, `${JSON.stringify(row)}\n`);
      });
    },
    appendError(row) {
      return enqueue(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(errors, `${JSON.stringify(row)}\n`);
      });
    },
    async readResults() {
      const byKey = new Map<string, ResultRow>();
      for (const row of await readLines<ResultRow>(results)) {
        byKey.set(rowKey(row.scenarioId, row.rep), row);
      }
      return [...byKey.values()];
    },
    readErrors: () => readLines<ErrorRow>(errors),
    async readTranscript(row) {
      try {
        return JSON.parse(
          await readFile(path.join(dir, row.transcriptFile), "utf8"),
        ) as TranscriptFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeFile(name, content) {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await writeFile(file, content);
      return file;
    },
  };
}
