import { AppError, ConfigError, ExternalServiceError, isRetryable } from "@repo/core";

/**
 * Why an attempt produced nothing to grade. These never count as a score: a conversation
 * that could not be played or judged is reported next to the results, not inside them.
 */
export type FailureClass =
  /** A key or an account is missing or refused: no later attempt can work. */
  | "config"
  /** The judge model gave no usable verdict (declined, or malformed after a correction). */
  | "judge"
  /** The Claude API failed after every retry (rate limit, overload, timeout, 5xx). */
  | "serving"
  /** The conversation ran into its wall-clock ceiling. */
  | "timeout"
  /** A bug in the harness, or anything else that is not the bot's doing. */
  | "harness";

export class EvalAbortError extends Error {
  constructor(message = "The evaluation of this conversation was stopped at its time limit.") {
    super(message);
    this.name = "EvalAbortError";
  }
}

/** The judge could not produce a usable verdict. Never a score: retried, then reported. */
export class JudgeError extends AppError {
  constructor(message: string, retryable: boolean) {
    super("external_service_failed", message, { retryable, details: { purpose: "eval_judge" } });
  }
}

export function failureClass(error: unknown): FailureClass {
  if (error instanceof EvalAbortError) return "timeout";
  if (error instanceof JudgeError) return "judge";
  if (error instanceof ConfigError) return "config";
  if (error instanceof ExternalServiceError) return "serving";
  return "harness";
}

/** A message that is safe to store: an `AppError` never carries request content. */
export function failureMessage(error: unknown): string {
  if (error instanceof AppError || error instanceof EvalAbortError) return error.message;
  return error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error.";
}

export interface RetryOptions {
  /** Attempts in all. Default 3. */
  readonly attempts?: number;
  /** First wait in milliseconds; each later wait doubles. Default 2000. */
  readonly baseMs?: number;
  /** Longest single wait. Default 60 s. */
  readonly maxMs?: number;
  readonly signal?: AbortSignal;
  /** Tests inject these. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, trying again after a failure that a later attempt can fix (the same rule the
 * job runner uses: `isRetryable`). Waits grow exponentially with jitter and honour the
 * `retry-after` the API sent. Returns the value and how many attempts it took.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<{ readonly value: T; readonly attempts: number }> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = options.baseMs ?? 2000;
  const maxMs = options.maxMs ?? 60_000;
  const sleep = options.sleep ?? sleepFor;
  const random = options.random ?? Math.random;
  // A function, so that the compiler does not assume the signal is still what it was
  // before an await.
  const aborted = (): boolean => options.signal?.aborted === true;
  for (let attempt = 1; ; attempt += 1) {
    if (aborted()) throw new EvalAbortError();
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      if (aborted()) throw new EvalAbortError();
      if (attempt >= attempts || !isRetryable(error) || error instanceof EvalAbortError) {
        throw error;
      }
      const asked =
        error instanceof ExternalServiceError && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : 0;
      const backoff = baseMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5);
      const waitMs = Math.min(maxMs, Math.max(asked, backoff));
      options.onRetry?.(error, attempt, waitMs);
      await sleep(waitMs);
    }
  }
}
