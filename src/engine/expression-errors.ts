/**
 * Error types and codes for the expression evaluator.
 *
 * Used by `ExpressionEvaluator` to report syntax errors, evaluation
 * failures, type mismatches, timeouts, and length violations.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Enumeration of all possible expression error codes. */
export enum ExpressionErrorCode {
  /** The expression string has invalid syntax. */
  INVALID_SYNTAX = 'INVALID_SYNTAX',
  /** Expression evaluation failed at runtime. */
  EVALUATION_FAILED = 'EVALUATION_FAILED',
  /** Expression evaluated to a non-boolean value. */
  EXPRESSION_NOT_BOOLEAN = 'EXPRESSION_NOT_BOOLEAN',
  /** Expression evaluation exceeded the timeout. */
  EXPRESSION_TIMEOUT = 'EXPRESSION_TIMEOUT',
  /** Expression string exceeds the maximum allowed length. */
  EXPRESSION_TOO_LONG = 'EXPRESSION_TOO_LONG',
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Structured error from expression validation or evaluation. */
export interface ExpressionError {
  /** Machine-readable error code. */
  code: ExpressionErrorCode;
  /** Human-readable description of the error. */
  message: string;
  /** The expression string that caused the error. */
  expression: string;
  /** Optional context — which node/transition this error occurred in. */
  context?: string;
}
