/**
 * SystemActionExecutor — Secure, sandboxed executor for `system_action` nodes.
 *
 * Executes bash and Node.js commands natively without LLM intervention.
 * Provides:
 * - Template resolution with auto shell-escaping
 * - Timeout enforcement (SIGTERM → wait → SIGKILL)
 * - Output capture with size limits
 * - Security validation against blocked patterns
 * - Environment variable injection
 * - Working directory validation
 * - Dry-run mode
 * - Streaming output callbacks
 * - Retry logic with exponential backoff
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

import type { SystemActionNode } from '../schemas/workflow.schema.js';
import type { ExpressionContext } from './expression-context.js';
import type { Result } from '../utils/result.js';
import type { ExecutorActionResult, ExecutorOptions, StreamingCallbacks, RetryConfig } from './action-result.js';
import { SecurityValidator, type SecurityError } from './security-validator.js';
import { shellEscape } from './shell-escape.js';
import { resolveTemplate } from './template-engine.js';
import { DAWELogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum stdout capture size in bytes (1 MB). */
const MAX_STDOUT_BYTES = 1_048_576;

/** Maximum stderr capture size in bytes (256 KB). */
const MAX_STDERR_BYTES = 262_144;

/** Truncation marker appended when output exceeds limits. */
const TRUNCATION_MARKER = '\n[TRUNCATED]';

/** Grace period after SIGTERM before SIGKILL (ms). */
const SIGKILL_GRACE_MS = 5_000;

/** Directory for file pointer logs. */
export const FILE_POINTER_DIR = '/tmp/dawe-runs';

/** Default executor options. */
const DEFAULT_OPTIONS: ExecutorOptions = {
  defaultTimeout: 30_000,
  maxTimeout: 300_000,
  workingDir: process.cwd(),
  shell: '/bin/bash',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Handlebars template with auto-shell-escaping for
 * system_action nodes.
 *
 * All `{{payload.x}}` references are automatically shell-escaped.
 * Use `{{{raw_payload.x}}}` triple-stache for unescaped access.
 *
 * We build a context where payload values are pre-escaped so that
 * standard Handlebars `{{...}}` (which we configure with noEscape)
 * outputs the shell-safe value.
 */
function resolveCommandTemplate(
  command: string,
  context: ExpressionContext,
): Result<string, { code: string; message: string }> {
  // Build a context with shell-escaped payload values
  const escapedPayload = escapePayloadValues(context.payload);

  // Build template context:
  // - `payload.*` → shell-escaped values
  // - `raw_payload.*` → unescaped values (accessible via triple-stache {{{raw_payload.x}}})
  const templateContext: Record<string, unknown> = {
    payload: escapedPayload,
    raw_payload: context.payload,
  };

  if (context.action_result) {
    templateContext['action_result'] = context.action_result;
  }

  if (context.metadata) {
    templateContext['metadata'] = context.metadata;
  }

  const result = resolveTemplate(command, templateContext);
  if (!result.ok) {
    return {
      ok: false,
      errors: {
        code: result.errors.code,
        message: result.errors.message,
      },
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Recursively shell-escape all string values in a payload object.
 * Non-string primitives (numbers, booleans, null) are converted to
 * shell-escaped strings. Objects and arrays are recursed.
 */
function escapePayloadValues(obj: Record<string, unknown>): Record<string, unknown> {
  const escaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      escaped[key] = '';
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      escaped[key] = escapePayloadValues(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      escaped[key] = value.map((v) =>
        typeof v === 'object' && v !== null ? escapePayloadValues(v as Record<string, unknown>) : shellEscape(v),
      );
    } else {
      escaped[key] = shellEscape(value);
    }
  }
  return escaped;
}

/**
 * Validate that a working directory exists and is a directory.
 */
function validateWorkingDir(dir: string): Result<void, SecurityError> {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      errors: {
        code: 'INVALID_WORKING_DIR',
        message: `Working directory does not exist: ${resolved}`,
        command: '',
      },
    };
  }

  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      return {
        ok: false,
        errors: {
          code: 'INVALID_WORKING_DIR',
          message: `Working directory path is not a directory: ${resolved}`,
          command: '',
        },
      };
    }
  } catch {
    return {
      ok: false,
      errors: {
        code: 'INVALID_WORKING_DIR',
        message: `Cannot stat working directory: ${resolved}`,
        command: '',
      },
    };
  }

  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// SystemActionExecutor
// ---------------------------------------------------------------------------

export class SystemActionExecutor {
  private readonly options: ExecutorOptions;
  private readonly securityValidator: SecurityValidator;
  private readonly logger: DAWELogger;

  constructor(options?: Partial<ExecutorOptions> & { logger?: DAWELogger }) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.securityValidator = new SecurityValidator(this.options.blockedCommands);
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a system_action node's command.
   *
   * 1. Resolves template variables (with auto shell-escaping)
   * 2. Validates the command against security patterns
   * 3. Validates the working directory
   * 4. Spawns the process with timeout enforcement
   * 5. Captures stdout/stderr with size limits
   * 6. Returns structured `ExecutorActionResult`
   *
   * @param node    - The system_action node definition from the workflow.
   * @param context - Expression context containing payload, action_result, metadata.
   * @param callbacks - Optional streaming callbacks for real-time output.
   * @returns The execution result or a SecurityError.
   */
  async execute(
    node: SystemActionNode,
    context: ExpressionContext,
    callbacks?: StreamingCallbacks,
  ): Promise<Result<ExecutorActionResult, SecurityError>> {
    // 1. Security validation on the raw command template (before resolution).
    //    This catches dangerous patterns in the workflow definition itself.
    //    Payload values are shell-escaped during resolution, so they cannot
    //    introduce dangerous patterns — we validate the template, not the
    //    resolved command, to avoid false positives from escaped values.
    const validationResult = this.validateCommand(node.command);
    if (!validationResult.ok) {
      this.logger.error('Command blocked by security policy', undefined, {
        command: node.command,
        code: 'X-003',
        pattern: validationResult.errors.pattern,
      });
      return validationResult as Result<ExecutorActionResult, SecurityError>;
    }

    // 2. Resolve command template (with auto shell-escaping)
    const resolveResult = resolveCommandTemplate(node.command, context);
    if (!resolveResult.ok) {
      return {
        ok: false,
        errors: {
          code: 'TEMPLATE_INJECTION',
          message: resolveResult.errors.message,
          command: node.command,
        },
      };
    }
    const resolvedCommand = resolveResult.data;

    // 3. Working directory validation
    const workDir = node.working_dir ?? this.options.workingDir;
    const wdResult = validateWorkingDir(workDir);
    if (!wdResult.ok) {
      wdResult.errors.command = resolvedCommand;
      return wdResult as unknown as Result<ExecutorActionResult, SecurityError>;
    }

    // 4. Compute timeout
    const timeoutMs = this.computeTimeout(node.timeout_seconds);

    // 5. Build environment
    const env = this.buildEnv(node, context);

    // 6. Execute
    this.logger.info('System action started', {
      runtime: node.runtime,
      command: resolvedCommand.substring(0, 200),
      workDir,
      timeoutMs,
    });

    const result = await this.spawnCommand(node.runtime, resolvedCommand, workDir, env, timeoutMs, callbacks);

    if (result.timed_out) {
      this.logger.warn('System action timed out', {
        command: resolvedCommand.substring(0, 200),
        timeoutMs,
        durationMs: result.duration_ms,
        code: 'X-001',
      });
    } else {
      this.logger.info('System action completed', {
        command: resolvedCommand.substring(0, 200),
        exitCode: result.exit_code,
        durationMs: result.duration_ms,
      });
    }

    return { ok: true, data: result };
  }

  /**
   * Write a file pointer log for a system_action execution.
   *
   * Streams full stdout + stderr to a structured log file at:
   *   /tmp/dawe-runs/<instanceId>-<nodeId>-<visitCount>.log
   *
   * @param instanceId - The workflow instance ID.
   * @param nodeId - The system_action node ID.
   * @param visitCount - The current visit count for this node.
   * @param command - The resolved command that was executed.
   * @param result - The execution result.
   * @returns The file path of the written log, or null on failure.
   */
  writeFilePointerLog(
    instanceId: string,
    nodeId: string,
    visitCount: number,
    command: string,
    result: ExecutorActionResult,
  ): string | null {
    try {
      const dir = FILE_POINTER_DIR;
      mkdirSync(dir, { recursive: true });

      const fileName = `${instanceId}-${nodeId}-${visitCount}.log`;
      const filePath = join(dir, fileName);

      const content = [
        '=== DAWE System Action Log ===',
        `Instance: ${instanceId}`,
        `Node: ${nodeId}`,
        `Visit: ${visitCount}`,
        `Command: ${command}`,
        `Exit Code: ${result.exit_code}`,
        `Timestamp: ${new Date().toISOString()}`,
        '',
        '=== STDOUT ===',
        result.stdout,
        '',
        '=== STDERR ===',
        result.stderr,
      ].join('\n');

      writeFileSync(filePath, content, 'utf-8');
      this.logger.debug('File pointer log written', { filePath, instanceId, nodeId, visitCount });
      return filePath;
    } catch (err) {
      this.logger.warn('File pointer write failed', {
        instanceId,
        nodeId,
        visitCount,
        code: 'X-005',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Clean up all file pointer logs for a given instance.
   *
   * Called when a workflow instance reaches a terminal state.
   *
   * @param instanceId - The workflow instance ID.
   * @returns The number of files cleaned up, or -1 on failure.
   */
  cleanupFilePointerLogs(instanceId: string): number {
    try {
      const dir = FILE_POINTER_DIR;
      if (!existsSync(dir)) return 0;

      const files = readdirSync(dir).filter((f) => f.startsWith(`${instanceId}-`));
      let cleaned = 0;
      for (const file of files) {
        try {
          unlinkSync(join(dir, file));
          cleaned++;
        } catch {
          // Individual file cleanup failure — continue
        }
      }
      return cleaned;
    } catch {
      return -1;
    }
  }

  /**
   * Validate a command before execution.
   *
   * Checks against blocked patterns and security rules.
   * Runs BEFORE execution, not after.
   */
  validateCommand(command: string): Result<void, SecurityError> {
    return this.securityValidator.validate(command);
  }

  /**
   * Dry-run mode: resolve the command template without executing.
   *
   * Returns an `ExecutorActionResult` with `exit_code: 0`, empty stdout/stderr,
   * and `command_executed` set to the resolved command string.
   */
  dryRun(node: SystemActionNode, context: ExpressionContext): Result<ExecutorActionResult, SecurityError> {
    // 1. Validate the raw template
    const validationResult = this.validateCommand(node.command);
    if (!validationResult.ok) {
      return validationResult as Result<ExecutorActionResult, SecurityError>;
    }

    // 2. Resolve template
    const resolveResult = resolveCommandTemplate(node.command, context);
    if (!resolveResult.ok) {
      return {
        ok: false,
        errors: {
          code: 'TEMPLATE_INJECTION',
          message: resolveResult.errors.message,
          command: node.command,
        },
      };
    }
    const resolvedCommand = resolveResult.data;

    return {
      ok: true,
      data: {
        exit_code: 0,
        stdout: '',
        stderr: '',
        duration_ms: 0,
        timed_out: false,
        command_executed: resolvedCommand,
      },
    };
  }

  /**
   * Execute with retry logic.
   *
   * Retries the command on non-zero exit codes with exponential backoff.
   *
   * @param node    - The system_action node definition.
   * @param context - Expression context.
   * @param retry   - Retry configuration.
   * @param callbacks - Optional streaming callbacks.
   * @returns The final execution result (last attempt).
   */
  async executeWithRetry(
    node: SystemActionNode,
    context: ExpressionContext,
    retry: RetryConfig,
    callbacks?: StreamingCallbacks,
  ): Promise<Result<ExecutorActionResult, SecurityError>> {
    let lastResult: Result<ExecutorActionResult, SecurityError> | undefined;

    for (let attempt = 0; attempt <= retry.max_attempts; attempt++) {
      lastResult = await this.execute(node, context, callbacks);

      // If execution itself failed (security error, etc.), don't retry
      if (!lastResult.ok) {
        return lastResult;
      }

      // If success (exit_code 0), return immediately
      if (lastResult.data.exit_code === 0) {
        return lastResult;
      }

      // Check if we should retry on this exit code
      if (retry.retry_on_exit_codes && retry.retry_on_exit_codes.length > 0) {
        if (!retry.retry_on_exit_codes.includes(lastResult.data.exit_code)) {
          return lastResult;
        }
      }

      // Don't wait after the last attempt
      if (attempt < retry.max_attempts) {
        const delay = retry.backoff_ms * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should always be set by the loop, but TypeScript needs this
    return lastResult!;
  }

  // -----------------------------------------------------------------------
  // Private methods
  // -----------------------------------------------------------------------

  /**
   * Compute the effective timeout in milliseconds.
   *
   * Uses the node's `timeout_seconds` if provided, otherwise falls back
   * to `defaultTimeout`. Clamps to `maxTimeout`.
   */
  private computeTimeout(timeoutSeconds?: number): number {
    if (timeoutSeconds !== undefined) {
      const ms = timeoutSeconds * 1000;
      return Math.min(ms, this.options.maxTimeout);
    }
    return this.options.defaultTimeout;
  }

  /**
   * Build the environment variables for the child process.
   *
   * Layers:
   * 1. Current process env (inherit)
   * 2. Base env from ExecutorOptions
   * 3. Node-specific env (overrides base)
   * 4. Auto-injected DAWE_* variables
   */
  private buildEnv(node: SystemActionNode, context: ExpressionContext): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(this.options.env ?? {}),
      ...(node.env ?? {}),
    };

    // Auto-inject DAWE variables
    const wfName = context.metadata?.['workflow_name'];
    if (typeof wfName === 'string' || typeof wfName === 'number') {
      env['DAWE_WORKFLOW_NAME'] = String(wfName);
    }
    const nodeId = context.metadata?.['node_id'];
    if (typeof nodeId === 'string' || typeof nodeId === 'number') {
      env['DAWE_NODE_ID'] = String(nodeId);
    }
    const instId = context.metadata?.['instance_id'];
    if (typeof instId === 'string' || typeof instId === 'number') {
      env['DAWE_INSTANCE_ID'] = String(instId);
    }

    return env;
  }

  /**
   * Spawn a child process and capture its output.
   *
   * Uses `spawn` (not `exec`) for fine-grained control over:
   * - SIGTERM → 5s grace → SIGKILL timeout handling
   * - Streaming output callbacks
   * - Output size limits
   */
  private spawnCommand(
    runtime: 'bash' | 'node',
    command: string,
    workDir: string,
    env: Record<string, string>,
    timeoutMs: number,
    callbacks?: StreamingCallbacks,
  ): Promise<ExecutorActionResult> {
    return new Promise((promiseResolve) => {
      const startTime = Date.now();
      let timedOut = false;
      let killed = false;

      // Determine the command and arguments based on runtime
      let execPath: string;
      let execArgs: string[];

      if (runtime === 'node') {
        execPath = process.execPath; // Use the current Node.js binary
        execArgs = ['--experimental-modules', '-e', command];
      } else {
        execPath = this.options.shell ?? '/bin/bash';
        execArgs = ['-c', command];
      }

      const child: ChildProcess = spawn(execPath, execArgs, {
        cwd: resolve(workDir),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // Create a new process group for clean kill
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Capture stdout with size limit
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!stdoutTruncated) {
          if (stdoutSize + chunk.length > MAX_STDOUT_BYTES) {
            // Take only what fits
            const remaining = MAX_STDOUT_BYTES - stdoutSize;
            if (remaining > 0) {
              stdoutChunks.push(chunk.subarray(0, remaining));
              stdoutSize += remaining;
            }
            stdoutTruncated = true;
          } else {
            stdoutChunks.push(chunk);
            stdoutSize += chunk.length;
          }
        }
        callbacks?.onStdout?.(chunk.toString('utf-8'));
      });

      // Capture stderr with size limit
      child.stderr?.on('data', (chunk: Buffer) => {
        if (!stderrTruncated) {
          if (stderrSize + chunk.length > MAX_STDERR_BYTES) {
            const remaining = MAX_STDERR_BYTES - stderrSize;
            if (remaining > 0) {
              stderrChunks.push(chunk.subarray(0, remaining));
              stderrSize += remaining;
            }
            stderrTruncated = true;
          } else {
            stderrChunks.push(chunk);
            stderrSize += chunk.length;
          }
        }
        callbacks?.onStderr?.(chunk.toString('utf-8'));
      });

      // Helper to kill the entire process group
      const killProcessGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid) {
            process.kill(-child.pid, signal);
          }
        } catch {
          // Process may have already exited
          try {
            child.kill(signal);
          } catch {
            // Already dead
          }
        }
      };

      // Timeout: SIGTERM → 5s → SIGKILL
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (!killed) {
          killProcessGroup('SIGTERM');
          setTimeout(() => {
            if (!killed) {
              killProcessGroup('SIGKILL');
            }
          }, SIGKILL_GRACE_MS);
        }
      }, timeoutMs);

      // Handle process exit
      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);
        killed = true;

        const duration = Date.now() - startTime;
        let stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        let stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (stdoutTruncated) {
          stdout += TRUNCATION_MARKER;
        }
        if (stderrTruncated) {
          stderr += TRUNCATION_MARKER;
        }

        // Try to parse stdout as JSON
        let data: Record<string, unknown> | undefined;
        try {
          const trimmed = stdout.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsed: unknown = JSON.parse(trimmed);
            if (typeof parsed === 'object' && parsed !== null) {
              data = parsed as Record<string, unknown>;
            }
          }
        } catch {
          // stdout is not valid JSON — leave data undefined
        }

        const exitCode = timedOut ? -1 : (code ?? (signal ? 128 : 1));

        const result: ExecutorActionResult = {
          exit_code: exitCode,
          stdout,
          stderr,
          duration_ms: duration,
          timed_out: timedOut,
          command_executed: command,
        };

        if (data !== undefined) {
          result.data = data;
        }

        promiseResolve(result);
      });

      // Handle spawn errors (e.g., ENOENT)
      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        killed = true;

        const duration = Date.now() - startTime;
        promiseResolve({
          exit_code: 1,
          stdout: '',
          stderr: err.message,
          duration_ms: duration,
          timed_out: false,
          command_executed: command,
        });
      });
    });
  }
}
