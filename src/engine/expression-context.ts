/**
 * Expression evaluation context types.
 *
 * Defines the shape of data available to condition expressions
 * during transition evaluation.
 */

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Output from a system_action node execution. */
export interface ActionResult {
  /** Process exit code (0 = success). */
  exit_code: number;
  /** Standard output from the command. */
  stdout: string;
  /** Standard error output from the command. */
  stderr: string;
  /** Parsed JSON output if available. */
  data?: Record<string, unknown>;
}

/**
 * The context object passed to expression evaluation.
 *
 * Expressions can reference any top-level key:
 * - `payload.some_field` — accumulated workflow state
 * - `action_result.exit_code` — output from system_action nodes
 * - `metadata.some_key` — workflow-level metadata
 */
export interface ExpressionContext {
  /** Accumulated workflow state (user-defined payload). */
  payload: Record<string, unknown>;
  /** Output from a system_action node (if the previous node was a system_action). */
  action_result?: ActionResult;
  /** Workflow-level metadata. */
  metadata?: Record<string, unknown>;
}
