/**
 * Unit tests for AdvanceWorkflowHandler — the advance_workflow tool handler.
 *
 * Minimum 25 test cases covering all 5 actions: list, start, advance, status, cancel.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';

import { WorkflowRuntime } from '../../../src/engine/workflow-runtime.js';
import { WorkflowRegistry } from '../../../src/extension/workflow-registry.js';
import { AdvanceWorkflowHandler } from '../../../src/extension/advance-workflow-tool.js';
import type { AdvanceWorkflowInput } from '../../../src/extension/advance-workflow-tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a test handler with a pre-populated registry.
 * We manually load workflows into the runtime and create a mock registry.
 */
function createTestHandler(): {
  handler: AdvanceWorkflowHandler;
  runtime: WorkflowRuntime;
  registry: WorkflowRegistry;
} {
  const runtime = new WorkflowRuntime();
  // Use a registry pointing to the test fixtures directory
  const registry = new WorkflowRegistry([resolve('tests/fixtures/workflows')]);
  const handler = new AdvanceWorkflowHandler(runtime, registry);
  return { handler, runtime, registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdvanceWorkflowHandler', () => {
  let handler: AdvanceWorkflowHandler;
  let runtime: WorkflowRuntime;
  let registry: WorkflowRegistry;

  beforeEach(async () => {
    const setup = createTestHandler();
    handler = setup.handler;
    runtime = setup.runtime;
    registry = setup.registry;
    await registry.loadAll();
  });

  // =========================================================================
  // Action: list
  // =========================================================================

  describe('Action: list', () => {
    it('should list available workflows as a markdown table', async () => {
      const result = await handler.handle({ action: 'list' });

      expect(result.text).toContain('## Available Workflows');
      expect(result.text).toContain('| # | Workflow | Description |');
      expect(result.text).toContain('simple-linear');
      expect(result.isError).toBeUndefined();
    });

    it('should list all workflows from the fixtures directory', async () => {
      const result = await handler.handle({ action: 'list' });

      // Should contain all valid workflow fixtures
      expect(result.text).toContain('simple-linear');
      expect(result.text).toContain('branching-workflow');
      expect(result.text).toContain('system-action-chain');
    });

    it('should show "no workflows" message when registry is empty', async () => {
      const emptyRegistry = new WorkflowRegistry(['/nonexistent/path']);
      await emptyRegistry.loadAll();
      const emptyHandler = new AdvanceWorkflowHandler(runtime, emptyRegistry);

      const result = await emptyHandler.handle({ action: 'list' });

      expect(result.text).toContain('No workflows are currently available');
    });
  });

  // =========================================================================
  // Action: start
  // =========================================================================

  describe('Action: start', () => {
    it('should start a valid workflow and return first node instructions', async () => {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('**WORKFLOW:** simple-linear');
      expect(result.text).toContain('**INSTANCE:**');
      expect(result.text).toContain('ask');
      expect(result.text).toContain('advance_workflow');
    });

    it('should return error for nonexistent workflow with available list', async () => {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'does-not-exist',
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('not found');
      expect(result.text).toContain('simple-linear');
    });

    it('should require workflow_name parameter', async () => {
      const result = await handler.handle({ action: 'start', confirm: true });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('workflow_name');
    });

    it('should pass initial payload to runtime when provided', async () => {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        node_payload: { initial_data: 'test' },
        confirm: true,
      });

      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('**INSTANCE:**');
    });

    it('should return correct instance_id in response', async () => {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      // Extract instance ID from the response (it's a UUID)
      const match = result.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
      expect(match).not.toBeNull();
      expect(match![1]!.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Action: advance
  // =========================================================================

  describe('Action: advance', () => {
    async function startSimpleLinear(): Promise<{ instanceId: string; nodeId: string }> {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });
      const instanceMatch = result.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
      const nodeMatch = result.text.match(/Current Node: `([^`]+)`/);
      return {
        instanceId: instanceMatch![1]!,
        nodeId: nodeMatch![1]!,
      };
    }

    it('should advance with valid payload and return next node', async () => {
      const { instanceId, nodeId } = await startSimpleLinear();

      const result = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
        node_payload: { choice: 'implement' },
      });

      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('do-task');
    });

    it('should return error for missing instance_id', async () => {
      const result = await handler.handle({
        action: 'advance',
        current_node_id: 'ask',
        node_payload: { choice: 'test' },
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('instance_id');
    });

    it('should return NODE_MISMATCH error for wrong node_id', async () => {
      const { instanceId } = await startSimpleLinear();

      const result = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'wrong-node',
        node_payload: { choice: 'test' },
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('NODE_MISMATCH');
    });

    it('should return PAYLOAD_VALIDATION_FAILED with field details for invalid payload', async () => {
      const { instanceId, nodeId } = await startSimpleLinear();

      const result = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
        node_payload: {}, // missing required 'choice' field
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('PAYLOAD_VALIDATION_FAILED');
    });

    it('should reach terminal node and return completed response', async () => {
      const { instanceId, nodeId } = await startSimpleLinear();

      // Advance through ask → do-task
      const step1 = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
        node_payload: { choice: 'implement' },
      });

      const nodeMatch2 = step1.text.match(/Current Node: `([^`]+)`/);
      expect(nodeMatch2).not.toBeNull();

      // Advance through do-task → done (terminal)
      const step2 = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeMatch2![1]!,
        node_payload: { result: 'all done' },
      });

      expect(step2.text).toContain('Workflow completed');
      expect(step2.text).toContain('Workflow History');
    });

    it('should return INSTANCE_NOT_ACTIVE when advancing completed instance', async () => {
      const { instanceId, nodeId } = await startSimpleLinear();

      // Complete the workflow
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
        node_payload: { choice: 'implement' },
      });

      const instance = await runtime.getInstance(instanceId);
      // Get the second node — complete the workflow
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: instance!.currentNodeId,
        node_payload: { result: 'done' },
      });
      // Workflow is now completed

      // Try advancing again
      const step3 = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'done',
        node_payload: {},
      });

      expect(step3.isError).toBe(true);
      expect(step3.text).toContain('INSTANCE_NOT_ACTIVE');
    });

    it('should return error for missing node_payload', async () => {
      const { instanceId, nodeId } = await startSimpleLinear();

      const result = await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('node_payload');
    });

    it('should handle system action chain and include results in response', async () => {
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'system-action-chain',
        confirm: true,
      });

      expect(result.isError).toBeUndefined();

      // First node should be start-task (llm_task)
      expect(result.text).toContain('start-task');

      // Extract instance and advance past start-task
      const instanceMatch = result.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
      const advanceResult = await handler.handle({
        action: 'advance',
        instance_id: instanceMatch![1]!,
        current_node_id: 'start-task',
        node_payload: { project_name: 'test-project' },
      });

      // After advancing, system actions should have auto-executed
      expect(advanceResult.text).toContain('System Actions Executed');
      expect(advanceResult.text).toContain('check-status');
      expect(advanceResult.text).toContain('setup-env');
    });
  });

  // =========================================================================
  // Action: status
  // =========================================================================

  describe('Action: status', () => {
    it('should return status of an active instance', async () => {
      const startResult = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      const instanceMatch = startResult.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);

      const result = await handler.handle({
        action: 'status',
        instance_id: instanceMatch![1],
      });

      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('Instance Status');
      expect(result.text).toContain('ask');
      expect(result.text).toContain('waiting_for_agent');
    });

    it('should return status of a completed instance', async () => {
      const startResult = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });
      const instanceMatch = startResult.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
      const instanceId = instanceMatch![1]!;

      // Complete the workflow
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'ask',
        node_payload: { choice: 'test' },
      });
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'do-task',
        node_payload: { result: 'done' },
      });

      const result = await handler.handle({
        action: 'status',
        instance_id: instanceId,
      });

      expect(result.text).toContain('completed');
      expect(result.text).toContain('Terminal Status');
    });

    it('should return INSTANCE_NOT_FOUND for nonexistent instance', async () => {
      const result = await handler.handle({
        action: 'status',
        instance_id: 'nonexistent-id',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('INSTANCE_NOT_FOUND');
    });

    it('should require instance_id parameter', async () => {
      const result = await handler.handle({ action: 'status' });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('instance_id');
    });
  });

  // =========================================================================
  // Action: cancel
  // =========================================================================

  describe('Action: cancel', () => {
    it('should cancel an active instance and return confirmation', async () => {
      const startResult = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });
      const instanceMatch = startResult.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);

      const result = await handler.handle({
        action: 'cancel',
        instance_id: instanceMatch![1],
      });

      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('cancelled');
    });

    it('should return error when cancelling a completed instance', async () => {
      const startResult = await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });
      const instanceMatch = startResult.text.match(/\*\*INSTANCE:\*\*\s+(\S+)/);
      const instanceId = instanceMatch![1]!;

      // Complete the workflow
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'ask',
        node_payload: { choice: 'test' },
      });
      await handler.handle({
        action: 'advance',
        instance_id: instanceId,
        current_node_id: 'do-task',
        node_payload: { result: 'done' },
      });

      const result = await handler.handle({
        action: 'cancel',
        instance_id: instanceId,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('INSTANCE_NOT_ACTIVE');
    });

    it('should return error for nonexistent instance', async () => {
      const result = await handler.handle({
        action: 'cancel',
        instance_id: 'nonexistent-id',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('INSTANCE_NOT_FOUND');
    });

    it('should require instance_id parameter', async () => {
      const result = await handler.handle({ action: 'cancel' });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('instance_id');
    });
  });

  // =========================================================================
  // P1: Active instance warning
  // =========================================================================

  describe('P1: Active instance warning', () => {
    it('should warn when starting a new workflow with an active instance', async () => {
      // Start first instance
      await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      // Try to start another without confirm
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'branching-workflow',
      });

      expect(result.text).toContain('WARNING');
      expect(result.text).toContain('active workflow instance');
    });

    it('should allow starting with confirm: true', async () => {
      // Start first instance
      await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      // Start another with confirm
      const result = await handler.handle({
        action: 'start',
        workflow_name: 'branching-workflow',
        confirm: true,
      });

      expect(result.text).toContain('**WORKFLOW:** branching-workflow');
    });
  });

  // =========================================================================
  // P1: Auto-resume
  // =========================================================================

  describe('P1: Auto-resume', () => {
    it('should show status when one active instance exists and no action given', async () => {
      await handler.handle({
        action: 'start',
        workflow_name: 'simple-linear',
        confirm: true,
      });

      // Call with no action — cast to bypass type check
      const result = await handler.handle({} as AdvanceWorkflowInput);

      expect(result.text).toContain('Instance Status');
    });

    it('should list workflows when no active instances and no action given', async () => {
      const result = await handler.handle({} as AdvanceWorkflowInput);

      expect(result.text).toContain('Available Workflows');
    });
  });
});
