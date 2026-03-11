/**
 * Runtime error types and error codes for the Workflow Runtime Engine.
 *
 * Used by `WorkflowRuntime` to report errors during workflow lifecycle
 * operations: loading, instantiation, advancement, and cancellation.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Enumeration of all possible runtime error codes. */
export enum RuntimeErrorCode {
  /** The requested workflow definition was not found. */
  WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  /** The requested workflow instance was not found. */
  INSTANCE_NOT_FOUND = 'INSTANCE_NOT_FOUND',
  /** The instance is not in an active/waiting state. */
  INSTANCE_NOT_ACTIVE = 'INSTANCE_NOT_ACTIVE',
  /** The provided nodeId does not match the instance's current node. */
  NODE_MISMATCH = 'NODE_MISMATCH',
  /** The agent's payload failed validation against the node schema. */
  PAYLOAD_VALIDATION_FAILED = 'PAYLOAD_VALIDATION_FAILED',
  /** No transition matched after evaluating all conditions. */
  NO_MATCHING_TRANSITION = 'NO_MATCHING_TRANSITION',
  /** An expression evaluation failed during transition resolution. */
  EXPRESSION_ERROR = 'EXPRESSION_ERROR',
  /** System action chain exceeded the maximum allowed length. */
  SYSTEM_ACTION_CHAIN_LIMIT = 'SYSTEM_ACTION_CHAIN_LIMIT',
  /** A system action execution failed (security violation, etc.). */
  SYSTEM_ACTION_FAILED = 'SYSTEM_ACTION_FAILED',
  /** All transitions are blocked because target nodes have exhausted their max_visits budget. */
  BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED',
  /** Stall detected — workspace state is identical to a previous cycle iteration. */
  STALL_DETECTED = 'STALL_DETECTED',
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Structured error from the workflow runtime. */
export interface RuntimeError {
  /** Machine-readable error code. */
  code: RuntimeErrorCode;
  /** Human-readable description of the error. */
  message: string;
  /** The instance ID involved (if applicable). */
  instanceId?: string;
  /** The node ID involved (if applicable). */
  nodeId?: string;
}
