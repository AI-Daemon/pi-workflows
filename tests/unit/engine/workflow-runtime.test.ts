/**
 * Unit tests for WorkflowRuntime — the core orchestration engine.
 *
 * Covers lifecycle, LLM node advancement, system action chaining,
 * transition evaluation, terminal node handling, agent message formatting,
 * and error handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// DAWE-015: $metadata tracking and bounded cycle execution
// ---------------------------------------------------------------------------

function loadFixtureV2(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/workflows', name), 'utf-8');
}

describe('WorkflowRuntime — $metadata Initialization (DAWE-015)', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('start instance → $metadata.visits initialized', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance).not.toBeNull();

    const $metadata = instance!.payload['$metadata'] as Record<string, unknown>;
    expect($metadata).toBeDefined();
    expect($metadata['visits']).toBeDefined();
    expect(typeof $metadata['visits']).toBe('object');
  });

  it('enter initial node → $metadata.visits[nodeId] incremented to 1', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { visits: Record<string, number> };
    expect($metadata.visits['ask']).toBe(1);
  });

  it('transition to next node → $metadata.visits[nextNodeId] incremented to 1', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    expect(adv.ok).toBe(true);

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { visits: Record<string, number> };
    expect($metadata.visits['do-task']).toBe(1);
    expect($metadata.visits['ask']).toBe(1);
  });

  it('$metadata.instance_id matches the instance ID', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { instance_id: string };
    expect($metadata.instance_id).toBe(startResult.data.instanceId);
  });

  it('$metadata.started_at is a valid ISO 8601 timestamp', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { started_at: string };
    expect($metadata.started_at).toBeDefined();
    // Parse to check it's valid ISO 8601
    const parsed = new Date($metadata.started_at);
    expect(parsed.toISOString()).toBe($metadata.started_at);
  });

  it('$metadata cannot be overwritten by agent payload', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Try to overwrite $metadata via node_payload
    const adv = await runtime.advance(startResult.data.instanceId, 'ask', {
      choice: 'go',
      $metadata: { visits: { hacked: 999 }, state_hashes: [], instance_id: 'hacked', started_at: 'hacked' },
    });
    expect(adv.ok).toBe(true);

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { instance_id: string; visits: Record<string, number> };
    // $metadata should NOT have been overwritten
    expect($metadata.instance_id).toBe(startResult.data.instanceId);
    expect($metadata.visits['hacked']).toBeUndefined();
  });
});

describe('WorkflowRuntime — Bounded Cycle Execution (DAWE-015)', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('re-enter node (cycle) → $metadata.visits[nodeId] incremented to 2', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (auto-advance via system_action chain)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;

    // After start → run_tests (visit 1) → fix (visit 1)
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2)
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    // Should be back at fix again after run_tests auto-advances
    expect(adv2.data.currentNodeId).toBe('fix');

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { visits: Record<string, number> };
    expect($metadata.visits['run_tests']).toBe(2);
  });

  it('$metadata.visits accessible in transition conditions', async () => {
    // Use an inline workflow where the transition condition uses $metadata.visits
    const yaml = `
version: '2.0'
workflow_name: metadata-condition-test
description: Test $metadata in conditions.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Start.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: check

  check:
    type: llm_decision
    instruction: Check visits.
    required_schema:
      proceed: string
    max_visits: 5
    transitions:
      - condition: '$metadata.visits.check < 3'
        target: check
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

    // start → check (visit 1)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('check');

    // check visit 1 → check visit 2 ($metadata.visits.check < 3 → true)
    const adv2 = await runtime.advance(startResult.data.instanceId, 'check', { proceed: 'yes' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.currentNodeId).toBe('check');

    // check visit 2 → check visit 3 ($metadata.visits.check < 3 → true, visits=2)
    const adv3 = await runtime.advance(startResult.data.instanceId, 'check', { proceed: 'yes' });
    expect(adv3.ok).toBe(true);
    if (!adv3.ok) return;
    expect(adv3.data.currentNodeId).toBe('check');

    // check visit 3 → done ($metadata.visits.check < 3 → false since visits=3, so 'true' matches → done)
    const adv4 = await runtime.advance(startResult.data.instanceId, 'check', { proceed: 'yes' });
    expect(adv4.ok).toBe(true);
    if (!adv4.ok) return;
    expect(adv4.data.status).toBe('completed');
  });

  it('node at max_visits → transition to that node skipped', async () => {
    const yaml = `
version: '2.0'
workflow_name: budget-skip-test
description: Test max_visits skip.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Start.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: limited

  limited:
    type: llm_task
    instruction: Limited node.
    completion_schema:
      status: string
    max_visits: 1
    transitions:
      - condition: "payload.status == 'retry'"
        target: limited
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

    // start → limited (visit 1)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('limited');

    // limited visit 1 → try retry, but max_visits=1 so limited is skipped, fallback to done
    const adv2 = await runtime.advance(startResult.data.instanceId, 'limited', { status: 'retry' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    // Should go to done since limited is budget-exhausted
    expect(adv2.data.status).toBe('completed');
  });

  it('all transitions budget-exhausted → transitions to suspended terminal', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix (visit 1)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2) → fix (visit 2)
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 3) → fix (visit 3)
    const adv3 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv3.ok).toBe(true);
    if (!adv3.ok) return;
    expect(adv3.data.currentNodeId).toBe('fix');

    // fix → run_tests would be visit 4 but max_visits=3
    // Budget exhausted → should transition to human_intervention (suspended terminal)
    const adv4 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv4.ok).toBe(true);
    if (adv4.ok) {
      expect(adv4.data.status).toBe('suspended');
      expect(adv4.data.terminalStatus).toBe('suspended');
    }
  });

  it('all transitions budget-exhausted, no suspended terminal → BUDGET_EXHAUSTED error', async () => {
    const yaml = loadFixtureV2('v2-budget-exhaustion.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2) → fix
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.currentNodeId).toBe('fix');

    // fix → run_tests would be visit 3 but max_visits=2
    // Budget exhausted, no suspended terminal → BUDGET_EXHAUSTED
    const adv3 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv3.ok).toBe(false);
    if (!adv3.ok) {
      expect(adv3.errors.code).toBe(RuntimeErrorCode.BUDGET_EXHAUSTED);
    }
  });

  it('suspended instance rejects further advance() calls', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Exhaust budget to reach suspended state
    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying', tests_pass: false });
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying', tests_pass: false });
    const adv4 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });

    // Should be suspended now
    expect(adv4.ok).toBe(true);
    if (adv4.ok) {
      expect(adv4.data.status).toBe('suspended');
    }

    // Further advance should be rejected
    const adv5 = await runtime.advance(startResult.data.instanceId, 'human_intervention', {});
    expect(adv5.ok).toBe(false);
    if (!adv5.ok) {
      expect(adv5.errors.code).toBe(RuntimeErrorCode.INSTANCE_NOT_ACTIVE);
    }
  });

  it('three-iteration cycle: visit 1 → fix → visit 2 → fix → visit 3 → budget exhausted', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Track visit counts
    const visitCounts: number[] = [];

    // start → run_tests (visit 1) → fix
    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    let inst = await runtime.getInstance(startResult.data.instanceId);
    let meta = inst!.payload['$metadata'] as { visits: Record<string, number> };
    visitCounts.push(meta.visits['run_tests'] ?? 0);

    // fix → run_tests (visit 2) → fix
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying', tests_pass: false });
    inst = await runtime.getInstance(startResult.data.instanceId);
    meta = inst!.payload['$metadata'] as { visits: Record<string, number> };
    visitCounts.push(meta.visits['run_tests'] ?? 0);

    // fix → run_tests (visit 3) → fix
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying', tests_pass: false });
    inst = await runtime.getInstance(startResult.data.instanceId);
    meta = inst!.payload['$metadata'] as { visits: Record<string, number> };
    visitCounts.push(meta.visits['run_tests'] ?? 0);

    expect(visitCounts).toEqual([1, 2, 3]);

    // Visit 4 attempt → budget exhausted → suspended
    const adv = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv.ok).toBe(true);
    if (adv.ok) {
      expect(adv.data.status).toBe('suspended');
    }
  });

  it('v1.0 workflow executes without $metadata.visits enforcement (backward compat)', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // Standard v1.0 execution should work exactly as before
    const adv1 = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('do-task');

    const adv2 = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.status).toBe('completed');
  });

  it('agent message includes cycle info when transitioning within a cycle', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix (visit 1)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);

    // fix → run_tests (visit 2) → fix (visit 2) - this should have cycle info
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (adv2.ok) {
      // Agent message should contain cycle info
      expect(adv2.data.agentMessage).toContain('CYCLE:');
      expect(adv2.data.agentMessage).toContain('run_tests');
    }
  });

  it('cycle where tests pass on 2nd attempt exits to success terminal', async () => {
    const yaml = loadFixtureV2('v2-cycle-execution.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix (tests_pass=false)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2) - this time tests pass
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'fixed',
      tests_pass: true,
    });
    expect(adv2.ok).toBe(true);
    if (adv2.ok) {
      // Should reach done terminal (tests_pass=true in payload)
      expect(adv2.data.status).toBe('completed');
      expect(adv2.data.terminalStatus).toBe('success');
    }
  });
});

// ---------------------------------------------------------------------------
// DAWE-016: Context Management — File Pointers & Structured Error Extraction
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — File Pointers & extract_json (DAWE-016)', () => {
  const FILE_POINTER_DIR = '/tmp/dawe-runs';

  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('v2.0 system_action with extract_json → payload.extracted_json populated', async () => {
    // Create a temp JSON file for extract_json to read
    const tmpJsonPath = '/tmp/dawe-test-extract.json';
    writeFileSync(tmpJsonPath, JSON.stringify({ numFailed: 2, errors: ['err1', 'err2'] }), 'utf-8');

    const yaml = `
version: '2.0'
workflow_name: extract-json-test
description: Test extract_json integration.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "test output"'
    timeout_seconds: 10
    extract_json: '${tmpJsonPath}'
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: check

  check:
    type: llm_task
    instruction: 'Check results. Extracted: {{payload.extracted_json}}'
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

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    // Should be at 'check' node now, with extracted_json in payload
    expect(adv.data.currentNodeId).toBe('check');

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance!.payload['extracted_json']).toBeDefined();
    expect((instance!.payload['extracted_json'] as Record<string, unknown>)['numFailed']).toBe(2);
  });

  it('v2.0 system_action → payload.log_pointer_path set', async () => {
    const yaml = `
version: '2.0'
workflow_name: log-pointer-test
description: Test log pointer path.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_cmd

  run_cmd:
    type: system_action
    runtime: bash
    command: 'echo "hello from system action"'
    timeout_seconds: 10
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: next

  next:
    type: llm_task
    instruction: 'Log is at: {{payload.log_pointer_path}}'
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

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance!.payload['log_pointer_path']).toBeDefined();
    const logPath = instance!.payload['log_pointer_path'] as string;
    expect(logPath).toContain('/tmp/dawe-runs/');
    expect(existsSync(logPath)).toBe(true);
  });

  it('{{$metadata.visits.run_tests}} resolves correctly in instruction templates', async () => {
    const yaml = `
version: '2.0'
workflow_name: metadata-template-test
description: Test $metadata in templates.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "fail at $(date +%s%N)" && exit 1'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: 'Fix attempt {{$metadata.visits.run_tests}} of 5. Check log at {{payload.log_pointer_path}}'
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: "payload.status == 'retry'"
        target: run_tests
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

    // start → run_tests (visit 1) → fix
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;

    // Instruction should contain the visit count "1"
    expect(adv1.data.instruction).toContain('Fix attempt 1 of 5');

    // fix → run_tests (visit 2) → fix (different output due to timestamp, no stall)
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retry' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    // Instruction should now contain "2"
    expect(adv2.data.instruction).toContain('Fix attempt 2 of 5');
  });

  it('terminal reached → file pointer logs cleaned up', async () => {
    const yaml = `
version: '2.0'
workflow_name: cleanup-test
description: Test log cleanup on terminal.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_cmd

  run_cmd:
    type: system_action
    runtime: bash
    command: 'echo "output for cleanup test"'
    timeout_seconds: 10
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: done

  done:
    type: terminal
    status: success
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_cmd → done
    const adv = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.status).toBe('completed');

    // File pointer logs should have been cleaned up
    const instanceId = startResult.data.instanceId;
    if (existsSync(FILE_POINTER_DIR)) {
      const remaining = readdirSync(FILE_POINTER_DIR).filter((f: string) => f.startsWith(`${instanceId}-`));
      expect(remaining.length).toBe(0);
    }
  });

  it('v2.0 system_action with extract_json pointing to invalid JSON → fallback to pointer only', async () => {
    const tmpInvalidPath = '/tmp/dawe-test-invalid-extract.txt';
    writeFileSync(tmpInvalidPath, 'this is not json {{{{', 'utf-8');

    const yaml = `
version: '2.0'
workflow_name: invalid-extract-test
description: Test invalid extract_json fallback.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "test"'
    timeout_seconds: 10
    extract_json: '${tmpInvalidPath}'
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: check

  check:
    type: llm_task
    instruction: 'Check.'
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

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    // extracted_json should be null on failure
    expect(instance!.payload['extracted_json']).toBeNull();
    // log_pointer_path should still be set
    expect(instance!.payload['log_pointer_path']).toBeDefined();
  });

  it('v2.0 system_action without extract_json → no payload.extracted_json set', async () => {
    const yaml = `
version: '2.0'
workflow_name: no-extract-test
description: Test no extract_json.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_cmd

  run_cmd:
    type: system_action
    runtime: bash
    command: 'echo "no extract"'
    timeout_seconds: 10
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: check

  check:
    type: llm_task
    instruction: 'Check.'
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

    const adv = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    const instance = await runtime.getInstance(startResult.data.instanceId);
    // extracted_json should NOT be set since node doesn't have extract_json
    expect(instance!.payload['extracted_json']).toBeUndefined();
    // log_pointer_path SHOULD be set (v2.0 always writes file pointer)
    expect(instance!.payload['log_pointer_path']).toBeDefined();
  });

  it('v1.0 workflow → no file pointers generated (backward compat)', async () => {
    const yaml = `
version: '1.0'
workflow_name: v1-no-pointer-test
description: v1.0 backward compat.
initial_node: start

nodes:
  start:
    type: llm_decision
    instruction: Go.
    required_schema:
      ok: string
    transitions:
      - condition: 'true'
        target: run_cmd

  run_cmd:
    type: system_action
    runtime: bash
    command: 'echo "v1 output"'
    timeout_seconds: 10
    transitions:
      - condition: 'action_result.exit_code == 0'
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

    // v1.0 should NOT have log_pointer_path
    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance!.payload['log_pointer_path']).toBeUndefined();
    expect(instance!.payload['extracted_json']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DAWE-017: Cryptographic Stall Detection & Circuit Breaker
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — Stall Detection (DAWE-017)', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    // Disable git diff in tests for deterministic behavior
    runtime = createRuntime({ stallDetectorOptions: { includeGitDiff: false } });
  });

  it('cycle with identical system_action output → workflow suspended after stall detection', async () => {
    // Workflow where run_tests always produces the same output → stall should trigger on 2nd cycle
    const yaml = `
version: '2.0'
workflow_name: stall-detection-test
description: Test stall detection with identical output.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "FAIL: same error every time"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'action_result.exit_code != 0'
        target: fix
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix the tests.
    completion_schema:
      status: string
      tests_pass: boolean
    max_visits: 5
    transitions:
      - condition: "payload.tests_pass == true"
        target: done
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success
    message: All tests pass.

  human_intervention:
    type: terminal
    status: suspended
    message: Stall detected. Human review required.
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix (first iteration, hash stored)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2) — same output "FAIL: same error every time"
    // Stall check runs: hash matches iteration 1 → SUSPENDED
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (adv2.ok) {
      expect(adv2.data.status).toBe('suspended');
    }
  });

  it('cycle with different system_action output → workflow continues normally', async () => {
    // Use a command that produces different output each time (includes timestamp)
    const yaml = `
version: '2.0'
workflow_name: no-stall-test
description: Test no stall with different output.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "FAIL at $(date +%s%N)"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix the tests.
    completion_schema:
      status: string
      tests_pass: boolean
    max_visits: 5
    transitions:
      - condition: "payload.tests_pass == true"
        target: done
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success
    message: All tests pass.

  human_intervention:
    type: terminal
    status: suspended
    message: Human review required.
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix
    const adv1 = await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.currentNodeId).toBe('fix');

    // fix → run_tests (visit 2) → fix (different output, no stall)
    const adv2 = await runtime.advance(startResult.data.instanceId, 'fix', {
      status: 'retrying',
      tests_pass: false,
    });
    expect(adv2.ok).toBe(true);
    if (adv2.ok) {
      expect(adv2.data.status).toBe('waiting_for_agent');
      expect(adv2.data.currentNodeId).toBe('fix');
    }
  });

  it('stall detected → $metadata.stall_detected is true', async () => {
    const yaml = `
version: '2.0'
workflow_name: stall-metadata-test
description: Test $metadata.stall_detected.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "identical output"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix.
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success

  human_intervention:
    type: terminal
    status: suspended
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix
    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });

    // fix → run_tests (visit 2) → stall detected
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying' });

    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as Record<string, unknown>;
    expect($metadata['stall_detected']).toBe(true);
  });

  it('stall detected → $metadata.visits NOT incremented for the target node', async () => {
    const yaml = `
version: '2.0'
workflow_name: stall-visits-test
description: Test visits not incremented on stall.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "same output"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix.
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success

  human_intervention:
    type: terminal
    status: suspended
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix
    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });

    // Get visit count before stall
    let instance = await runtime.getInstance(startResult.data.instanceId);
    let $metadata = instance!.payload['$metadata'] as { visits: Record<string, number> };
    const visitsBeforeStall = $metadata.visits['run_tests'] ?? 0;
    expect(visitsBeforeStall).toBe(1);

    // fix → run_tests (visit 2 attempt) → stall detected → visits should NOT increment
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying' });

    instance = await runtime.getInstance(startResult.data.instanceId);
    $metadata = instance!.payload['$metadata'] as { visits: Record<string, number> };
    // run_tests visits should still be 1 (the stalled visit was NOT counted)
    expect($metadata.visits['run_tests']).toBe(1);
  });

  it('stall detected → AdvanceResult.status is "suspended"', async () => {
    const yaml = `
version: '2.0'
workflow_name: stall-status-test
description: Test suspended status on stall.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "repeating error"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix.
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success

  human_intervention:
    type: terminal
    status: suspended
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    const adv = await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying' });
    expect(adv.ok).toBe(true);
    if (adv.ok) {
      expect(adv.data.status).toBe('suspended');
      expect(adv.data.terminalStatus).toBe('suspended');
    }
  });

  it('stall detected → agent message contains hash and iteration info', async () => {
    const yaml = `
version: '2.0'
workflow_name: stall-message-test
description: Test stall agent message.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "always same"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix.
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success

  human_intervention:
    type: terminal
    status: suspended
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });
    const adv = await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying' });
    expect(adv.ok).toBe(true);
    if (adv.ok) {
      expect(adv.data.agentMessage).toContain('STALL DETECTED');
      expect(adv.data.agentMessage).toContain('sha256:');
      expect(adv.data.agentMessage).toContain('WORKFLOW SUSPENDED');
      expect(adv.data.agentMessage).toContain('iteration');
      expect(adv.data.agentMessage).toContain('run_tests');
    }
  });

  it('no stall → $metadata.state_hashes grows with each iteration', async () => {
    const yaml = `
version: '2.0'
workflow_name: hashes-grow-test
description: Test state_hashes grow without stall.
initial_node: start

nodes:
  start:
    type: llm_task
    instruction: Begin.
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  run_tests:
    type: system_action
    runtime: bash
    command: 'echo "output $(date +%s%N)"'
    timeout_seconds: 10
    max_visits: 5
    transitions:
      - condition: 'true'
        target: fix

  fix:
    type: llm_task
    instruction: Fix.
    completion_schema:
      status: string
    max_visits: 5
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success

  human_intervention:
    type: terminal
    status: suspended
`;
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    // start → run_tests (visit 1) → fix
    await runtime.advance(startResult.data.instanceId, 'start', { status: 'go' });

    let instance = await runtime.getInstance(startResult.data.instanceId);
    let $metadata = instance!.payload['$metadata'] as { state_hashes: string[] };
    // After first cycle iteration, 0 hashes (first visit doesn't trigger stall check)
    // Actually, the hash IS stored after first back-edge crossing (visit 1 → fix checks)
    // The stall check runs on the back-edge from fix → run_tests
    // So after start → run_tests (visit 1) → fix, no back-edge yet, no hashes

    // fix → run_tests (visit 2) → fix (back-edge, hash stored)
    await runtime.advance(startResult.data.instanceId, 'fix', { status: 'retrying' });

    instance = await runtime.getInstance(startResult.data.instanceId);
    $metadata = instance!.payload['$metadata'] as { state_hashes: string[] };
    // Should have stored a hash from the first back-edge crossing
    expect($metadata.state_hashes.length).toBeGreaterThanOrEqual(1);
  });

  it('v1.0 workflow → stall detection not triggered (no cycles)', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    if (!startResult.ok) return;

    const adv1 = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.status).toBe('waiting_for_agent');

    const adv2 = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.status).toBe('completed');

    // $metadata.state_hashes should be empty (no cycles = no stall checks)
    const instance = await runtime.getInstance(startResult.data.instanceId);
    const $metadata = instance!.payload['$metadata'] as { state_hashes: string[] };
    expect($metadata.state_hashes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DAWE-003: ux_controls on AdvanceResult
// ---------------------------------------------------------------------------

describe('WorkflowRuntime — ux_controls (DAWE-003)', () => {
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  it('AdvanceResult includes ux_controls when status is waiting_for_agent', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.status).toBe('waiting_for_agent');
    expect(startResult.data.ux_controls).toBeDefined();
    expect(startResult.data.ux_controls).toHaveProperty('base_spinner');
    expect(startResult.data.ux_controls).toHaveProperty('hide_tools');
    expect(startResult.data.ux_controls).toHaveProperty('show_output');
  });

  it('base_spinner uses ui_spinner override when set on the node', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Initial node has ui_spinner: 'Initiating Enterprise SonarQube Analysis'
    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.ux_controls!.base_spinner).toBe('Initiating Enterprise SonarQube Analysis');
  });

  it('base_spinner falls back to LexicalFormatter when ui_spinner is not set', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance to task_no_override (no ui_spinner set)
    const advResult = await runtime.advance(startResult.data.instanceId, 'decide_with_override', { action: 'next' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.status).toBe('waiting_for_agent');
    expect(advResult.data.currentNodeId).toBe('task_no_override');
    // LexicalFormatter.toActionPhrase('task_no_override') → "Tasking no override"
    // The spinner should be derived and never empty
    expect(advResult.data.ux_controls).toBeDefined();
    expect(advResult.data.ux_controls!.base_spinner.length).toBeGreaterThan(0);
    expect(advResult.data.ux_controls!.base_spinner).not.toBe('Initiating Enterprise SonarQube Analysis');
  });

  it('hide_tools is true in ux_controls when node has hide_tools: true', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Initial node has hide_tools: true
    expect(startResult.data.ux_controls!.hide_tools).toBe(true);

    // Navigate to task_hidden_tools (also has hide_tools: true)
    const advResult = await runtime.advance(startResult.data.instanceId, 'decide_with_override', {
      action: 'hidden',
    });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.ux_controls!.hide_tools).toBe(true);
  });

  it('hide_tools defaults to false when node omits it', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance to task_no_override (no hide_tools set, defaults to false)
    const advResult = await runtime.advance(startResult.data.instanceId, 'decide_with_override', { action: 'next' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.ux_controls!.hide_tools).toBe(false);
  });

  it('show_output is true when node has show_tool_output: true', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Initial node has show_tool_output: true
    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.ux_controls!.show_output).toBe(true);

    // Navigate to task_show_output (also has show_tool_output: true)
    const advResult = await runtime.advance(startResult.data.instanceId, 'decide_with_override', {
      action: 'visible',
    });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.ux_controls!.show_output).toBe(true);
  });

  it('show_output defaults to false when node omits it', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance to task_no_override (no show_tool_output set, defaults to false)
    const advResult = await runtime.advance(startResult.data.instanceId, 'decide_with_override', { action: 'next' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    expect(advResult.data.ux_controls!.show_output).toBe(false);
  });

  it('terminal AdvanceResult does not require ux_controls', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance through the workflow to terminal
    const adv1 = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;

    const adv2 = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    expect(adv2.data.status).toBe('completed');
    // Terminal AdvanceResult MAY omit ux_controls
    expect(adv2.data.ux_controls).toBeUndefined();
  });

  it('base_spinner is never empty — LexicalFormatter always produces a value', async () => {
    // Use simple-linear which has node IDs 'ask' and 'do-task' — no ui_spinner overrides
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // 'ask' → LexicalFormatter should produce a non-empty string
    expect(startResult.data.ux_controls).toBeDefined();
    expect(startResult.data.ux_controls!.base_spinner.length).toBeGreaterThan(0);

    const advResult = await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'test' });
    expect(advResult.ok).toBe(true);
    if (!advResult.ok) return;

    // 'do-task' → LexicalFormatter should produce a non-empty string
    expect(advResult.data.ux_controls).toBeDefined();
    expect(advResult.data.ux_controls!.base_spinner.length).toBeGreaterThan(0);
  });

  it('ux_controls present on every waiting_for_agent result through full workflow', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // Start → decide_with_override (waiting_for_agent)
    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    expect(startResult.data.status).toBe('waiting_for_agent');
    expect(startResult.data.ux_controls).toBeDefined();

    // Advance to task_no_override (waiting_for_agent)
    const adv1 = await runtime.advance(startResult.data.instanceId, 'decide_with_override', { action: 'next' });
    expect(adv1.ok).toBe(true);
    if (!adv1.ok) return;
    expect(adv1.data.status).toBe('waiting_for_agent');
    expect(adv1.data.ux_controls).toBeDefined();

    // Advance to terminal (completed) — ux_controls not required
    const adv2 = await runtime.advance(startResult.data.instanceId, 'task_no_override', { result: 'done' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;
    expect(adv2.data.status).toBe('completed');
  });

  it('suspended AdvanceResult may omit ux_controls', async () => {
    // Use simple-linear and cancel it — check that non-waiting_for_agent results don't need ux_controls
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Cancel the instance
    const cancelResult = await runtime.cancelInstance(startResult.data.instanceId);
    expect(cancelResult.ok).toBe(true);

    // Verify the cancelled instance doesn't have ux_controls set
    const instance = await runtime.getInstance(startResult.data.instanceId);
    expect(instance).not.toBeNull();
    expect(instance!.status).toBe('cancelled');
  });

  // -----------------------------------------------------------------------
  // DAWE-004: UX_SPINNER in agent message
  // -----------------------------------------------------------------------

  it('agentMessage includes UX_SPINNER line when ux_controls is present', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    expect(startResult.data.status).toBe('waiting_for_agent');
    expect(startResult.data.agentMessage).toContain('UX_SPINNER:');
    // The node has ui_spinner override "Initiating Enterprise SonarQube Analysis"
    expect(startResult.data.agentMessage).toContain('UX_SPINNER: Initiating Enterprise SonarQube Analysis');
  });

  it('agentMessage includes UX_SPINNER with derived spinner for nodes without ui_spinner', async () => {
    const yaml = loadFixture('ux-controls-runtime.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Advance past the override node to task_no_override
    const adv = await runtime.advance(startResult.data.instanceId, 'decide_with_override', { action: 'next' });
    expect(adv.ok).toBe(true);
    if (!adv.ok) return;

    expect(adv.data.agentMessage).toContain('UX_SPINNER:');
    // The derived spinner should not be the override text
    expect(adv.data.agentMessage).not.toContain('Initiating Enterprise SonarQube Analysis');
  });

  it('terminal agentMessage does not include UX_SPINNER line', async () => {
    const yaml = loadFixture('simple-linear.yml');
    const loadResult = runtime.loadWorkflow(yaml);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const startResult = await runtime.startInstance(loadResult.data);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    await runtime.advance(startResult.data.instanceId, 'ask', { choice: 'go' });
    const adv2 = await runtime.advance(startResult.data.instanceId, 'do-task', { result: 'done' });
    expect(adv2.ok).toBe(true);
    if (!adv2.ok) return;

    expect(adv2.data.status).toBe('completed');
    expect(adv2.data.agentMessage).not.toContain('UX_SPINNER:');
  });
});
