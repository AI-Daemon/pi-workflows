/**
 * Handlebars wrapper with custom helpers for DAWE template resolution.
 *
 * Provides a pre-configured Handlebars instance with:
 * - `noEscape: true` — we generate CLI commands, not HTML
 * - `{{json value}}` helper — JSON.stringify a value for embedding
 * - `{{default value fallback}}` helper — fallback when value is missing/falsy
 *
 * Template errors are captured as structured `TemplateError` values
 * instead of thrown exceptions.
 */

import Handlebars from 'handlebars';
import type { Result } from '../utils/result.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Structured error from template compilation or resolution. */
export interface TemplateError {
  /** Machine-readable error code. */
  code: 'INVALID_TEMPLATE' | 'TEMPLATE_RESOLUTION_FAILED';
  /** Human-readable description of the error. */
  message: string;
  /** The template string that caused the error. */
  template: string;
}

// ---------------------------------------------------------------------------
// Handlebars instance
// ---------------------------------------------------------------------------

/** Isolated Handlebars environment with custom helpers. */
const hbs = Handlebars.create();

/**
 * `{{json value}}` — Serialize a value as a JSON string.
 * Useful for embedding structured data in prompts or commands.
 */
hbs.registerHelper('json', function (context: unknown): string {
  return JSON.stringify(context);
});

/**
 * `{{default value fallback}}` — Return `value` if truthy, else `fallback`.
 * Handlebars passes an options hash as the last argument, so we use
 * the positional args directly.
 */
hbs.registerHelper('default', function (value: unknown, defaultValue: unknown): unknown {
  return value ?? defaultValue;
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a Handlebars template string against the given context.
 *
 * @param template - A Handlebars template string, e.g. `"Hello, {{payload.name}}"`
 * @param context  - The data object to resolve against (typically `{ payload: ... }`)
 * @returns A `Result` containing the resolved string or a `TemplateError`
 */
export function resolveTemplate(template: string, context: Record<string, unknown>): Result<string, TemplateError> {
  let compiled: HandlebarsTemplateDelegate;
  try {
    compiled = hbs.compile(template, { noEscape: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: {
        code: 'INVALID_TEMPLATE',
        message: `Failed to compile template: ${message}`,
        template,
      },
    };
  }

  try {
    const result = compiled(context);
    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Handlebars defers parsing to resolution time, so parse errors
    // (e.g. "Parse error on line ...", mismatched blocks) surface here.
    // We classify them as INVALID_TEMPLATE rather than TEMPLATE_RESOLUTION_FAILED.
    const isParseError = message.includes('Parse error') || message.includes("doesn't match");
    return {
      ok: false,
      errors: {
        code: isParseError ? 'INVALID_TEMPLATE' : 'TEMPLATE_RESOLUTION_FAILED',
        message: `Failed to ${isParseError ? 'compile' : 'resolve'} template: ${message}`,
        template,
      },
    };
  }
}
