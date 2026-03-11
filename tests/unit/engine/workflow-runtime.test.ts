/**
 * Unit tests for WorkflowRuntime — the core orchestration engine.
 *
 * Covers lifecycle, LLM node advancement, system action chaining,
 * transition evaluation, terminal node handling, agent message formatting,
 * and error handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowRuntime, RuntimeErrorCode } from '../../../src/engine/index.js';
import type { RuntimeOptions, WorkflowInstance } from '../../../src/engine/index.js';
import { InMemoryInstanceStore } from '../../../src/engine/instance-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/workflows', name), 'utf-8');
}

function createRuntime(options?: Partial<RuntimeOptions>): WorkflowRuntime {
  const rt = new WorkflowRuntime({
    executorOptions: { workingDir: '/tmp' },
    ...options,
  });
  // Prevent unhandled 'error' events from throwing in tests
  rt.on('error', () => {});
  return rt;
}

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Lifecycle', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('loads a valid workflow and returns a workflowId', () => {
    const yaml = loadFixture('simple-linear.yml');
    const result = runtime.loadWorkflow(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data).toBe('string');
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it('returns validation errors for invalid workflow', () => {
    const invalidYaml = `
version: '1.0'
workflow_name: bad
description: missing nodes
initial_node: nope
nodes: {}
`;
    const result = runtime.loadWorkflow(invalidYaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('starts an instance with correct initial state', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.status).toBe('waiting_for_agent');
    expect(startResult.data.currentNodeId).toBe('ask');
    expect(startResult.data.currentNodeType).toBe('llm_decision');
    expect(startResult.data.instruction).toBeDefined();
  });

  it('starts an instance with initial payload', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data, { user: 'test' });
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance).not.toBeNull();
    expect(instance!.payload).toHaveProperty('user', 'test');
  });

  it('gets instance by ID', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance).not.toBeNull();
    expect(instance!.instanceId).toBe(startResult.data.instanceId);
    expect(instance!.workflowName).toBe('simple-linear');
  });

  it('lists all active instances', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    await runtime.startInstance(loadResult.data);
    await runtime.startInstance(loadResult.data);

    const instances = await runtime.listInstances();
    expect(instances.length).toBe(2);
  });

  it('cancels an active instance', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const cancelResult = await runtime.cancelInstance(startResult.data.instanceId);
    expect(cancelResult.ok).toBe(true);

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance!.status).toBe('cancelled');
    expect(instance!.terminalStatus).toBe('cancelled');
  });

  it('returns error when cancelling a completed instance', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Advance through the whole workflow
    const adv1 = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    expect(adv1.ok).toBe(true);

    if (adv1.ok) {
      const adv2 = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
      expect(adv2.ok).toBe(true);
      if (adv2.ok) {
        expect(adv2.data.status).toBe('completed');
      }
    }

    const cancelResult = await runtime.cancelInstance(startResult.data.instanceId);
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) {
      expect(cancelResult.errors.code).toBe(RuntimeErrorCode.INSTANCE_NOT_ACTIVE);
    }
  });

  it('returns WORKFLOW_NOT_FOUND for unknown workflowId', async () => {
    const result = await runtime.startInstance('nonexistent-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe(RuntimeErrorCode.WORKFLOW_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------------
// LLM node advancement tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — LLM Node Advancement', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('advances llm_decision with valid payload and transitions', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const advResult = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'proceed' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.status).toBe('waiting_for_agent');
    expect(advResult.data.currentNodeId).toBe('do-task');
    expect(advResult.data.currentNodeType).toBe('llm_task');
  });

  it('returns PAYLOAD_VALIDATION_FAILED for missing required field', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const advResult = await runtime.advance(startResult.data.instanceId, 'ask', {});
    expect(advResult.ok).toBe(false);
    if (!advResult.ok) {
      expect(advResult.errors.code).toBe(RuntimeErrorCode.PAYLOAD_VALIDATION_FAILED);
    }
  });

  it('advances llm_task with completion data and transitions', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    const advResult = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'success' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.status).toBe('completed');
    expect(advResult.data.terminalStatus).toBe('success');
  });

  it('returns NODE_MISMATCH for wrong nodeId', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const advResult = await runtime.advance(startResult.data.instanceId, 'wrong-node', { choice: 'x' });
    expect(advResult.ok).toBe(false);
    if (!advResult.ok) {
      expect(advResult.errors.code).toBe(RuntimeErrorCode.NODE_MISMATCH);
    }
  });

  it('returns INSTANCE_NOT_ACTIVE for completed instance', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });

    const advResult = await runtime.advance(startResult.data.instanceId, 'done', {});
    expect(advResult.ok).toBe(false);
    if (!advResult.ok) {
      expect(advResult.errors.code).toBe(RuntimeErrorCode.INSTANCE_NOT_ACTIVE);
    }
  });

  it('merges payload into instance state after advance', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test-value' });

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance!.payload).toHaveProperty('choice', 'test-value');
  });

  it('validates type errors in required_schema', async () => {
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // 'confidence' should be a number, not a string
    const advResult = await runtime.advance(startResult.data.instanceId, 'classify', {
      category: 'bug',
      confidence: 'high', // wrong type
    });
    expect(advResult.ok).toBe(false);
    if (!advResult.ok) {
      expect(advResult.errors.code).toBe(RuntimeErrorCode.PAYLOAD_VALIDATION_FAILED);
      expect(advResult.errors.message).toContain('confidence');
    }
  });
});

// ---------------------------------------------------------------------------
// System action chaining tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — System Action Chaining', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('executes single system_action and returns next llm node', async () => {
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Advance past the initial llm_task
    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'myproject' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // After advancing, system actions should chain: check-status → setup-env → implement (llm_task)
    expect(adv.data.status).toBe('waiting_for_agent');
    expect(adv.data.currentNodeId).toBe('implement');
    expect(adv.data.systemActionResults).toBeDefined();
    expect(adv.data.systemActionResults!.length).toBe(2);
    expect(adv.data.systemActionResults![0]!.nodeId).toBe('check-status');
    expect(adv.data.systemActionResults![1]!.nodeId).toBe('setup-env');
  });

  it('chains two consecutive system_actions', async () => {
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'test' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // Both system actions should have executed
    expect(adv.data.systemActionResults!.length).toBe(2);
    for (const entry of adv.data.systemActionResults!) {
      expect(entry.actionResult.exit_code).toBe(0);
    }
  });

  it('collects all chain results in systemActionResults[]', async () => {
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'test' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const results = adv.data.systemActionResults!;
    expect(results.length).toBe(2);
    expect(results[0]!.nodeId).toBe('check-status');
    expect(results[0]!.actionResult.stdout).toContain('checking status');
    expect(results[1]!.nodeId).toBe('setup-env');
    expect(results[1]!.actionResult.stdout).toContain('setting up environment');
  });

  it('system action chain reaching terminal completes instance', async () => {
    // Create a workflow where system actions chain directly to terminal
    const yaml = `
version: '1.0'
workflow_name: sys-to-terminal
description: System actions leading to terminal.
initial_node: decide

nodes:
  decide:
    type: llm_decision
    instruction: Start.
    required_schema:
      go: string
    transitions:
      - condition: 'true'
        target: sys1

  sys1:
    type: system_action
    runtime: bash
    command: 'echo "done"'
    timeout_seconds: 10
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: done

  done:
    type: terminal
    status: success
    message: 'All done.'
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'decide', { go: 'yes' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.status).toBe('completed');
    expect(adv.data.terminalStatus).toBe('success');
    expect(adv.data.systemActionResults!.length).toBe(1);
  });

  it('returns SYSTEM_ACTION_CHAIN_LIMIT when chain exceeds max', async () => {
    // Build a chain longer than maxChainLength=2
    const yaml = `
version: '1.0'
workflow_name: long-chain
description: Chain that exceeds max.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Go.
    required_schema:
      ok: string
    transitions:
      - condition: 'true'
        target: sys1

  sys1:
    type: system_action
    runtime: bash
    command: 'echo s1'
    timeout_seconds: 5
    transitions:
      - condition: 'true'
        target: sys2

  sys2:
    type: system_action
    runtime: bash
    command: 'echo s2'
    timeout_seconds: 5
    transitions:
      - condition: 'true'
        target: sys3

  sys3:
    type: system_action
    runtime: bash
    command: 'echo s3'
    timeout_seconds: 5
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
`;
    const rt = createRuntime({ maxChainLength: 2 });
    const loadResult = rt.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await rt.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await rt.advance(startResult.data.instanceId, 'start', { ok: 'yes' });
    expect(adv.ok).toBe(false);
    if (!adv.ok) {
      expect(adv.errors.code).toBe(RuntimeErrorCode.SYSTEM_ACTION_CHAIN_LIMIT);
    }
  });

  it('handles system action branching based on exit code', async () => {
    const yaml = `
version: '1.0'
workflow_name: sys-branch
description: System action branching.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Go.
    required_schema:
      ok: string
    transitions:
      - condition: 'true'
        target: check

  check:
    type: system_action
    runtime: bash
    command: 'exit 1'
    timeout_seconds: 5
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: success
        priority: 0
      - condition: 'action_result.exit_code == 1'
        target: fallback
        priority: 1

  fallback:
    type: llm_task
    instruction: Handle the failure.
    completion_schema:
      reason: string
    transitions:
      - condition: 'true'
        target: fail

  success:
    type: terminal
    status: success

  fail:
    type: terminal
    status: failure
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { ok: 'yes' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // exit 1 should route to fallback
    expect(adv.data.currentNodeId).toBe('fallback');
    expect(adv.data.currentNodeType).toBe('llm_task');
  });
});

// ---------------------------------------------------------------------------
// Transition evaluation tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Transition Evaluation', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('selects the correct target for a single matching transition', async () => {
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'classify', {
      category: 'bug',
      confidence: 0.9,
    });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.currentNodeId).toBe('handle-bug');
  });

  it('evaluates transitions by priority, first match wins', async () => {
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'classify', {
      category: 'feature',
      confidence: 0.8,
    });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.currentNodeId).toBe('handle-feature');
  });

  it('default transition catches unmatched cases', async () => {
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'classify', {
      category: 'something-else',
      confidence: 0.5,
    });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // 'true' condition at priority 99 should catch this
    expect(adv.data.currentNodeId).toBe('handle-unknown');
  });

  it('returns NO_MATCHING_TRANSITION when no condition matches', async () => {
    // Workflow with no default transition
    const yaml = `
version: '1.0'
workflow_name: no-default
description: No default transition.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Choose.
    required_schema:
      choice: string
    transitions:
      - condition: "payload.choice == 'a'"
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { choice: 'b' });
    expect(adv.ok).toBe(false);
    if (!adv.ok) {
      expect(adv.errors.code).toBe(RuntimeErrorCode.NO_MATCHING_TRANSITION);
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal node handling tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Terminal Node Handling', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('reaching success terminal sets correct status', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    const adv = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'great' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.status).toBe('completed');
    expect(adv.data.terminalStatus).toBe('success');
  });

  it('reaching failure terminal sets terminalStatus failure', async () => {
    const yaml = loadFixture('branching-workflow.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Route to unknown → failure
    await runtime.advance(startResult.data.instanceId, 'classify', {
      category: 'unknown',
      confidence: 0.1,
    });

    const adv = await runtime.advance(startResult.data.instanceId, 'handle-unknown', { reason: 'nope' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.status).toBe('completed');
    expect(adv.data.terminalStatus).toBe('failure');
  });

  it('terminal message with template is resolved against payload', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    const adv = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'my-result' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.terminalMessage).toBe('Completed with result: my-result');
  });

  it('instance history contains all visited nodes in order', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance).not.toBeNull();

    const nodeIds = instance!.history.map((h) => h.nodeId);
    expect(nodeIds).toEqual(['ask', 'do-task', 'done']);
  });
});

// ---------------------------------------------------------------------------
// Agent message formatting tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Agent Message Formatting', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('llm_decision message includes instruction and required_schema hint', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const msg = startResult.data.agentMessage;
    expect(msg).toContain('WORKFLOW: simple-linear');
    expect(msg).toContain('CURRENT NODE: ask');
    expect(msg).toContain('NODE TYPE: llm_decision');
    expect(msg).toContain('INSTRUCTIONS:');
    expect(msg).toContain('REQUIRED ACTION:');
    expect(msg).toContain('"choice"');
  });

  it('llm_task message includes instruction and completion schema hint', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const msg = adv.data.agentMessage;
    expect(msg).toContain('CURRENT NODE: do-task');
    expect(msg).toContain('NODE TYPE: llm_task');
    expect(msg).toContain('INSTRUCTIONS:');
    expect(msg).toContain('REQUIRED ACTION:');
    expect(msg).toContain('"result"');
  });

  it('terminal message includes final status and summary', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    const adv = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const msg = adv.data.agentMessage;
    expect(msg).toContain('TERMINAL STATUS: success');
    expect(msg).toContain('MESSAGE:');
  });

  it('system action results are summarized in message', async () => {
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'test' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const msg = adv.data.agentMessage;
    expect(msg).toContain('System actions executed');
    expect(msg).toContain('check-status');
    expect(msg).toContain('setup-env');
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Error Handling', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('returns INSTANCE_NOT_FOUND for unknown instanceId', async () => {
    const result = await runtime.advance('nonexistent', 'node', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe(RuntimeErrorCode.INSTANCE_NOT_FOUND);
    }
  });

  it('system action timeout still evaluates transitions', async () => {
    const yaml = `
version: '1.0'
workflow_name: timeout-test
description: System action that times out.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Go.
    required_schema:
      ok: string
    transitions:
      - condition: 'true'
        target: slow-action

  slow-action:
    type: system_action
    runtime: bash
    command: 'sleep 30'
    timeout_seconds: 1
    transitions:
      - condition: 'action_result.timed_out == true'
        target: timeout-node
        priority: 0
      - condition: 'true'
        target: done

  timeout-node:
    type: llm_task
    instruction: Handle timeout.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { ok: 'yes' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // The timed_out result should be in the payload's action_result
    expect(adv.data.systemActionResults!.length).toBe(1);
    expect(adv.data.systemActionResults![0]!.actionResult.timed_out).toBe(true);
  });

  it('emits error events', async () => {
    const errors: unknown[] = [];
    runtime.on('error', (_instanceId, error) => {
      errors.push(error);
    });

    const yaml = `
version: '1.0'
workflow_name: no-default-err
description: No default.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Choose.
    required_schema:
      choice: string
    transitions:
      - condition: "payload.choice == 'a'"
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'start', { choice: 'b' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Event emitter tests (P1)
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Events (P1)', () => {
  it('emits node:entered and node:completed events', async () => {
    const runtime = createRuntime();
    const entered: string[] = [];
    const completed: string[] = [];

    runtime.on('node:entered', (_instanceId: string, nodeId: string) => entered.push(nodeId));
    runtime.on('node:completed', (_instanceId: string, nodeId: string) => completed.push(nodeId));

    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });

    expect(entered).toContain('ask');
    expect(entered).toContain('do-task');
    expect(entered).toContain('done');
    expect(completed).toContain('ask');
    expect(completed).toContain('do-task');
  });

  it('emits instance:completed on terminal', async () => {
    const runtime = createRuntime();
    const completedEvents: string[] = [];

    runtime.on('instance:completed', (_instanceId: string, status: string) => completedEvents.push(status));

    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });

    expect(completedEvents).toContain('success');
  });

  it('emits system_action:executed for system actions', async () => {
    const runtime = createRuntime();
    const sysEvents: string[] = [];

    runtime.on('system_action:executed', (_instanceId: string, nodeId: string) => sysEvents.push(nodeId));

    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'test' });

    expect(sysEvents).toContain('check-status');
    expect(sysEvents).toContain('setup-env');
  });
});

// ---------------------------------------------------------------------------
// Instance Store tests (P1)
// ---------------------------------------------------------------------------

describe('InMemoryInstanceStore', () => {
  it('saves and loads instances', async () => {
    const store = new InMemoryInstanceStore();
    const instance: WorkflowInstance = {
      instanceId: 'test-1',
      workflowId: 'wf-1',
      workflowName: 'test',
      status: 'active',
      currentNodeId: 'start',
      currentNodeType: 'llm_task',
      payload: { foo: 'bar' },
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.save(instance);
    const loaded = await store.load('test-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.instanceId).toBe('test-1');
    expect(loaded!.payload).toEqual({ foo: 'bar' });
  });

  it('returns null for unknown instance', async () => {
    const store = new InMemoryInstanceStore();
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('lists all instances', async () => {
    const store = new InMemoryInstanceStore();
    const base: WorkflowInstance = {
      instanceId: '',
      workflowId: 'wf-1',
      workflowName: 'test',
      status: 'active',
      currentNodeId: 'start',
      currentNodeType: 'llm_task',
      payload: {},
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.save({ ...base, instanceId: 'a' });
    await store.save({ ...base, instanceId: 'b' });

    const list = await store.list();
    expect(list.length).toBe(2);
  });

  it('deletes an instance', async () => {
    const store = new InMemoryInstanceStore();
    const instance: WorkflowInstance = {
      instanceId: 'del-1',
      workflowId: 'wf-1',
      workflowName: 'test',
      status: 'active',
      currentNodeId: 'start',
      currentNodeType: 'llm_task',
      payload: {},
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.save(instance);
    await store.delete('del-1');
    const loaded = await store.load('del-1');
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests for coverage
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Security Violation (SYSTEM_ACTION_FAILED)', () => {
  it('returns SYSTEM_ACTION_FAILED when system action has a blocked command', async () => {
    const runtime = createRuntime();
    const yaml = `
version: '1.0'
workflow_name: blocked-cmd
description: System action with blocked command.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Go.
    required_schema:
      ok: string
    transitions:
      - condition: 'true'
        target: dangerous

  dangerous:
    type: system_action
    runtime: bash
    command: 'rm -rf /'
    timeout_seconds: 5
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { ok: 'yes' });
    expect(adv.ok).toBe(false);
    if (!adv.ok) {
      expect(adv.errors.code).toBe(RuntimeErrorCode.SYSTEM_ACTION_FAILED);
    }
  });
});

describe('WorkflowRuntime — Context Keys and Template Resolution', () => {
  it('llm_task with context_keys returns scoped payload', async () => {
    const runtime = createRuntime();
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'myproj' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // implement node has context_keys: [project_name]
    expect(adv.data.contextPayload).toBeDefined();
    expect(adv.data.contextPayload).toHaveProperty('project_name', 'myproj');
  });

  it('instruction template is resolved with payload variables', async () => {
    const runtime = createRuntime();
    const yaml = loadFixture('system-action-chain.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'start-task', { project_name: 'coolapp' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // instruction: 'Implement the feature for {{payload.project_name}}.'
    expect(adv.data.instruction).toContain('coolapp');
  });

  it('cancel returns INSTANCE_NOT_FOUND for unknown id', async () => {
    const runtime = createRuntime();
    const result = await runtime.cancelInstance('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.code).toBe(RuntimeErrorCode.INSTANCE_NOT_FOUND);
    }
  });

  it('getInstance returns null for unknown id', async () => {
    const runtime = createRuntime();
    const result = await runtime.getInstance('nonexistent');
    expect(result).toBeNull();
  });
});
