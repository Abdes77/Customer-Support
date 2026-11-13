import type { EventName, EventPayload, Logger } from "@repo/core";

/*
 * Framework-neutral job definitions.
 *
 * Every durable function is written once against these types and the small `StepTools`
 * interface, then handed to a runner: `toInngestFunctions()` for Inngest (production and the
 * Inngest dev server) or `createLocalJobRunner()` (tests, and local development when Inngest
 * is not configured). Both runners follow the same rules:
 *
 * - a step's result is memoized by its id and replayed on a retry, so side effects inside a
 *   step happen once per run (at least once in the face of crashes);
 * - step results go through JSON, so return plain JSON (strings for dates, no class
 *   instances, no `undefined` in arrays);
 * - a thrown `AppError` with `retryable: false` fails the run at once; anything else is
 *   retried with backoff, honouring `ExternalServiceError.retryAfterSeconds`;
 * - the event data is validated against `EVENT_CATALOG` before the handler sees it; invalid
 *   data fails the run without retries.
 */

/** A duration in Inngest's notation: "500ms" is not allowed; seconds, minutes, hours, days. */
export type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`;

/**
 * A key expression over the triggering event, in Inngest's expression language. Only the
 * form `event.data.<field>` is used in this code base (the local runner evaluates exactly
 * that form).
 */
export type EventKey = `event.data.${string}`;

export interface StepTools {
  /** Runs `fn` once per run; on a retry the stored (JSON) result is returned instead. */
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Waits, durably. */
  sleep(id: string, durationMs: number): Promise<void>;
  /** Waits until the given time, durably. A time in the past returns at once. */
  sleepUntil(id: string, until: Date): Promise<void>;
}

export interface JobEventEnvelope<TData> {
  readonly name: string;
  /** The event id when the sender gave one (our events always have one). */
  readonly id: string | null;
  readonly data: TData;
}

export interface JobContext<TData> {
  readonly event: JobEventEnvelope<TData>;
  readonly step: StepTools;
  /** Unique per run, stable across its retries. */
  readonly runId: string;
  /** Zero-based attempt of the run (or of the current step, under Inngest). */
  readonly attempt: number;
  readonly logger: Logger;
}

export interface JobError {
  readonly name: string;
  readonly message: string;
  /** `AppError.code` when the error was one. */
  readonly code: string | null;
}

export interface JobFailureContext<TData> {
  /** The triggering event. A payload that failed validation never reaches `onFailure`. */
  readonly event: JobEventEnvelope<TData>;
  readonly error: JobError;
  readonly runId: string;
  readonly logger: Logger;
}

export type RetryCount =
  0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

interface JobBase {
  /** Stable function id, `package-purpose` (ARCHITECTURE §4). Never change it once deployed. */
  readonly id: string;
  readonly name: string;
  /** Retries after the first attempt. */
  readonly retries: RetryCount;
}

export interface EventJobDefinition<TName extends EventName = EventName> extends JobBase {
  readonly trigger: { readonly event: TName };
  /** Delays the run until no event with the same key arrived for `period`. */
  readonly debounce?: {
    readonly key: EventKey;
    readonly period: Duration;
    readonly timeout?: Duration;
  };
  /** At most `limit` runs (Inngest: steps) at a time per key. */
  readonly concurrency?: { readonly key: EventKey; readonly limit: number };
  handler(ctx: JobContext<EventPayload<TName>>): Promise<unknown>;
  /** Called once when the run has failed for good (retries exhausted or a permanent error). */
  onFailure?(ctx: JobFailureContext<EventPayload<TName>>): Promise<void>;
}

export interface CronJobDefinition extends JobBase {
  /** Five-field cron expression, UTC. */
  readonly trigger: { readonly cron: string };
  handler(ctx: JobContext<Record<string, never>>): Promise<unknown>;
  onFailure?(ctx: JobFailureContext<Record<string, never>>): Promise<void>;
}

/** Any job, for lists of definitions. */
export type JobDefinition =
  { [TName in EventName]: EventJobDefinition<TName> }[EventName] | CronJobDefinition;

/** Declares an event-triggered job with its payload typed from the event catalogue. */
export function defineEventJob<TName extends EventName>(
  definition: EventJobDefinition<TName>,
): EventJobDefinition<TName> {
  return definition;
}

export function defineCronJob(definition: CronJobDefinition): CronJobDefinition {
  return definition;
}

export function isCronJob(definition: JobDefinition): definition is CronJobDefinition {
  return "cron" in definition.trigger;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function durationToMs(duration: Duration): number {
  const match = DURATION_PATTERN.exec(duration);
  if (match === null) throw new Error(`Invalid duration: ${duration}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Evaluates an `event.data.<field>` key against event data. */
export function evaluateEventKey(key: EventKey, data: unknown): string {
  const path = key.slice("event.data.".length).split(".");
  let value: unknown = data;
  for (const part of path) {
    value =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined || value === null ? "" : JSON.stringify(value);
}
