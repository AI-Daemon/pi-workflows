/**
 * ErrorCollector — Accumulates multiple DAWEErrors before failing.
 *
 * Used in validation pipelines (schema, graph) where many errors can
 * be collected in a single pass instead of failing on the first one.
 */

import type { Result } from './result.js';
import type { ErrorCategory, DAWEError } from './errors.js';

export class ErrorCollector {
  private readonly errors: DAWEError[] = [];

  /** Add an error to the collection. */
  add(error: DAWEError): void {
    this.errors.push(error);
  }

  /** Whether any errors have been collected. */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /** Whether any fatal-severity error has been collected. */
  hasFatal(): boolean {
    return this.errors.some((e) => e.severity === 'fatal');
  }

  /** Return all collected errors. */
  getErrors(): DAWEError[] {
    return [...this.errors];
  }

  /** Return errors matching a specific category. */
  getByCategory(category: ErrorCategory): DAWEError[] {
    return this.errors.filter((e) => e.category === category);
  }

  /**
   * Convert the collector state into a Result.
   *
   * If there are no errors, returns `{ ok: true, data }`.
   * If there are errors, returns `{ ok: false, errors }`.
   */
  toResult<T>(data?: T): Result<T, DAWEError[]> {
    if (this.errors.length === 0) {
      return { ok: true, data: data as T };
    }
    return { ok: false, errors: [...this.errors] };
  }

  /** Human-readable summary of all collected errors. */
  toSummary(): string {
    if (this.errors.length === 0) {
      return 'No errors.';
    }

    const lines: string[] = [];
    lines.push(`${this.errors.length} error(s):`);

    for (const error of this.errors) {
      lines.push(`  [${error.code}] (${error.severity}) ${error.message}`);
    }

    return lines.join('\n');
  }
}
