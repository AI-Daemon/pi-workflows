/**
 * Error Recovery E2E Tests
 *
 * Tests:
 * - Submit invalid payload → receive detailed error → resubmit correct payload → workflow continues
 * - Submit wrong node_id → receive error → submit correct node_id → workflow continues
 * - System action exits non-zero → transitions to error-handling branch → reaches failure terminal
 * - Verify error messages are clear enough for an LLM to self-correct
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../setup.js';
import { AgentSimulator } from '../helpers/agent-simulator.js';
import '../helpers/assertion-helpers.js';

describe('Error Recovery E2E', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  it('should recover from invalid payload and continue workflow', async () => {
    const sim = new AgentSimulator(env.handler);
    const start = await sim.startWorkflow('linear-3-step');
    expect(start).toBeAtNode('decide');

    // Submit invalid payload (missing required fields)
    const errorState = await sim.advance({});
    expect(errorState.isError).toBe(true);
    expect(errorState.rawResponse).toContain('PAYLOAD_VALIDATION_FAILED');

    // Error message should be descriptive enough for self-correction
    expect(errorState.rawResponse).toContain('Missing');
    expect(errorState.rawResponse).toContain('action');

    // Resubmit with correct payload — workflow should continue
    const recovered = await sim.advance({ action: 'fix', priority: 3 });
    expect(recovered).toBeAtNode('execute');
    expect(recovered).toBeWaitingForAgent();
    expect(recovered.isError).toBe(false);
  });

  it('should recover from wrong node_id and continue workflow', async () => {
    const sim = new AgentSimulator(env.handler);
    const start = await sim.startWorkflow('linear-3-step');
    expect(start).toBeAtNode('decide');

    // Submit with wrong node_id
    const errorState = await sim.advanceWithNodeId('execute', { action: 'test', priority: 1 });
    expect(errorState.isError).toBe(true);
    expect(errorState.rawResponse).toContain('NODE_MISMATCH');

    // Error message should be clear
    expect(errorState.rawResponse).toContain('decide');
    expect(errorState.rawResponse).toContain('execute');

    // Submit with correct node_id — workflow should continue
    const recovered = await sim.advance({ action: 'test', priority: 1 });
    expect(recovered).toBeAtNode('execute');
    expect(recovered.isError).toBe(false);
  });

  it('should transition to error branch when system action fails', async () => {
    const sim = new AgentSimulator(env.handler);
    const start = await sim.startWorkflow('error-paths');
    expect(start).toBeAtNode('start-decision');

    // Submit project name that causes check-issue to fail (exit 1)
    const state = await sim.advance({ project_name: 'no-issue-project', action: 'check' });

    // Should route to error-handler (non-zero exit code branch)
    expect(state).toBeAtNode('error-handler');
    expect(state).toBeWaitingForAgent();
    expect(state.rawResponse).toContain('error');

    // Complete through error handler
    const done = await sim.advance({ recovery_action: 'create new issue' });
    expect(done).toBeCompleted('failure');
  });

  it('should transition to success when system action succeeds', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('error-paths');

    // "has-issue" is the magic value that makes mock-check-issue.sh exit 0
    const state = await sim.advance({ project_name: 'has-issue', action: 'check' });

    // Should route to success-path (exit code 0 branch)
    expect(state).toBeAtNode('success-path');
    expect(state).toBeWaitingForAgent();
  });

  it('should provide clear error messages for payload type mismatches', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('linear-3-step');

    // Submit with wrong type (priority should be number, not string)
    // Note: The schema uses { action: string, priority: number }
    const errorState = await sim.advance({ action: 'test', priority: 'high' });
    expect(errorState.isError).toBe(true);
    expect(errorState.rawResponse).toContain('PAYLOAD_VALIDATION_FAILED');
    expect(errorState.rawResponse).toContain('priority');
  });

  it('should handle missing required parameters for advance action', async () => {
    const result = await env.handler.handle({
      action: 'advance',
      // Missing instance_id, current_node_id, node_payload
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Missing required parameter');
    expect(result.text).toContain('instance_id');
    expect(result.text).toContain('current_node_id');
    expect(result.text).toContain('node_payload');
  });

  it('should handle non-existent instance_id', async () => {
    const result = await env.handler.handle({
      action: 'advance',
      instance_id: 'non-existent-id',
      current_node_id: 'some-node',
      node_payload: { test: true },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('INSTANCE_NOT_FOUND');
  });
});
