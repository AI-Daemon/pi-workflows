/**
 * Error Code Registry — Single source of truth for all DAWE error codes.
 *
 * Error codes follow the pattern: `{category_prefix}-{three_digit_number}`
 *   - S-xxx: Schema errors
 *   - G-xxx: Graph structural errors
 *   - E-xxx: Expression evaluation errors
 *   - R-xxx: Runtime lifecycle errors
 *   - X-xxx: Execution / system action errors
 *   - C-xxx: Cycle safety errors (v2.0)
 *   - P-xxx: Payload errors
 *
 * Every error code maps to a severity, category, and human-readable message.
 * Recoverable errors include an `agentHint` to guide the LLM.
 */

import type { ErrorCategory, ErrorSeverity } from './errors.js';

// ---------------------------------------------------------------------------
// Error code entry type
// ---------------------------------------------------------------------------

/** Shape of a single entry in the error code registry. */
export interface ErrorCodeEntry {
  /** Human-readable error message (may include placeholders). */
  message: string;
  /** Error category. */
  category: ErrorCategory;
  /** Whether the error is recoverable by the agent. */
  recoverable: boolean;
  /** Severity level (defaults to 'error' if omitted). */
  severity?: ErrorSeverity;
  /** LLM-facing recovery hint (present for recoverable errors). */
  agentHint?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  // =========================================================================
  // Schema errors (S-xxx)
  // =========================================================================
  'S-001': {
    message: 'Invalid YAML syntax',
    category: 'schema',
    recoverable: false,
  },
  'S-002': {
    message: 'Missing required field',
    category: 'schema',
    recoverable: false,
  },
  'S-003': {
    message: 'Invalid field type',
    category: 'schema',
    recoverable: false,
  },
  'S-004': {
    message: 'Invalid node reference',
    category: 'schema',
    recoverable: false,
  },
  'S-005': {
    message: 'Missing terminal node',
    category: 'schema',
    recoverable: false,
  },
  'S-006': {
    message: 'Initial node is terminal',
    category: 'schema',
    recoverable: false,
  },
  'S-007': {
    message: 'Terminal node has transitions',
    category: 'schema',
    recoverable: false,
  },
  'S-008': {
    message: 'Non-terminal node has no transitions',
    category: 'schema',
    recoverable: false,
  },
  'S-009': {
    message: 'Invalid workflow name',
    category: 'schema',
    recoverable: false,
  },
  'S-010': {
    message: 'Duplicate workflow name',
    category: 'schema',
    recoverable: false,
  },
  'S-011': {
    message: 'Invalid expression syntax in condition',
    category: 'schema',
    recoverable: false,
  },

  // =========================================================================
  // Graph errors (G-xxx)
  // =========================================================================
  'G-001': {
    message: 'Cycle detected (v1.0 DAG violation)',
    category: 'graph',
    recoverable: false,
  },
  'G-002': {
    message: 'Unreachable node',
    category: 'graph',
    recoverable: false,
  },
  'G-003': {
    message: 'No path to terminal',
    category: 'graph',
    recoverable: false,
  },
  'G-004': {
    message: 'Unbounded cycle — back-edge target missing max_visits',
    category: 'graph',
    recoverable: false,
  },
  'G-005': {
    message: 'Orphaned node',
    category: 'graph',
    recoverable: false,
  },
  'G-006': {
    message: 'Maximum graph depth exceeded',
    category: 'graph',
    recoverable: false,
  },

  // =========================================================================
  // Expression errors (E-xxx)
  // =========================================================================
  'E-001': {
    message: 'Invalid expression syntax',
    category: 'expression',
    recoverable: false,
  },
  'E-002': {
    message: 'Expression evaluation failed',
    category: 'expression',
    recoverable: false,
  },
  'E-003': {
    message: 'Expression did not return boolean',
    category: 'expression',
    recoverable: false,
  },
  'E-004': {
    message: 'Expression evaluation timed out',
    category: 'expression',
    recoverable: false,
  },
  'E-005': {
    message: 'Expression exceeds maximum length',
    category: 'expression',
    recoverable: false,
  },

  // =========================================================================
  // Runtime errors (R-xxx)
  // =========================================================================
  'R-001': {
    message: 'No matching transition',
    category: 'runtime',
    recoverable: true,
    agentHint: 'Check your payload values against the transition conditions.',
  },
  'R-002': {
    message: 'Node mismatch',
    category: 'runtime',
    recoverable: true,
    agentHint: 'You submitted data for the wrong node. Check the current_node_id.',
  },
  'R-003': {
    message: 'Payload validation failed',
    category: 'runtime',
    recoverable: true,
    agentHint: 'Your payload is missing required fields. Review the required schema.',
  },
  'R-004': {
    message: 'Instance not active',
    category: 'runtime',
    recoverable: false,
  },
  'R-005': {
    message: 'Budget exhausted — max_visits reached with no fallback transition',
    category: 'runtime',
    recoverable: false,
    agentHint: 'The test-fix cycle has exhausted its retry budget. The workflow requires human intervention.',
  },
  'R-006': {
    message: 'Workflow not found',
    category: 'runtime',
    recoverable: false,
  },
  'R-007': {
    message: 'Instance not found',
    category: 'runtime',
    recoverable: false,
  },
  'R-008': {
    message: 'Expression evaluation failed during transition resolution',
    category: 'runtime',
    recoverable: false,
  },
  'R-009': {
    message: 'System action chain exceeded maximum length',
    category: 'runtime',
    recoverable: false,
  },
  'R-010': {
    message: 'System action failed',
    category: 'runtime',
    recoverable: true,
    agentHint: 'The system action command failed. Check the command output for details.',
  },

  // =========================================================================
  // Execution errors (X-xxx)
  // =========================================================================
  'X-001': {
    message: 'System action timed out',
    category: 'execution',
    recoverable: true,
    agentHint: 'The command exceeded its timeout. Consider a longer timeout or simpler command.',
  },
  'X-002': {
    message: 'System action failed',
    category: 'execution',
    recoverable: true,
  },
  'X-003': {
    message: 'Command blocked by security policy',
    category: 'security',
    recoverable: false,
  },
  'X-004': {
    message: 'JSON extraction failed — falling back to file pointer',
    category: 'execution',
    recoverable: true,
    severity: 'warning',
    agentHint: 'The extract_json file could not be parsed. Use the log_pointer_path for raw output.',
  },
  'X-005': {
    message: 'File pointer write failed',
    category: 'execution',
    recoverable: true,
    severity: 'warning',
  },

  // =========================================================================
  // Cycle safety errors (C-xxx) — v2.0
  // =========================================================================
  'C-001': {
    message: 'Stall detected — workspace state identical to previous iteration',
    category: 'cycle',
    recoverable: false,
    agentHint: 'You applied the same fix as a previous attempt. The workflow has been suspended for human review.',
  },

  // =========================================================================
  // Payload errors (P-xxx)
  // =========================================================================
  'P-001': {
    message: 'Payload merge failed — protected key overwrite attempt',
    category: 'payload',
    recoverable: true,
    agentHint: 'Your payload tried to overwrite a protected internal key ($metadata).',
  },
  'P-002': {
    message: 'Template resolution failed in payload',
    category: 'payload',
    recoverable: false,
  },
} as const satisfies Record<string, ErrorCodeEntry>;

/** All valid error code strings. */
export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Look up an error code entry.
 * Returns undefined if the code is not in the registry.
 */
export function getErrorCodeEntry(code: string): ErrorCodeEntry | undefined {
  return (ERROR_CODES as Record<string, ErrorCodeEntry>)[code];
}
