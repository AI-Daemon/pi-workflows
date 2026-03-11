/**
 * Types for system action execution results.
 *
 * `ActionResult` captures everything about a command execution:
 * exit code, output streams, parsed JSON data, timing, and
 * the fully-resolved command that was run.
 *
 * `ExecutorOptions` configures the executor's security boundaries,
 * timeouts, working directory, and environment.
 */

// ---------------------------------------------------------------------------
// ActionResult (execution output)
// ---------------------------------------------------------------------------

/**
 * Result of executing a system action command.
 *
 * Note: This is distinct from the `ActionResult` in `expression-context.ts`,
 * which is a simplified view used for expression evaluation. This type
 * contains the full execution metadata.
 */
export interface ExecutorActionResult {
  /** Process exit code (0 = success, non-zero = failure, -1 = timed out). */
  exit_code: number;
  /** Standard output from the command. */
  stdout: string;
  /** Standard error output from the command. */
  stderr: string;
  /** Parsed JSON output if stdout was valid JSON. */
  data?: Record<string, unknown>;
  /** Execution duration in milliseconds. */
  duration_ms: number;
  /** Whether the command was killed due to timeout. */
  timed_out: boolean;
  /** The fully resolved command after template interpolation. */
  command_executed: string;
}

// ---------------------------------------------------------------------------
// ExecutorOptions (configuration)
// ---------------------------------------------------------------------------

/** Configuration options for the SystemActionExecutor. */
export interface ExecutorOptions {
  /** Default timeout in milliseconds (default: 30000). */
  defaultTimeout: number;
  /** Maximum allowed timeout in milliseconds (default: 300000 = 5 min). */
  maxTimeout: number;
  /** Default working directory for command execution. */
  workingDir: string;
  /** Whitelisted directories for file access (not enforced at OS level, advisory). */
  allowedPaths?: string[];
  /** Additional command patterns to reject (regex). */
  blockedCommands?: RegExp[];
  /** Base environment variables for all commands. */
  env?: Record<string, string>;
  /** Shell to use (default: '/bin/bash'). */
  shell?: string;
}

// ---------------------------------------------------------------------------
// Streaming callbacks
// ---------------------------------------------------------------------------

/** Optional callbacks for streaming command output in real time. */
export interface StreamingCallbacks {
  /** Called with each chunk of stdout data. */
  onStdout?: (chunk: string) => void;
  /** Called with each chunk of stderr data. */
  onStderr?: (chunk: string) => void;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

/** Retry configuration for system action nodes. */
export interface RetryConfig {
  /** Maximum number of retry attempts. */
  max_attempts: number;
  /** Base backoff delay in milliseconds between retries. */
  backoff_ms: number;
  /** Specific exit codes to retry on. If omitted, retry on all non-zero. */
  retry_on_exit_codes?: number[];
}
