/**
 * Linear Workflow E2E Tests
 *
 * Test fixture: tests/fixtures/e2e/linear-3-step.yml
 * Flow: decision → task → terminal
 *
 * Tests:
 * - Start workflow → agent receives first node instructions
 * - Submit decision payload → agent receives task instructions
 * - Submit task completion → workflow completes with success
 * - Verify all 3 nodes appear in history
 * - Verify payload accumulated correctly at each step
 * - Verify agent messages are well-formatted at each step
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../setup.js';
import { AgentSimulator } from '../helpers/agent-simulator.js';
import '../helpers/assertion-helpers.js';

describe('Linear Workflow E2E', () => {
  let env: TestEnvironment;
  let sim: AgentSimulator;

  beforeEach(async () => {
    env = await createTestEnvironment();
    sim = new AgentSimulator(env.handler);
  });

  it('should start workflow and receive first node instructions', async () => {
    const state = await sim.startWorkflow('linear-3-step');

    expect(state).toBeAtNode('decide');
    expect(state).toBeWaitingForAgent();
    expect(state.isError).toBe(false);
    expect(state.parsed.workflowName).toBe('linear-3-step');
    expect(state.parsed.instruction).toBeDefined();
    expect(state.rawResponse).toContain('decide');
  });

  it('should advance through decision and receive task instructions', async () => {
    await sim.startWorkflow('linear-3-step');

    const state = await sim.advance({ action: 'implement', priority: 5 });

    expect(state).toBeAtNode('execute');
    expect(state).toBeWaitingForAgent();
    expect(state.isError).toBe(false);
    expect(state.rawResponse).toContain('execute');
  });

  it('should complete workflow after submitting task result', async () => {
    await sim.startWorkflow('linear-3-step');
    await sim.advance({ action: 'implement', priority: 5 });

    const state = await sim.advance({ result: 'feature implemented', success: true });

    expect(state).toBeCompleted('success');
    expect(state.isError).toBe(false);
  });

  it('should have all 3 nodes in history after completion', async () => {
    await sim.startWorkflow('linear-3-step');
    await sim.advance({ action: 'implement', priority: 5 });
    const state = await sim.advance({ result: 'done', success: true });

    // The completed response should contain a workflow history
    expect(state.rawResponse).toContain('Workflow History');
    expect(state.rawResponse).toContain('decide');
    expect(state.rawResponse).toContain('execute');
    expect(state.rawResponse).toContain('done');
  });

  it('should accumulate payload correctly at each step', async () => {
    const s1 = await sim.startWorkflow('linear-3-step');
    expect(s1).toBeAtNode('decide');

    const s2 = await sim.advance({ action: 'deploy', priority: 10 });
    expect(s2).toBeAtNode('execute');
    // The instruction should reference the payload from the decision
    // (via Handlebars template in the workflow YAML)

    const s3 = await sim.advance({ result: 'deployment completed', success: true });
    expect(s3).toBeCompleted('success');
    // Terminal message references payload values
    expect(s3.rawResponse).toContain('deploy');
    expect(s3.rawResponse).toContain('deployment completed');
  });

  it('should produce well-formatted agent messages at each step', async () => {
    const s1 = await sim.startWorkflow('linear-3-step');
    // First message should have workflow name and instance ID
    expect(s1.parsed.workflowName).toBeTruthy();
    expect(s1.parsed.instanceId).toBeTruthy();
    expect(s1.rawResponse.length).toBeGreaterThan(0);

    const s2 = await sim.advance({ action: 'test', priority: 1 });
    // Second message should have node info
    expect(s2.parsed.currentNodeId).toBe('execute');
    expect(s2.rawResponse.length).toBeGreaterThan(0);

    const s3 = await sim.advance({ result: 'tested', success: true });
    // Third message should indicate completion
    expect(s3.parsed.isTerminal).toBe(true);
    expect(s3.rawResponse.length).toBeGreaterThan(0);
  });
});
