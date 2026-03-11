/**
 * Schema validation error types and error code enum.
 */

/** Enumeration of all possible schema validation error codes. */
export enum SchemaErrorCode {
  /** The YAML string could not be parsed. */
  INVALID_YAML = 'INVALID_YAML',
  /** A required field is missing. */
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  /** A field has an incorrect type or value. */
  INVALID_FIELD_TYPE = 'INVALID_FIELD_TYPE',
  /** A node reference (initial_node or transition target) points to a nonexistent node. */
  INVALID_NODE_REFERENCE = 'INVALID_NODE_REFERENCE',
  /** The workflow has no terminal node. */
  MISSING_TERMINAL_NODE = 'MISSING_TERMINAL_NODE',
  /** The initial_node points to a terminal node. */
  INITIAL_NODE_IS_TERMINAL = 'INITIAL_NODE_IS_TERMINAL',
  /** A terminal node incorrectly has transitions. */
  TERMINAL_HAS_TRANSITIONS = 'TERMINAL_HAS_TRANSITIONS',
  /** A non-terminal node has zero transitions. */
  NON_TERMINAL_NO_TRANSITIONS = 'NON_TERMINAL_NO_TRANSITIONS',
  /** The workflow_name does not match the required pattern. */
  INVALID_WORKFLOW_NAME = 'INVALID_WORKFLOW_NAME',
  /** The workflow_name collides with an existing workflow name. */
  DUPLICATE_WORKFLOW_NAME = 'DUPLICATE_WORKFLOW_NAME',
  /** A condition expression has invalid syntax. */
  INVALID_EXPRESSION_SYNTAX = 'INVALID_EXPRESSION_SYNTAX',
}

/**
 * A structured validation error with a YAML path, human-readable message,
 * and a machine-readable error code.
 */
export interface ValidationError {
  /** Dot-separated path to the offending field (e.g., `nodes.assess_intent.transitions[0].target`). */
  path: string;
  /** Human-readable description of the error. */
  message: string;
  /** Machine-readable error code from SchemaErrorCode. */
  code: string;
}
