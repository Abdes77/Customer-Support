import { AppError, TenantAccessError } from "@repo/core";

/** The editor or reader is not allowed to do this with these settings. Never retried. */
export class SettingsPermissionError extends TenantAccessError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message, { details });
  }
}

/** Someone else changed the setting since the form was loaded (`expectedVersion` did not match). */
export class SettingsConflictError extends AppError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("conflict", message, { details });
  }
}
