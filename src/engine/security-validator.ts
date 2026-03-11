/**
 * Security validator for system action commands.
 *
 * Validates commands against a configurable set of blocked patterns
 * before execution. Prevents dangerous operations like:
 * - Recursive deletion of root
 * - Fork bombs
 * - Direct block device writes
 * - Filesystem formatting
 * - Pipe-to-shell attacks
 * - Sensitive file access
 */

import type { Result } from '../utils/result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Security validation error codes. */
export type SecurityErrorCode =
  | 'BLOCKED_COMMAND'
  | 'INVALID_WORKING_DIR'
  | 'PATH_TRAVERSAL'
  | 'TEMPLATE_INJECTION'
  | 'EMPTY_COMMAND';

/** Structured error from security validation. */
export interface SecurityError {
  /** Machine-readable error code. */
  code: SecurityErrorCode;
  /** Human-readable description. */
  message: string;
  /** The command that was validated. */
  command: string;
  /** The blocked pattern that matched (if applicable). */
  pattern?: string;
}

// ---------------------------------------------------------------------------
// Default blocked patterns
// ---------------------------------------------------------------------------

/** Default set of blocked command patterns. */
export const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//, // rm -rf /
  /:\(\)\s*\{.*\}.*;\s*:/, // fork bomb
  />\s*\/dev\/sd/, // write to block device
  /mkfs/, // format filesystem
  /dd\s+if=/, // raw disk copy
  /curl.*\|\s*bash/, // pipe curl to bash
  /wget.*\|\s*bash/, // pipe wget to bash
  /eval\s*\(/, // eval in command
  /\/etc\/passwd/, // password file access
  /\/etc\/shadow/, // shadow file access
];

// ---------------------------------------------------------------------------
// SecurityValidator
// ---------------------------------------------------------------------------

export class SecurityValidator {
  private readonly blockedPatterns: RegExp[];

  constructor(additionalPatterns?: RegExp[]) {
    this.blockedPatterns = [...DEFAULT_BLOCKED_PATTERNS, ...(additionalPatterns ?? [])];
  }

  /**
   * Validate a command string against all blocked patterns.
   *
   * @param command - The resolved command string to validate.
   * @returns `Result<void, SecurityError>` — ok if safe, error if blocked.
   */
  validate(command: string): Result<void, SecurityError> {
    // Empty command check
    if (!command || command.trim().length === 0) {
      return {
        ok: false,
        errors: {
          code: 'EMPTY_COMMAND',
          message: 'Command must not be empty',
          command,
        },
      };
    }

    // Check against all blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(command)) {
        return {
          ok: false,
          errors: {
            code: 'BLOCKED_COMMAND',
            message: `Command matches blocked pattern: ${pattern.source}`,
            command,
            pattern: pattern.source,
          },
        };
      }
    }

    return { ok: true, data: undefined };
  }
}
