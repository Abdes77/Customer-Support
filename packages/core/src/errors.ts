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
