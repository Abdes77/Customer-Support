/**
 * @repo/jobs (owner: C3)
 *
 * Durable jobs. Functions are declared once as `JobDefinition`s (trigger, debounce,
 * concurrency, retries, handler, onFailure) against the small `StepTools` interface, and run
 * either on Inngest (`toInngestFunctions`, served at /api/inngest) or in-process
 * (`createLocalJobRunner`, for tests and local development). Events go out through an
 * `EventSender` with deterministic ids. ARCHITECTURE §4 has the rules every function follows.
 *
 * Server only.
 */
export {
  type CronJobDefinition,
  defineCronJob,
  defineEventJob,
  type Duration,
  durationToMs,
  evaluateEventKey,
  type EventJobDefinition,
  type EventKey,
  isCronJob,
  type JobContext,
  type JobDefinition,
  type JobError,
  type JobEventEnvelope,
  type JobFailureContext,
  type RetryCount,
  type StepTools,
} from "./definition";
export {
  type AnyJobEvent,
  type EventSender,
  type JobEvent,
  jobEvent,
  RecordingEventSender,
} from "./events";
export { describeJobError, InvalidJobPayloadError, isPermanentError, retryAfterMs } from "./errors";
export {
  createInngestClient,
  createInngestEventSender,
  INNGEST_APP_ID,
  type InngestClient,
  type InngestClientOptions,
  toInngestError,
  toInngestFunctions,
} from "./inngest";
export {
  createLocalJobRunner,
  cronMatches,
  type LocalJobRunner,
  type LocalJobRunnerOptions,
  type LocalRunRecord,
} from "./local-runner";
export { inngestDevAllowed, type JobsMode, jobsModeFromEnv } from "./mode";
