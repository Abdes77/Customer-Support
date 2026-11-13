/**
 * Error taxonomy shared by every package. Job code uses `retryable` to decide between a retry
 * and the dead-letter path, so set it deliberately.
 */
export type AppErrorCode =
  | "config_missing"
  | "validation_failed"
  | "not_found"
  | "tenant_access_denied"
  | "webhook_rejected"
  | "external_service_failed"
  | "rate_limited"
  | "spend_cap_reached"
  | "conflict"
  | "internal";

export interface AppErrorOptions {
  readonly cause?: unknown;
  /** True when trying again later can succeed (timeouts, 429, 5xx). */
  readonly retryable?: boolean;
  /** Safe, non-secret details for logs and the admin panel. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

/** A required environment variable or account is not configured. See docs/HUMAN_TODO.md. */
export class ConfigError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("config_missing", message, options);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("validation_failed", message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("not_found", message, options);
  }
}

/** A read or write crossed a tenant boundary. Never retry; always log and audit. */
export class TenantAccessError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("tenant_access_denied", message, options);
  }
}

/** A webhook failed signature, replay or shape checks. */
export class WebhookRejectedError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("webhook_rejected", message, options);
  }
}

export interface ExternalServiceErrorOptions extends AppErrorOptions {
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

/** A call to Meta, Google, Microsoft, Twilio, a CRM, Anthropic or any other vendor failed. */
export class ExternalServiceError extends AppError {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: ExternalServiceErrorOptions) {
    const status = options.status;
    const retryable =
      options.retryable ??
      (status === undefined || status === 408 || status === 429 || status >= 500);
    super(status === 429 ? "rate_limited" : "external_service_failed", message, {
      ...options,
      retryable,
    });
    this.provider = options.provider;
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AppError ? error.retryable : true;
}

/** What replaces the parameter values of a failed database statement in an error's text. */
export const REMOVED_QUERY_PARAMS = "[removed]";

const QUERY_ERROR = /^(Failed query: [\s\S]*?)\nparams: [\s\S]*$/;
const MAX_QUERY_TEXT = 2000;

/**
 * An error message without the values of the statement that failed. The database library
 * words a failed statement as "Failed query: <sql>\nparams: <values>", and the values are
 * whatever the statement was given: a customer's message, a name, an address, a phone number,
 * an encrypted credential. An error's text travels to the logs, to Sentry, to the job runner's
 * run history and into rows the admin panel shows (dead letters, a connection's last error),
 * so the values are cut here and the statement's own text (placeholders only) is kept.
 */
export function safeErrorMessage(message: string): string {
  const match = QUERY_ERROR.exec(message);
  if (match === null) return message;
  const statement = match[1] ?? "Failed query";
  const shown =
    statement.length > MAX_QUERY_TEXT ? `${statement.slice(0, MAX_QUERY_TEXT)}…` : statement;
  return `${shown}\nparams: ${REMOVED_QUERY_PARAMS}`;
}

/**
 * The stack of an error whose message `safeErrorMessage` changes: V8 starts a stack with the
 * message, so the same values would otherwise survive there.
 */
export function safeErrorStack(stack: string | undefined, message: string): string | undefined {
  if (stack === undefined) return undefined;
  const safe = safeErrorMessage(message);
  if (safe === message) return stack;
  const at = stack.indexOf(message);
  if (at !== -1) return `${stack.slice(0, at)}${safe}${stack.slice(at + message.length)}`;
  // The stack does not repeat the message word for word: keep the frames only.
  const frames = stack.split("\n").filter((line) => /^\s+at \S/.test(line) && line.length < 400);
  return [safe, ...frames].join("\n");
}

/**
 * Removes the statement's values from a database error and from the errors that caused it,
 * in place (the same object is thrown on, so `instanceof` and error codes keep working).
 * Returns the error it was given.
 */
export function scrubQueryError<T>(error: T): T {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const safe = safeErrorMessage(current.message);
    if (safe !== current.message) {
      try {
        const stack = safeErrorStack(current.stack, current.message);
        current.message = safe;
        if (stack !== undefined) current.stack = stack;
        if ("params" in current) (current as { params?: unknown }).params = [];
      } catch {
        // A frozen error keeps its text; the logger removes the values again when it writes.
      }
    }
    current = current.cause;
  }
  return error;
}
