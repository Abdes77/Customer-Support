import {
  AppError,
  type Logger,
  NotFoundError,
  TenantAccessError,
  ValidationError,
} from "@repo/core";

/*
 * What a server action of the admin panel answers. Errors become a sentence a person can act
 * on; nothing internal (stack, SQL, ids of other tenants) is sent to the browser.
 */

export interface FieldProblemView {
  /** Where in the value: ["monday", 0, "close"], or a form field name. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ActionResult<T = null> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly problems?: readonly FieldProblemView[];
    };

export function ok<T>(value: T): ActionResult<T> {
  return { ok: true, value };
}

export function fail(error: string, problems?: readonly FieldProblemView[]): ActionResult<never> {
  return problems === undefined ? { ok: false, error } : { ok: false, error, problems };
}

/** A failure the action itself decided on, thrown to end the action early. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

function problemsOf(details: Readonly<Record<string, unknown>>): FieldProblemView[] | undefined {
  const raw = details["problems"] ?? details["issues"];
  if (!Array.isArray(raw)) return undefined;
  const problems: FieldProblemView[] = [];
  for (const item of raw.slice(0, 50)) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    // The settings store: { key, message, problems: [{ path, message }] }.
    if (Array.isArray(record["problems"]) && record["problems"].length > 0) {
      for (const nested of record["problems"] as unknown[]) {
        const inner = nested as { path?: unknown; message?: unknown };
        if (typeof inner.message !== "string") continue;
        problems.push({
          path: Array.isArray(inner.path)
            ? (inner.path as unknown[]).filter(
                (part): part is string | number =>
                  typeof part === "string" || typeof part === "number",
              )
            : [],
          message: inner.message,
        });
      }
      continue;
    }
    const message = record["message"];
    if (typeof message !== "string") continue;
    // Business profiles name a field, imports a column, playbooks a path ("priceNorms[2].highUsd").
    const field = record["field"] ?? record["column"] ?? record["path"];
    problems.push({ path: typeof field === "string" && field !== "" ? [field] : [], message });
  }
  return problems;
}

/** Turns anything thrown in an action into a result. Unexpected errors are logged. */
export function toFailure(error: unknown, logger: Logger, action: string): ActionResult<never> {
  if (error instanceof ActionError) return fail(error.message);
  if (error instanceof ValidationError) {
    const problems = problemsOf(error.details);
    // A message that lists its problems is replaced by the list itself.
    const message = error.message.includes("\n")
      ? (error.message.split("\n")[0] ?? "")
      : error.message;
    return fail(message, problems);
  }
  if (error instanceof NotFoundError) return fail(error.message);
  if (error instanceof TenantAccessError) {
    logger.warn("admin.action.denied", { action });
    // The settings store's own messages say which rule applied; others stay generic.
    return fail(
      error.name === "SettingsPermissionError"
        ? error.message
        : "You do not have permission to do that.",
    );
  }
  if (error instanceof AppError && error.code === "conflict") return fail(error.message);
  logger.error("admin.action.failed", { action, error });
  return fail("Something went wrong. Try again, and check the server log if it keeps failing.");
}
