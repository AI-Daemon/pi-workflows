/**
 * Tests for DAWE-018: WorkflowRuntime structured logging integration.
 *
 * Verifies that the WorkflowRuntime emits structured log entries
 * at the correct log levels for lifecycle events.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowRuntime } from '../../../src/engine/workflow-runtime.js';
import { DAWELogger } from '../../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/workflows', name), 'utf-8');
}

interface LogEntry {
  level: string;
  message: string;
  [key: string]: unknown;
}

function createLoggingRuntime(): { runtime: WorkflowRuntime; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const logger = new DAWELogger({
    level: 'debug',
    format: 'json',
    output: (line: string) => {
      try {
        logs.push(JSON.parse(line) as LogEntry);
      } catch {
        // ignore non-JSON lines
      }
    },
  });
  const runtime = new WorkflowRuntime({
    executorOptions: { workingDir: '/tmp' },
    logger,
  });
  // Prevent unhandled 'error' events from throwing in tests
  runtime.on('error', () => {});
  return { runtime, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Structured Logging (DAWE-018)', () => {
  let runtime: WorkflowRuntime;
  let logs: LogEntry[];

  beforeEach(() => {
    const result = createLoggingRuntime();
    runtime = result.runtime;
    logs = result.logs;
  });

  it('logs instance start when a workflow instance is started', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const result = await runtime.startInstance(loadResult.data);
    expect(result.ok).toBe(true);

    const instanceStartLog = logs.find((l) => l.level === 'info' && l.message === 'Instance started');
    expect(instanceStartLog).toBeDefined();
    expect(instanceStartLog!['instanceId']).toBeDefined();
    expect(instanceStartLog!['workflowName']).toBe('simple-linear');
  });

  it('logs node entry events', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    await runtime.startInstance(loadResult.data);

    const nodeEntryLogs = logs.filter((l) => l.level === 'info' && l.message === 'Node entered');
    expect(nodeEntryLogs.length).toBeGreaterThanOrEqual(1);
    expect(nodeEntryLogs[0]!['nodeId']).toBeDefined();
    expect(nodeEntryLogs[0]!['nodeType']).toBeDefined();
  });

  it('logs system action execution via SystemActionExecutor', async () => {
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // The first node is an llm_task, advance it to trigger system actions
    const instanceId = startResult.data.instanceId;
    const nodeId = startResult.data.currentNodeId!;
    const advanceResult = await runtime.advance(instanceId, nodeId, {
      project_name: 'test-project',
    });
    expect(advanceResult.ok).toBe(true);

    // Look for system action logs from the executor child logger
    const actionStartLogs = logs.filter((l) => l.message === 'System action started');
    const actionCompletedLogs = logs.filter((l) => l.message === 'System action completed');
    expect(actionStartLogs.length).toBeGreaterThan(0);
    expect(actionCompletedLogs.length).toBeGreaterThan(0);

    // Also verify the runtime logs the system action execution
    const runtimeActionLogs = logs.filter((l) => l.message === 'System action executed' && l.level === 'info');
    expect(runtimeActionLogs.length).toBeGreaterThan(0);
  });

  it('logs node completion and transition for LLM nodes', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const instanceId = startResult.data.instanceId;
    const nodeId = startResult.data.currentNodeId!;

    // Advance the first LLM node
    await runtime.advance(instanceId, nodeId, { choice: 'go' });

    const completionLogs = logs.filter((l) => l.level === 'info' && l.message === 'Node completed');
    expect(completionLogs.length).toBeGreaterThanOrEqual(1);

    const transitionLogs = logs.filter((l) => l.level === 'debug' && l.message === 'Transition taken');
    expect(transitionLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('logs instance completion at terminal node', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const instanceId = startResult.data.instanceId;

    // Advance through both LLM nodes to reach terminal
    const r1 = await runtime.advance(instanceId, startResult.data.currentNodeId!, { choice: 'go' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await runtime.advance(instanceId, r1.data.currentNodeId!, { result: 'done' });
    expect(r2.ok).toBe(true);

    const completionLog = logs.find((l) => l.level === 'info' && l.message === 'Instance completed');
    expect(completionLog).toBeDefined();
    expect(completionLog!['instanceId']).toBe(instanceId);
    expect(completionLog!['terminalStatus']).toBe('success');
  });
});
