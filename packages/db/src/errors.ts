import { TenantAccessError } from "@repo/core";

/** PostgreSQL error codes this package and its callers branch on. */
export const PG_ERROR = {
  insufficientPrivilege: "42501",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  restrictViolation: "23001",
  serializationFailure: "40001",
  deadlockDetected: "40P01",
} as const;

interface PgErrorLike {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly constraint_name?: unknown;
  readonly table_name?: unknown;
}

function findPgError(error: unknown, depth = 0): PgErrorLike | null {
  if (typeof error !== "object" || error === null || depth > 5) return null;
  const candidate = error as PgErrorLike;
  if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
    return candidate;
  }
  return findPgError(candidate.cause, depth + 1);
}

/**
 * The PostgreSQL error code (SQLSTATE) behind an error thrown by Drizzle or the driver, or
 * null when the error did not come from the database. Drizzle wraps driver errors, so the
 * code usually sits on `error.cause`.
 */
export function pgErrorCode(error: unknown): string | null {
  const found = findPgError(error);
  return found === null ? null : (found.code as string);
}

/** The violated constraint's name, when the database reported one. */
export function pgConstraintName(error: unknown): string | null {
  const found = findPgError(error);
  return typeof found?.constraint_name === "string" ? found.constraint_name : null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (pgErrorCode(error) !== PG_ERROR.uniqueViolation) return false;
  return constraint === undefined || pgConstraintName(error) === constraint;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_ERROR.foreignKeyViolation;
}

/** True when row-level security or a missing table privilege refused the statement. */
export function isAccessDenied(error: unknown): boolean {
  return pgErrorCode(error) === PG_ERROR.insufficientPrivilege;
}

/**
 * Turns "row-level security refused this" into the `TenantAccessError` the rest of the
 * system understands (never retried, always logged). Other errors pass through unchanged.
 */
export function translateDbError(error: unknown): unknown {
  if (error instanceof TenantAccessError) return error;
  if (!isAccessDenied(error)) return error;
  const found = findPgError(error);
  // The server names the table in the message ('... for table "contacts"'), not in a field.
  const message = (found as { message?: unknown } | null)?.message;
  const table =
    typeof found?.table_name === "string"
      ? found.table_name
      : typeof message === "string"
        ? /\btable "?([a-z_][a-z0-9_]*)"?/.exec(message)?.[1]
        : undefined;
  return new TenantAccessError("The database refused the operation (row-level security).", {
    cause: error,
    details: table === undefined ? {} : { table },
  });
}
