/**
 * Sandboxed, deterministic expression evaluator for workflow transitions.
 *
 * Uses **jexl** (JavaScript Expression Language) to evaluate condition
 * expressions against an `ExpressionContext`. The evaluator is:
 *
 * - **Safe** — no access to `process`, `require`, `fs`, or Node.js globals
 * - **Deterministic** — same inputs always produce same output
 * - **Fast** — evaluation has a configurable timeout (default 100ms)
 *
 * @example
 * ```ts
 * const evaluator = new ExpressionEvaluator();
 * const result = await evaluator.evaluate('payload.count > 5', {
 *   payload: { count: 10 },
 * });
 * // result = { ok: true, data: true }
 * ```
 */

import jexl from 'jexl';
import type { Transition } from '../schemas/workflow.schema.js';
import type { Result } from '../utils/result.js';
import type { ExpressionContext } from './expression-context.js';
import { ExpressionErrorCode, type ExpressionError } from './expression-errors.js';
import { DAWELogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed expression length in characters. */
const MAX_EXPRESSION_LENGTH = 500;

/** Default evaluation timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 100;

/** Special condition strings that always evaluate to true (catch-all). */
const DEFAULT_CONDITIONS = new Set(['default', 'true']);

// ---------------------------------------------------------------------------
// ExpressionEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates jexl condition expressions against workflow contexts.
 *
 * Maintains a single jexl instance with safe, allowlisted transforms.
 * All evaluation is async with timeout protection.
 */
export class ExpressionEvaluator {
  private readonly jexlInstance: InstanceType<typeof jexl.Jexl>;
  private readonly timeoutMs: number;
  private readonly logger: DAWELogger;

  constructor(options?: { timeoutMs?: number; logger?: DAWELogger }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });

    // Create an isolated jexl instance
    this.jexlInstance = new jexl.Jexl();

    // Add safe, allowlisted transforms
    this.jexlInstance.addTransform('lower', (val: unknown) => String(val).toLowerCase());
    this.jexlInstance.addTransform('upper', (val: unknown) => String(val).toUpperCase());
    this.jexlInstance.addTransform('length', (val: unknown) =>
      Array.isArray(val) ? val.length : typeof val === 'string' ? val.length : 0,
    );
    this.jexlInstance.addTransform('trim', (val: unknown) => String(val).trim());
  }

  // -------------------------------------------------------------------------
  // Syntax validation
  // -------------------------------------------------------------------------

  /**
   * Validate expression syntax without evaluating.
   *
   * Checks length limits and attempts to compile the expression.
   * Does NOT evaluate — no context is needed.
   */
  validateSyntax(expression: string): Result<void, ExpressionError> {
    // Empty check
    if (!expression || expression.trim().length === 0) {
      return {
        ok: false,
        errors: {
          code: ExpressionErrorCode.INVALID_SYNTAX,
          message: 'Expression must not be empty',
          expression,
        },
      };
    }

    // Length check
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return {
        ok: false,
        errors: {
          code: ExpressionErrorCode.EXPRESSION_TOO_LONG,
          message: `Expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters (got ${expression.length})`,
          expression,
        },
      };
    }

    // Allow "default" and "true" as special catch-all conditions
    if (DEFAULT_CONDITIONS.has(expression)) {
      return { ok: true, data: undefined };
    }

    // Attempt to compile (checks syntax without evaluating)
    try {
      this.jexlInstance.compile(expression);
      return { ok: true, data: undefined };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errors: {
          code: ExpressionErrorCode.INVALID_SYNTAX,
          message: `Invalid expression syntax: ${message}`,
          expression,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Expression evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate an expression against a context object.
   *
   * - Expression must evaluate to a boolean.
   * - `null`/`undefined` property access evaluates to `false`.
   * - Evaluation is subject to a timeout (default 100ms).
   */
  async evaluate(expression: string, context: ExpressionContext): Promise<Result<boolean, ExpressionError>> {
    // Length check
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return {
        ok: false,
        errors: {
          code: ExpressionErrorCode.EXPRESSION_TOO_LONG,
          message: `Expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters (got ${expression.length})`,
          expression,
        },
      };
    }

    // Handle default/true catch-all
    if (DEFAULT_CONDITIONS.has(expression)) {
      return { ok: true, data: true };
    }

    try {
      // Cast context to Record for jexl — ExpressionContext has optional fields
      // which makes it not directly assignable to Record<string, unknown> under
      // exactOptionalPropertyTypes.
      const jexlContext: Record<string, unknown> = { ...context };
      const result = await Promise.race([
        this.jexlInstance.eval(expression, jexlContext),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('EXPRESSION_TIMEOUT'));
          }, this.timeoutMs);
        }),
      ]);

      // Null/undefined → false (design choice for optional payload fields)
      if (result === null || result === undefined) {
        this.logger.debug('Expression evaluated to null/undefined → false', { expression });
        return { ok: true, data: false };
      }

      // Must be boolean
      if (typeof result !== 'boolean') {
        this.logger.error(`Expression evaluated to non-boolean: ${typeof result}`, undefined, {
          expression,
          resultType: typeof result,
          code: 'E-003',
        });
        return {
          ok: false,
          errors: {
            code: ExpressionErrorCode.EXPRESSION_NOT_BOOLEAN,
            message: `Expression evaluated to ${typeof result} (${JSON.stringify(result)}), expected boolean`,
            expression,
          },
        };
      }

      this.logger.debug('Expression evaluated', { expression, result });
      return { ok: true, data: result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message === 'EXPRESSION_TIMEOUT') {
        this.logger.error(`Expression evaluation timed out after ${this.timeoutMs}ms`, undefined, {
          expression,
          timeoutMs: this.timeoutMs,
          code: 'E-004',
        });
        return {
          ok: false,
          errors: {
            code: ExpressionErrorCode.EXPRESSION_TIMEOUT,
            message: `Expression evaluation timed out after ${this.timeoutMs}ms`,
            expression,
          },
        };
      }

      this.logger.error(`Expression evaluation failed: ${message}`, undefined, {
        expression,
        code: 'E-002',
      });
      return {
        ok: false,
        errors: {
          code: ExpressionErrorCode.EVALUATION_FAILED,
          message: `Expression evaluation failed: ${message}`,
          expression,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Transition evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate ALL transitions for a node, returning the first matching target.
   *
   * Transitions are sorted by priority (ascending, lower = first) and
   * evaluated **sequentially** (first-match semantics).
   *
   * @returns The target nodeId of the first matching transition, or `null`
   *          if no transition matches.
   */
  async evaluateTransitions(
    transitions: Transition[],
    context: ExpressionContext,
  ): Promise<Result<string | null, ExpressionError>> {
    // Sort by priority (ascending). Transitions without priority default to 0.
    const sorted = [...transitions].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const transition of sorted) {
      const result = await this.evaluate(transition.condition, context);

      if (!result.ok) {
        return {
          ok: false,
          errors: {
            ...result.errors,
            context: `transition to "${transition.target}"`,
          },
        };
      }

      if (result.data === true) {
        return { ok: true, data: transition.target };
      }
    }

    // No transition matched
    return { ok: true, data: null };
  }

  // -------------------------------------------------------------------------
  // Expression explanation (P1)
  // -------------------------------------------------------------------------

  /**
   * Return a human-readable trace of how an expression was evaluated.
   *
   * Useful for debugging workflows — shows the expression, context,
   * and final result.
   */
  async explainEvaluation(expression: string, context: ExpressionContext): Promise<string> {
    const lines: string[] = [];
    lines.push(`Expression: ${expression}`);
    lines.push(`Context: ${JSON.stringify(context, null, 2)}`);

    // Handle default
    if (DEFAULT_CONDITIONS.has(expression)) {
      lines.push(`Result: true`);
      lines.push(`Trace: "${expression}" is a default/catch-all condition → true`);
      return lines.join('\n');
    }

    const result = await this.evaluate(expression, context);

    if (result.ok) {
      lines.push(`Result: ${result.data}`);

      // Build a simple trace by resolving identifiers from the expression
      const trace = this.buildTrace(expression, context);
      if (trace) {
        lines.push(`Trace: ${trace}`);
      }
    } else {
      lines.push(`Error: [${result.errors.code}] ${result.errors.message}`);
    }

    return lines.join('\n');
  }

  /**
   * Build a simple trace string resolving top-level identifiers.
   * Best-effort — does not parse the full jexl AST.
   */
  private buildTrace(expression: string, context: ExpressionContext): string | null {
    // Extract property paths like payload.foo.bar, action_result.exit_code, etc.
    const pathRegex = /(?:payload|action_result|metadata)(?:\.[a-zA-Z_]\w*(?:\[\d+\])?)+/g;
    const paths = expression.match(pathRegex);
    if (!paths || paths.length === 0) return null;

    const resolutions: string[] = [];
    for (const path of paths) {
      const value = this.resolvePath(path, context);
      resolutions.push(`${path} → ${JSON.stringify(value)}`);
    }

    return resolutions.join(', ');
  }

  /**
   * Resolve a dot-separated path against the context object.
   */
  private resolvePath(path: string, context: ExpressionContext): unknown {
    const parts = path.split('.');
    // Spread to Record for path traversal — we're just reading values
    let current: unknown = { ...context } as Record<string, unknown>;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;

      // Handle array index access like items[0]
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        current = (current as Record<string, unknown>)[arrayMatch[1]!];
        if (Array.isArray(current)) {
          current = current[Number(arrayMatch[2])];
        } else {
          return undefined;
        }
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    }

    return current;
  }
}
