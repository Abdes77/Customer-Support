import type { Logger, TraceContext, TraceId } from "@repo/core";

import { runChecks } from "../grade/checks";
import { createJudge, type Judge, type JudgeResult } from "../grade/judge";
import { CRITERIA, type Criterion, type Thresholds } from "../grade/rubric";
import { gradeConversation } from "../grade/score";
import { createEvalSandbox, type EvalSandbox } from "../sandbox/sandbox";
import type { Scenario } from "../scenarios/types";
import { costOfCalls } from "../simulate/calls";
import { runConversation } from "../simulate/conversation";
import { createCustomerSimulator, type CustomerSimulator } from "../simulate/customer";
import { botEntries, customerEntries, type Transcript } from "../simulate/transcript";
import type { EvalModels } from "./models";
import {
  EvalAbortError,
  failureClass,
  failureMessage,
  type RetryOptions,
  withRetries,
} from "./retry";
import { type ResultRow, rowKey, type RunStore, transcriptFileName } from "./store";

/**
 * Plays the scenarios of a run. Suites run next to each other and share one limit on how
 * many conversations are in flight; each conversation has a wall-clock ceiling; a
 * conversation that already has a row in the store is not played again.
 */

export interface RunEvaluationOptions {
  readonly scenarios: readonly Scenario[];
  readonly models: EvalModels;
  readonly store: RunStore;
  readonly thresholds: Thresholds;
  readonly logger: Logger;
  /** Times each scenario is played. Default 1. */
  readonly reps?: number;
  /** Conversations in flight at once. Default 6. */
  readonly concurrency?: number;
  /** Wall-clock ceiling of one conversation with its judging, in milliseconds. Default 15 min. */
  readonly timeoutMs?: number;
  readonly maxCustomerTurns?: number;
  readonly strictTools?: boolean;
  readonly retry?: RetryOptions;
  /** Called as each conversation finishes, for a progress line. */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Tests bring their own. */
  readonly sandbox?: EvalSandbox;
  readonly clock?: () => Date;
}

export type ProgressEvent =
  | {
      readonly kind: "result";
      readonly row: ResultRow;
      readonly done: number;
      readonly total: number;
    }
  | {
      readonly kind: "error";
      readonly scenarioId: string;
      readonly rep: number;
      readonly class: string;
      readonly message: string;
      readonly done: number;
      readonly total: number;
    };

export interface RunEvaluationResult {
  /** Conversations played in this call (not counting ones resumed from the store). */
  readonly played: number;
  readonly skipped: number;
  /** Set when the run was stopped because no later conversation could work (a bad key). */
  readonly fatal: string | null;
  /** Rows in the tables a live turn writes, after the run. All zero: nothing was written (I8). */
  readonly turnRowCounts: Readonly<Record<string, number>>;
  readonly promptVersion: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function toRow(input: {
  readonly scenario: Scenario;
  readonly rep: number;
  readonly transcript: Transcript;
  readonly judge: JudgeResult;
  readonly checks: ReturnType<typeof runChecks>;
  readonly grade: ResultRow["grade"];
  readonly durationMs: number;
}): ResultRow {
  const { scenario, transcript, judge } = input;
  const bots = botEntries(transcript);
  const replies = bots.filter((entry) => entry.replies.length > 0);
  const micro = (value: number | null) => (value === null ? null : value / 1_000_000);
  return {
    scenarioId: scenario.id,
    suite: scenario.suite,
    persona: scenario.persona.id,
    profile: scenario.profile.id,
    channel: scenario.channel,
    rep: input.rep,
    grade: input.grade,
    checks: input.checks,
    judge: {
      model: judge.model,
      standIn: judge.standIn,
      scores: Object.fromEntries(
        CRITERIA.map((criterion) => [criterion, judge.criteria[criterion].score]),
      ) as Record<Criterion, number | null>,
      reasons: Object.fromEntries(
        CRITERIA.map((criterion) => [criterion, judge.criteria[criterion].reason]),
      ) as Record<Criterion, string>,
      rules: judge.rules,
      violations: judge.violations,
      claims: judge.claims,
      discarded: judge.discarded,
      summary: judge.summary,
    },
    ended: transcript.ended,
    leaveReason: transcript.leaveReason,
    customerTurns: customerEntries(transcript).length,
    botMessages: bots.reduce((total, entry) => total + entry.replies.length, 0),
    lead: {
      status: transcript.lead.status,
      routing: transcript.lead.routing?.outcome ?? null,
      score: transcript.lead.routing?.score ?? null,
      fields: Object.keys(transcript.lead.fields),
    },
    expectedRouting: scenario.expect.routing ?? null,
    refused: bots.some((entry) => entry.outcome === "refused"),
    usage: {
      engine: transcript.usage.engine,
      customer: transcript.usage.customer,
      judge: judge.usage,
    },
    costUsd: {
      engine: micro(transcript.costMicroUsd.engine),
      customer: micro(transcript.costMicroUsd.customer),
      judge: micro(costOfCalls(judge.calls)),
    },
    models: {
      engine: transcript.engineModels,
      customer: transcript.customerModels,
      judge: judge.model,
    },
    replyLatencyMs: {
      mean:
        replies.length === 0
          ? 0
          : Math.round(
              replies.reduce((total, entry) => total + entry.latencyMs, 0) / replies.length,
            ),
      max: replies.reduce((longest, entry) => Math.max(longest, entry.latencyMs), 0),
    },
    retries: transcript.retries,
    durationMs: input.durationMs,
    promptVersion: transcript.promptVersion,
    transcriptFile: transcriptFileName(scenario.id, input.rep),
  };
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<RunEvaluationResult> {
  const { scenarios, models, store, thresholds } = options;
  const reps = Math.max(1, options.reps ?? 1);
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger.child({ component: "evals" });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const done = new Set((await store.readResults()).map((row) => rowKey(row.scenarioId, row.rep)));
  const tasks = scenarios.flatMap((scenario) =>
    Array.from({ length: reps }, (_, rep) => ({ scenario, rep })),
  );
  const todo = tasks.filter((task) => !done.has(rowKey(task.scenario.id, task.rep)));
  const skipped = tasks.length - todo.length;

  const sandbox =
    options.sandbox ??
    (await createEvalSandbox({
      model: models.engine,
      logger,
      segments: [...new Set(scenarios.map((scenario) => scenario.suite))],
    }));
  const customer: CustomerSimulator = createCustomerSimulator({ ...models.customer, logger });
  const judge: Judge = createJudge({
    ...models.judge,
    logger,
    ...(options.strictTools === undefined ? {} : { strictTools: options.strictTools }),
  });

  let finished = 0;
  let played = 0;
  let fatal: string | null = null;
  let promptVersion = "";
  const run = limiter(Math.max(1, options.concurrency ?? 6));

  async function playOne(scenario: Scenario, rep: number): Promise<void> {
    if (fatal !== null) return;
    const started = clock().getTime();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const retry: RetryOptions = { ...options.retry, signal: controller.signal };
    try {
      const work = (async (): Promise<{ row: ResultRow; transcript: Transcript }> => {
        const transcript = await runConversation(scenario, {
          sandbox,
          customer,
          logger,
          retry,
          signal: controller.signal,
          ...(options.maxCustomerTurns === undefined
            ? {}
            : { maxCustomerTurns: options.maxCustomerTurns }),
        });
        const checks = runChecks(scenario, transcript);
        const { profile } = sandbox.business(scenario.suite);
        const trace: TraceContext = {
          traceId: "00000000-0000-4000-8e00-000000000001" as TraceId,
          agencyId: profile.agencyId,
          businessId: profile.id,
          conversationId: null,
        };
        const { value: verdict } = await withRetries(
          () => judge.judge({ scenario, transcript, checks, trace, signal: controller.signal }),
          retry,
        );
        const grade = gradeConversation({ mode: models.mode, checks, judge: verdict, thresholds });
        return {
          transcript,
          row: toRow({
            scenario,
            rep,
            transcript,
            judge: verdict,
            checks,
            grade,
            durationMs: clock().getTime() - started,
          }),
        };
      })();
      // The ceiling reclaims the slot; a call that is still in flight ends at its own deadline.
      work.catch(() => undefined);
      const { row, transcript } = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new EvalAbortError()), {
            once: true,
          });
        }),
      ]);
      await store.appendResult(row, transcript);
      played += 1;
      finished += 1;
      if (row.promptVersion.length > 0) promptVersion = row.promptVersion;
      options.onProgress?.({ kind: "result", row, done: finished, total: todo.length });
    } catch (error) {
      const kind = failureClass(error);
      const message = failureMessage(error);
      logger.error("eval.conversation_failed", { scenario: scenario.id, rep, class: kind, error });
      await store.appendError({
        scenarioId: scenario.id,
        rep,
        class: kind,
        message,
        at: clock().toISOString(),
        durationMs: clock().getTime() - started,
      });
      finished += 1;
      // A missing or refused key fails every conversation the same way: stop asking.
      if (kind === "config") fatal = message;
      options.onProgress?.({
        kind: "error",
        scenarioId: scenario.id,
        rep,
        class: kind,
        message,
        done: finished,
        total: todo.length,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // Suites side by side; within a suite its conversations side by side; one limit for all.
    const suites = [...new Set(todo.map((task) => task.scenario.suite))];
    await Promise.all(
      suites.map((suite) =>
        Promise.all(
          todo
            .filter((task) => task.scenario.suite === suite)
            .map((task) => run(() => playOne(task.scenario, task.rep))),
        ),
      ),
    );
    return {
      played,
      skipped,
      fatal,
      turnRowCounts: await sandbox.turnRowCounts(),
      promptVersion,
    };
  } finally {
    if (options.sandbox === undefined) await sandbox.dispose();
  }
}
