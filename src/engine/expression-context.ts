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
 * Workflow instance metadata tracked by the engine.
 *
 * Available in expressions as `$metadata.visits.<node_id>`, etc.
 */
export interface WorkflowMetadata {
  /** Per-node visit counts: node_id → visit count. */
  visits: Record<string, number>;
  /** SHA-256 state hashes for stall detection (populated by DAWE-017). */
  state_hashes: string[];
  /** The workflow instance ID. */
  instance_id: string;
  /** ISO 8601 timestamp when the instance was started. */
  started_at: string;
  /** Whether a stall was detected in a bounded cycle (set by DAWE-017). */
  stall_detected?: boolean;
}

/**
 * The context object passed to expression evaluation.
 *
 * Expressions can reference any top-level key:
 * - `payload.some_field` — accumulated workflow state
 * - `action_result.exit_code` — output from system_action nodes
 * - `metadata.some_key` — workflow-level metadata
 * - `$metadata.visits.<node_id>` — per-node visit counts (v2.0)
 */
export interface ExpressionContext {
  /** Accumulated workflow state (user-defined payload). */
  payload: Record<string, unknown>;
  /** Output from a system_action node (if the previous node was a system_action). */
  action_result?: ActionResult;
  /** Workflow-level metadata. */
  metadata?: Record<string, unknown>;
  /** Engine-tracked instance metadata (v2.0). Available as `$metadata` in expressions. */
  $metadata?: WorkflowMetadata;
}
