import { randomUUID } from "node:crypto";

import { createLogger, EVENT_CATALOG, type Logger } from "@repo/core";

import {
  type CronJobDefinition,
  durationToMs,
  evaluateEventKey,
  type EventJobDefinition,
  isCronJob,
  type JobContext,
  type JobDefinition,
  type JobEventEnvelope,
  type StepTools,
} from "./definition";
import { describeJobError, isPermanentError, retryAfterMs } from "./errors";
import type { AnyJobEvent, EventSender } from "./events";

/**
 * An in-process job runner with the semantics the code relies on from Inngest:
 *
 * - event ids deduplicate (24 hours);
 * - `debounce`: a run starts `period` after the last event with the same key, with the
 *   latest event, and at the latest `timeout` after the first;
 * - `concurrency`: at most `limit` runs per key work at a time; a run gives its slot up
 *   while it sleeps or waits to retry, as under Inngest (where the limit covers steps), and
 *   runs queue in arrival order (Inngest's order is best effort; ordering guarantees are
 *   enforced in PostgreSQL, not by the runner);
 * - memoized steps, retries with backoff (honouring retry-after), permanent errors, and
 *   `onFailure` once a run has failed for good;
 * - cron jobs, once `startCrons()` is called.
 *
 * It is used by tests and by local development when Inngest is not configured. It keeps
 * everything in memory: a process restart loses pending work, so it is never used on a
 * hosted deployment.
 *
 * `idle()` does not wait for a run that sleeps (a durable `sleep` or `sleepUntil`) longer than
 * `idleIgnoresSleepsOverMs` (default 30 s): a nudge hours away, a reminder, an idle release.
 * Such a run is dormant until it wakes; its timer does not keep the process alive.
 */

export interface LocalRunRecord {
  readonly functionId: string;
  readonly runId: string;
  readonly eventName: string;
  readonly eventId: string | null;
  readonly status: "completed" | "failed";
  readonly attempts: number;
  readonly error: string | null;
}

export interface LocalJobRunnerOptions {
  readonly logger?: Logger;
  /** Delay before retry number `attempt + 1`. Default: 1 s doubling, at most 30 s. */
  readonly retryDelayMs?: (attempt: number) => number;
  /** Replaces every debounce period (tests use a short one). */
  readonly debouncePeriodMs?: number;
  readonly now?: () => Date;
  /** A durable sleep longer than this does not hold `idle()` up. Default 30 s. */
  readonly idleIgnoresSleepsOverMs?: number;
}

export interface LocalJobRunner extends EventSender {
  register(definitions: readonly JobDefinition[]): void;
  /** Resolves when no run is active or waiting and no debounce timer is pending. */
  idle(): Promise<void>;
  /** Runs cron jobs on their schedule until `stop()`. */
  startCrons(): void;
  /** Runs one cron job now (tests, and the dev page's "run sweeper" button). */
  runCron(functionId: string): Promise<void>;
  /** Stops crons and drops pending debounce timers. Active runs finish. */
  stop(): void;
  readonly history: readonly LocalRunRecord[];
}

const DEDUPE_MS = 24 * 60 * 60 * 1000;

interface DebounceSlot {
  event: AnyJobEvent;
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ConcurrencyState {
  active: number;
  readonly queue: (() => void)[];
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function wait(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (unref) timer.unref?.();
  });
}

function toJson<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

function matchesCronField(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return value % Number(step[1]) === 0;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return /^\d+$/.test(part) && Number(part) === value;
  });
}

/** Five-field cron, UTC: minute hour day-of-month month day-of-week. */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Unsupported cron expression: ${expression}`);
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  return (
    matchesCronField(minute, date.getUTCMinutes()) &&
    matchesCronField(hour, date.getUTCHours()) &&
    matchesCronField(day, date.getUTCDate()) &&
    matchesCronField(month, date.getUTCMonth() + 1) &&
    matchesCronField(weekday, date.getUTCDay())
  );
}

export function createLocalJobRunner(options: LocalJobRunnerOptions = {}): LocalJobRunner {
  const logger = (options.logger ?? createLogger()).child({ component: "local-job-runner" });
  const retryDelay = options.retryDelayMs ?? defaultRetryDelay;
  const now = options.now ?? (() => new Date());

  const definitions: JobDefinition[] = [];
  const seenEventIds = new Map<string, number>();
  const debounces = new Map<string, DebounceSlot>();
  const concurrency = new Map<string, ConcurrencyState>();
  const history: LocalRunRecord[] = [];
  const idleWaiters: (() => void)[] = [];
  let pending = 0;
  /** Runs in a long durable sleep: `idle()` does not wait for them. */
  let dormant = 0;
  const dormantAfterMs = options.idleIgnoresSleepsOverMs ?? 30_000;
  let cronTimer: ReturnType<typeof setInterval> | null = null;
  let lastCronMinute = -1;

  function begin(): void {
    pending += 1;
  }

  function end(): void {
    pending -= 1;
    notifyIdle();
  }

  function notifyIdle(): void {
    if (pending - dormant === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  function eventJobsFor(name: string): EventJobDefinition[] {
    return definitions.filter(
      (definition) => !isCronJob(definition) && definition.trigger.event === name,
    ) as EventJobDefinition[];
  }

  /**
   * A concurrency slot of one run. Like Inngest's limit, it covers work, not waiting: a run
   * gives its slot up while it sleeps or waits for a retry, so a run that waits for another
   * run of the same key (an earlier message being sent) cannot block it.
   */
  interface Slot {
    acquire(): Promise<void>;
    release(): void;
  }

  function slotFor(key: string | null, limit: number): Slot {
    if (key === null) return { acquire: () => Promise.resolve(), release: () => {} };
    return {
      acquire() {
        let state = concurrency.get(key);
        if (state === undefined) {
          state = { active: 0, queue: [] };
          concurrency.set(key, state);
        }
        if (state.active < limit) {
          state.active += 1;
          return Promise.resolve();
        }
        const queued = state;
        return new Promise((resolve) => {
          queued.queue.push(() => {
            queued.active += 1;
            resolve();
          });
        });
      },
      release() {
        const state = concurrency.get(key);
        if (state === undefined) return;
        state.active -= 1;
        const next = state.queue.shift();
        if (next !== undefined) next();
        else if (state.active === 0) concurrency.delete(key);
      },
    };
  }

  async function pause(slot: Slot, ms: number, durable = false): Promise<void> {
    slot.release();
    const long = durable && ms > dormantAfterMs;
    if (long) {
      dormant += 1;
      notifyIdle();
    }
    try {
      await wait(ms, long);
    } finally {
      if (long) dormant -= 1;
      await slot.acquire();
    }
  }

  function stepTools(
    memo: Map<string, unknown>,
    slot: Slot,
  ): { tools: StepTools; reset: () => void } {
    const used = new Set<string>();
    const claim = (id: string) => {
      if (used.has(id)) throw new Error(`Step id used twice in one run: ${id}`);
      used.add(id);
    };
    const tools: StepTools = {
      async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        claim(id);
        if (memo.has(id)) return toJson(memo.get(id) as T);
        const result = toJson(await fn());
        memo.set(id, result);
        return toJson(result);
      },
      async sleep(id, durationMs) {
        claim(id);
        if (memo.has(id)) return;
        await pause(slot, durationMs, true);
        memo.set(id, null);
      },
      async sleepUntil(id, until) {
        claim(id);
        if (memo.has(id)) return;
        await pause(slot, until.getTime() - now().getTime(), true);
        memo.set(id, null);
      },
    };
    return { tools, reset: () => used.clear() };
  }

  function record(
    definition: JobDefinition,
    runId: string,
    event: JobEventEnvelope<unknown>,
    outcome: Pick<LocalRunRecord, "status" | "attempts" | "error">,
  ): void {
    history.push({
      functionId: definition.id,
      runId,
      eventName: event.name,
      eventId: event.id,
      ...outcome,
    });
  }

  async function execute(
    definition: JobDefinition,
    received: JobEventEnvelope<unknown>,
    slot: Slot,
  ): Promise<void> {
    const runId = randomUUID();
    const runLogger = logger.child({ functionId: definition.id, runId });
    let event = received;
    if (!isCronJob(definition)) {
      const parsed = EVENT_CATALOG[definition.trigger.event].safeParse(event.data);
      if (!parsed.success) {
        runLogger.error("job.invalid_payload", { eventName: event.name });
        record(definition, runId, event, {
          status: "failed",
          attempts: 0,
          error: "invalid payload",
        });
        return;
      }
      event = { ...event, data: parsed.data };
    }

    const memo = new Map<string, unknown>();
    const { tools, reset } = stepTools(memo, slot);
    await slot.acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        reset();
        const ctx: JobContext<never> = {
          event: event as JobEventEnvelope<never>,
          step: tools,
          runId,
          attempt,
          logger: runLogger,
        };
        try {
          await (definition as { handler(ctx: JobContext<never>): Promise<unknown> }).handler(ctx);
          record(definition, runId, event, {
            status: "completed",
            attempts: attempt + 1,
            error: null,
          });
          return;
        } catch (error) {
          const described = describeJobError(error);
          if (isPermanentError(error) || attempt >= definition.retries) {
            runLogger.warn("job.failed", { attempts: attempt + 1, error: described });
            record(definition, runId, event, {
              status: "failed",
              attempts: attempt + 1,
              error: described.message,
            });
            if (definition.onFailure !== undefined) {
              try {
                await (
                  definition as {
                    onFailure(ctx: {
                      event: JobEventEnvelope<unknown>;
                      error: typeof described;
                      runId: string;
                      logger: Logger;
                    }): Promise<void>;
                  }
                ).onFailure({ event, error: described, runId, logger: runLogger });
              } catch (failureError) {
                runLogger.error("job.on_failure_failed", {
                  error: describeJobError(failureError),
                });
              }
            }
            return;
          }
          runLogger.debug("job.retrying", { attempt, error: described });
          await pause(slot, retryAfterMs(error) ?? retryDelay(attempt));
        }
      }
    } finally {
      slot.release();
    }
  }

  function startRun(definition: JobDefinition, event: JobEventEnvelope<unknown>): void {
    const limit = isCronJob(definition) ? undefined : definition.concurrency;
    const key =
      limit === undefined ? null : `${definition.id}:${evaluateEventKey(limit.key, event.data)}`;
    const slot = slotFor(key, limit?.limit ?? Number.POSITIVE_INFINITY);
    begin();
    void execute(definition, event, slot)
      .catch((error: unknown) => {
        logger.error("job.runner_error", { functionId: definition.id, error });
      })
      .finally(end);
  }

  function envelope(event: AnyJobEvent): JobEventEnvelope<unknown> {
    return { name: event.name, id: event.id, data: event.data };
  }

  function dispatch(definition: EventJobDefinition, event: AnyJobEvent): void {
    const debounce = definition.debounce;
    if (debounce === undefined) {
      startRun(definition as JobDefinition, envelope(event));
      return;
    }
    const key = `${definition.id}:${evaluateEventKey(debounce.key, event.data)}`;
    const period = options.debouncePeriodMs ?? durationToMs(debounce.period);
    const timeout =
      debounce.timeout === undefined ? Number.POSITIVE_INFINITY : durationToMs(debounce.timeout);
    const existing = debounces.get(key);
    const firstAt = existing?.firstAt ?? now().getTime();
    begin();
    if (existing !== undefined) {
      clearTimeout(existing.timer);
      end();
    }
    const delay = Math.max(0, Math.min(period, firstAt + timeout - now().getTime()));
    const timer = setTimeout(() => {
      const slot = debounces.get(key);
      if (slot?.timer !== timer) return;
      debounces.delete(key);
      startRun(definition as JobDefinition, envelope(slot.event));
      end();
    }, delay);
    debounces.set(key, { event, firstAt, timer });
  }

  function pruneSeen(at: number): void {
    for (const [id, seenAt] of seenEventIds) {
      if (at - seenAt > DEDUPE_MS) seenEventIds.delete(id);
    }
  }

  function tickCrons(): void {
    const at = now();
    const minute = Math.floor(at.getTime() / 60_000);
    if (minute === lastCronMinute) return;
    lastCronMinute = minute;
    for (const definition of definitions) {
      if (isCronJob(definition) && cronMatches(definition.trigger.cron, at)) {
        startRun(definition, { name: "cron", id: null, data: {} });
      }
    }
  }

  return {
    history,

    register(list) {
      for (const definition of list) {
        if (definitions.some((existing) => existing.id === definition.id)) {
          throw new Error(`A job with id ${definition.id} is already registered.`);
        }
        definitions.push(definition);
      }
    },

    async send(events) {
      const at = now().getTime();
      pruneSeen(at);
      for (const event of events) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.set(event.id, at);
        for (const definition of eventJobsFor(event.name)) {
          dispatch(definition, event);
        }
      }
    },

    idle() {
      if (pending - dormant === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    startCrons() {
      if (cronTimer !== null) return;
      cronTimer = setInterval(tickCrons, 5_000);
      cronTimer.unref?.();
    },

    async runCron(functionId) {
      const definition = definitions.find(
        (candidate): candidate is CronJobDefinition =>
          candidate.id === functionId && isCronJob(candidate),
      );
      if (definition === undefined) throw new Error(`No cron job with id ${functionId}.`);
      begin();
      try {
        await execute(definition, { name: "cron", id: null, data: {} }, slotFor(null, 1));
      } finally {
        end();
      }
    },

    stop() {
      if (cronTimer !== null) clearInterval(cronTimer);
      cronTimer = null;
      for (const slot of debounces.values()) {
        clearTimeout(slot.timer);
        end();
      }
      debounces.clear();
    },
  };
}
