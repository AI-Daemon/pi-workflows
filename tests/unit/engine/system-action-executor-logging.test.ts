/**
 * Tests for DAWE-018: SystemActionExecutor structured logging integration.
 *
 * Verifies that the executor emits structured log entries for command
 * start, completion, timeout, and security blocks.
 */

import { describe, it, expect } from 'vitest';
import { SystemActionExecutor } from '../../../src/engine/system-action-executor.js';
import { DAWELogger } from '../../../src/utils/logger.js';
import type { SystemActionNode } from '../../../src/schemas/workflow.schema.js';
import type { ExpressionContext } from '../../../src/engine/expression-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  message: string;
  [key: string]: unknown;
}

function createLoggingExecutor(opts?: Record<string, unknown>): { executor: SystemActionExecutor; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const logger = new DAWELogger({
    level: 'debug',
    format: 'json',
    output: (line: string) => {
      try {
        logs.push(JSON.parse(line) as LogEntry);
      } catch {
        // ignore
      }
    },
  });
  const executor = new SystemActionExecutor({
    workingDir: '/tmp',
    logger,
    ...opts,
  });
  return { executor, logs };
}

function makeNode(command: string, overrides?: Partial<SystemActionNode>): SystemActionNode {
  return {
    type: 'system_action',
    command,
    runtime: 'bash',
    transitions: [{ condition: 'default', target: 'done' }],
    ...overrides,
  };
}

const defaultContext: ExpressionContext = {
  payload: { test: 'value' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SystemActionExecutor — Structured Logging (DAWE-018)', () => {
  it('logs command start and completion with duration', async () => {
    const { executor, logs } = createLoggingExecutor();
    const node = makeNode('echo "hello"');

    await executor.execute(node, defaultContext);

    const startLog = logs.find((l) => l.message === 'System action started');
    expect(startLog).toBeDefined();
    expect(startLog!.level).toBe('info');
    expect(startLog!['runtime']).toBe('bash');

    const completedLog = logs.find((l) => l.message === 'System action completed');
    expect(completedLog).toBeDefined();
    expect(completedLog!.level).toBe('info');
    expect(completedLog!['durationMs']).toBeDefined();
    expect(completedLog!['exitCode']).toBe(0);
  });

  it('logs timeout warning', async () => {
    const { executor, logs } = createLoggingExecutor();
    const node = makeNode('sleep 60', { timeout_seconds: 1 });

    await executor.execute(node, defaultContext);

    const timeoutLog = logs.find((l) => l.message === 'System action timed out');
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.level).toBe('warn');
    expect(timeoutLog!['code']).toBe('X-001');
  });

  it('logs security block error', async () => {
    const { executor, logs } = createLoggingExecutor();
    const node = makeNode('rm -rf /');

    const result = await executor.execute(node, defaultContext);
    expect(result.ok).toBe(false);

    const blockLog = logs.find((l) => l.message === 'Command blocked by security policy');
    expect(blockLog).toBeDefined();
    expect(blockLog!.level).toBe('error');
    expect(blockLog!['code']).toBe('X-003');
  });
});
