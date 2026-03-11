/**
 * Integration tests for WorkflowRuntime.
 *
 * Tests full workflow execution paths with real system action execution,
 * multi-branch scenarios, and instance persistence.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowRuntime } from '../../src/engine/index.js';
import type { RuntimeOptions } from '../../src/engine/index.js';
import { InMemoryInstanceStore } from '../../src/engine/instance-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../fixtures/workflows', name), 'utf-8');
}

function createRuntime(options?: Partial<RuntimeOptions>): WorkflowRuntime {
  return new WorkflowRuntime({
    executorOptions: { workingDir: '/tmp' },
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Integration: Full workflow execution
// ---------------------------------------------------------------------------

describe('WorkflowRuntime Integration — Full Workflow Execution', () => {
  it('executes issue-first-development workflow end-to-end (mock system actions)', async () => {
    const runtime = createRuntime();
    const yaml = loadFixture('full-example.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Step 1: Start — should be at assess-intent (llm_decision)
    const start = await runtime.startInstance(loadResult.data);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.data.status).toBe('waiting_for_agent');
    expect(start.data.currentNodeId).toBe('assess-intent');
    expect(start.data.currentNodeType).toBe('llm_decision');

    // Step 2: Advance assess-intent with bug intent
    // This should trigger: check-existing-issue → create-issue → create-branch (all system actions)
    // Then stop at implement-code (llm_task)
    const adv1 = await runtime.advance(start.data.instanceId, 'assess-intent', {
      intent: 'bug',
      title: 'Fix login bug',
      description: 'Login button not working',
    });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;

    expect(adv1.data.status).toBe('waiting_for_agent');
    expect(adv1.data.currentNodeId).toBe('implement-code');
    expect(adv1.data.currentNodeType).toBe('llm_task');
    // 3 system actions should have executed
    expect(adv1.data.systemActionResults).toBeDefined();
    expect(adv1.data.systemActionResults!.length).toBe(3);

    // Step 3: Complete implementation
    const adv2 = await runtime.advance(start.data.instanceId, 'implement-code', {
      status: 'complete',
    });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    // create-pr system action should execute, then stop at review-code
    expect(adv2.data.status).toBe('waiting_for_agent');
    expect(adv2.data.currentNodeId).toBe('review-code');
    expect(adv2.data.systemActionResults).toBeDefined();
    expect(adv2.data.systemActionResults!.length).toBe(1);

    // Step 4: Approve the review
    const adv3 = await runtime.advance(start.data.instanceId, 'review-code', {
      approved: true,
    });
    expect(adv3.ok).toBe(true);
    if (!adv3.ok) return;

    expect(adv3.data.status).toBe('completed');
    expect(adv3.data.terminalStatus).toBe('success');

    // Verify final instance state
    const instance = await runtime.getInstance(start.data.instanceId);
    expect(instance).not.toBeNull();
    expect(instance!.status).toBe('completed');
    expect(instance!.completedAt).toBeDefined();
  });

  it('multi-branch: different agent inputs lead to different terminal nodes', async () => {
    const runtime = createRuntime();
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Path 1: bug → success
    const start1 = await runtime.startInstance(loadResult.data);
    if (!start1.ok) return;

    const adv1a = await runtime.advance(start1.data.instanceId, 'classify', {
      category: 'bug',
      confidence: 0.95,
    });
    expect(adv1a.ok && adv1a.data.currentNodeId === 'handle-bug').toBe(true);

    if (adv1a.ok) {
      const adv1b = await runtime.advance(start1.data.instanceId, 'handle-bug', {
        fix_description: 'Fixed the bug',
      });
      expect(adv1b.ok).toBe(true);
      if (adv1b.ok) {
        expect(adv1b.data.terminalStatus).toBe('success');
      }
    }

    // Path 2: unknown → failure
    const start2 = await runtime.startInstance(loadResult.data);
    if (!start2.ok) return;

    const adv2a = await runtime.advance(start2.data.instanceId, 'classify', {
      category: 'other',
      confidence: 0.3,
    });
    expect(adv2a.ok && adv2a.data.currentNodeId === 'handle-unknown').toBe(true);

    if (adv2a.ok) {
      const adv2b = await runtime.advance(start2.data.instanceId, 'handle-unknown', {
        reason: 'Unknown category',
      });
      expect(adv2b.ok).toBe(true);
      if (adv2b.ok) {
        expect(adv2b.data.terminalStatus).toBe('failure');
      }
    }
  });

  it('workflow with 5+ nodes including mixed node types', async () => {
    const runtime = createRuntime();
    const yaml = loadFixture('full-example.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const start = await runtime.startInstance(loadResult.data);
    if (!start.ok) return;

    // This workflow has: assess-intent, check-existing-issue, create-issue,
    // create-branch, implement-code, create-pr, review-code, success (8 nodes)
    // With mixed types: llm_decision, system_action, llm_task, terminal

    const adv1 = await runtime.advance(start.data.instanceId, 'assess-intent', {
      intent: 'feature',
      title: 'Add dashboard',
      description: 'New dashboard feature',
    });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;

    // After system actions chain: at implement-code
    expect(adv1.data.currentNodeId).toBe('implement-code');

    const adv2 = await runtime.advance(start.data.instanceId, 'implement-code', { status: 'complete' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    // After create-pr system action: at review-code
    expect(adv2.data.currentNodeId).toBe('review-code');

    const adv3 = await runtime.advance(start.data.instanceId, 'review-code', { approved: true });
    expect(adv3.ok).toBe(true);
    if (!adv3.ok) return;

    expect(adv3.data.status).toBe('completed');

    // Verify history has all visited nodes
    const instance = await runtime.getInstance(start.data.instanceId);
    expect(instance!.history.length).toBeGreaterThanOrEqual(5);
  });

  it('instance state persisted and loaded correctly with InMemoryInstanceStore', async () => {
    const store = new InMemoryInstanceStore();
    const runtime = createRuntime({ instanceStore: store });

    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Verify instance is in the store
    const stored = await store.load(startResult.data.instanceId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('waiting_for_agent');
    expect(stored!.currentNodeId).toBe('ask');

    // Advance and verify store is updated
    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    const updated = await store.load(startResult.data.instanceId);
    expect(updated!.currentNodeId).toBe('do-task');
    expect(updated!.payload).toHaveProperty('choice', 'test');
  });
});

// ---------------------------------------------------------------------------
// Integration: System action with initial system_action node
// ---------------------------------------------------------------------------

describe('WorkflowRuntime Integration — Initial System Action Node', () => {
  it('auto-executes system_action as initial node', async () => {
    const runtime = createRuntime();
    const yaml = `
version: '1.0'
workflow_name: sys-initial
description: Starts with system action.
initial_node: setup

nodes:
  setup:
    type: system_action
    runtime: bash
    command: 'echo "initialized"'
    timeout_seconds: 10
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: work

  work:
    type: llm_task
    instruction: 'Do work.'
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const start = await runtime.startInstance(loadResult.data);
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    // Should auto-execute setup, then stop at work
    expect(start.data.status).toBe('waiting_for_agent');
    expect(start.data.currentNodeId).toBe('work');
    expect(start.data.systemActionResults).toBeDefined();
    expect(start.data.systemActionResults!.length).toBe(1);
    expect(start.data.systemActionResults![0]!.nodeId).toBe('setup');
  });
});
