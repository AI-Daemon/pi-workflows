/**
 * Discriminated union Result type for typed success/error handling.
 * Shared across the codebase for consistent error propagation.
 */
export type Result<T, E> = { ok: true; data: T } | { ok: false; errors: E };
