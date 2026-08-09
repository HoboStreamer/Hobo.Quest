/**
 * Explicit success/failure results for domain operations that can fail for
 * expected reasons (inventory full, missing ingredients, out of range...).
 * Exceptions are reserved for programming errors and infrastructure failures.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}
