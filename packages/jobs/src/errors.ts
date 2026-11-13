import { AppError, ExternalServiceError, safeErrorMessage } from "@repo/core";

import type { JobError } from "./definition";

/** Thrown when an event payload does not match the catalogue. Never retried. */
export class InvalidJobPayloadError extends AppError {
  constructor(eventName: string, paths: readonly string[]) {
    super("validation_failed", `Invalid payload for event ${eventName}.`, {
      retryable: false,
      details: { eventName, paths },
    });
  }
}

/** True when retrying cannot help: an `AppError` created with `retryable: false`. */
export function isPermanentError(error: unknown): boolean {
  return error instanceof AppError && !error.retryable;
}

/** The delay a vendor asked for before the next attempt, if any. */
export function retryAfterMs(error: unknown): number | null {
  if (error instanceof ExternalServiceError && error.retryAfterSeconds !== undefined) {
    return Math.max(0, error.retryAfterSeconds) * 1000;
  }
  return null;
}

/**
 * A log-safe description of an error: name, message and code, nothing else. The message of a
 * failed database statement loses the statement's values (`safeErrorMessage`): this
 * description is logged, stored in dead letters and handed to the job runner.
 */
export function describeJobError(error: unknown): JobError {
  if (error instanceof AppError) {
    return { name: error.name, message: safeErrorMessage(error.message), code: error.code };
  }
  if (error instanceof Error) {
    return { name: error.name, message: safeErrorMessage(error.message), code: null };
  }
  return { name: "Error", message: safeErrorMessage(String(error)), code: null };
}
