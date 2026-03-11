/**
 * Integration tests for the extension tool.
 *
 * Tests end-to-end workflow lifecycle through the AdvanceWorkflowHandler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';

import { WorkflowRuntime } from '../../src/engine/workflow-runtime.js';
import { WorkflowRegistry } from '../../src/extension/workflow-registry.js';
import { AdvanceWorkflowHandler } from '../../src/extension/advance-workflow-tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractInstanceId(text: string): string {
  const match = text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
  if (!match) throw new Error(`Could not extract instance ID from:\n${text}`);
  return match[1]!;
}

function extractCurrentNodeId(text: string): string {
  const match = text.match(/Current Node: `([^`]+)`/);
  if (!match) throw new Error(`Could not extract node ID from:\n${text}`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Extension Integration', () => {
  let handler: AdvanceWorkflowHandler;

  beforeEach(async () => {
    const runtime = new WorkflowRuntime();
    const registry = new WorkflowRegistry([resolve('tests/fixtures/workflows')]);
    handler = new AdvanceWorkflowHandler(runtime, registry);
    await registry.loadAll();
  });

  // 1. Full workflow: list → start → advance (multiple nodes) → terminal
  it('should complete a full workflow lifecycle: list → start → advance → terminal', async () => {
    // Step 1: List
    const listResult = await handler.handle({ action: 'list' });
    expect(listResult.text).toContain('simple-linear');

    // Step 2: Start
    const startResult = await handler.handle({
      action: 'start',
      workflow_name: 'simple-linear',
      confirm: true,
    });
    expect(startResult.isError).toBeUndefined();
    const instanceId = extractInstanceId(startResult.text);
    const node1 = extractCurrentNodeId(startResult.text);
    expect(node1).toBe('ask');

    // Step 3: Advance through ask → do-task
    const advance1 = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'ask',
      node_payload: { choice: 'implement' },
    });
    expect(advance1.isError).toBeUndefined();
    const node2 = extractCurrentNodeId(advance1.text);
    expect(node2).toBe('do-task');

    // Step 4: Advance through do-task → done (terminal)
    const advance2 = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'do-task',
      node_payload: { result: 'feature implemented' },
    });
    expect(advance2.text).toContain('Workflow completed');
    expect(advance2.text).toContain('Workflow History');
  });

  // 2. Error recovery: submit bad payload, get error, resubmit correct payload
  it('should recover from payload validation error', async () => {
    const startResult = await handler.handle({
      action: 'start',
      workflow_name: 'simple-linear',
      confirm: true,
    });
    const instanceId = extractInstanceId(startResult.text);

    // Submit bad payload (missing required field)
    const badResult = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'ask',
      node_payload: {}, // missing 'choice'
    });
    expect(badResult.isError).toBe(true);
    expect(badResult.text).toContain('PAYLOAD_VALIDATION_FAILED');

    // Resubmit with correct payload
    const goodResult = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'ask',
      node_payload: { choice: 'fix bug' },
    });
    expect(goodResult.isError).toBeUndefined();
    expect(goodResult.text).toContain('do-task');
  });

  // 3. Multiple concurrent instances don't interfere with each other
  it('should handle multiple concurrent instances independently', async () => {
    // Start two instances of different workflows
    const start1 = await handler.handle({
      action: 'start',
      workflow_name: 'simple-linear',
      confirm: true,
    });
    const id1 = extractInstanceId(start1.text);

    const start2 = await handler.handle({
      action: 'start',
      workflow_name: 'branching-workflow',
      confirm: true,
    });
    const id2 = extractInstanceId(start2.text);

    expect(id1).not.toBe(id2);

    // Advance first instance
    const advance1 = await handler.handle({
      action: 'advance',
      instance_id: id1,
      current_node_id: 'ask',
      node_payload: { choice: 'test' },
    });
    expect(advance1.text).toContain('do-task');

    // Advance second instance
    const advance2 = await handler.handle({
      action: 'advance',
      instance_id: id2,
      current_node_id: 'classify',
      node_payload: { category: 'bug', confidence: 0.9 },
    });
    expect(advance2.text).toContain('handle-bug');

    // Check statuses are independent
    const status1 = await handler.handle({ action: 'status', instance_id: id1 });
    const status2 = await handler.handle({ action: 'status', instance_id: id2 });

    expect(status1.text).toContain('do-task');
    expect(status2.text).toContain('handle-bug');
  });

  // 4. System action chain workflow
  it('should auto-execute system actions and return results', async () => {
    const startResult = await handler.handle({
      action: 'start',
      workflow_name: 'system-action-chain',
      confirm: true,
    });
    expect(startResult.isError).toBeUndefined();
    const instanceId = extractInstanceId(startResult.text);

    // First node is start-task (llm_task)
    expect(startResult.text).toContain('start-task');

    // Advance — system actions should auto-chain
    const advance = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'start-task',
      node_payload: { project_name: 'test-project' },
    });

    // Should have auto-executed check-status and setup-env, landing on implement
    expect(advance.text).toContain('System Actions Executed');
    expect(advance.text).toContain('check-status');
    expect(advance.text).toContain('setup-env');
    expect(advance.text).toContain('implement');
  });

  // 5. Branching workflow
  it('should follow conditional branches correctly', async () => {
    const startResult = await handler.handle({
      action: 'start',
      workflow_name: 'branching-workflow',
      confirm: true,
    });
    const instanceId = extractInstanceId(startResult.text);

    // Choose 'feature' → should go to handle-feature
    const advance = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'classify',
      node_payload: { category: 'feature', confidence: 0.95 },
    });
    expect(advance.text).toContain('handle-feature');
  });

  // 6. Cancel mid-workflow
  it('should cancel an in-progress workflow', async () => {
    const startResult = await handler.handle({
      action: 'start',
      workflow_name: 'simple-linear',
      confirm: true,
    });
    const instanceId = extractInstanceId(startResult.text);

    const cancelResult = await handler.handle({
      action: 'cancel',
      instance_id: instanceId,
    });
    expect(cancelResult.text).toContain('cancelled');

    // Trying to advance should fail
    const advanceResult = await handler.handle({
      action: 'advance',
      instance_id: instanceId,
      current_node_id: 'ask',
      node_payload: { choice: 'test' },
    });
    expect(advanceResult.isError).toBe(true);
    expect(advanceResult.text).toContain('INSTANCE_NOT_ACTIVE');
  });
});
