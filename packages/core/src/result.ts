/** Explicit success or failure for operations whose failure is an expected outcome. */
export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Compile-time exhaustiveness check for discriminated unions. */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unexpected ${context}: ${JSON.stringify(value)}`);
}
