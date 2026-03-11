/**
 * Branching Workflow E2E Tests
 *
 * Test fixture: tests/fixtures/e2e/branching-4-node.yml
 * Flow: decision → branch A or B → terminal
 *
 * Tests:
 * - Path A: Submit payload that routes to branch A → correct terminal
 * - Path B: Submit payload that routes to branch B → different terminal
 * - Verify branch A and B have different histories
 * - Verify payload contains branch-specific data
 * - Verify the "other" branch's nodes are NOT in history
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../setup.js';
import { AgentSimulator } from '../helpers/agent-simulator.js';
import '../helpers/assertion-helpers.js';

describe('Branching Workflow E2E', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  it('should route to alpha branch and reach alpha terminal', async () => {
    const sim = new AgentSimulator(env.handler);
    const start = await sim.startWorkflow('branching-4-node');

    expect(start).toBeAtNode('route');
    expect(start).toBeWaitingForAgent();

    const branch = await sim.advance({ path: 'alpha', reason: 'alpha is better' });
    expect(branch).toBeAtNode('alpha-task');
    expect(branch).toBeWaitingForAgent();

    const done = await sim.advance({ alpha_output: 'alpha work complete' });
    expect(done).toBeCompleted('success');
    expect(done.rawResponse).toContain('Alpha path completed');
    expect(done.rawResponse).toContain('alpha work complete');
  });

  it('should route to beta branch and reach beta terminal', async () => {
    const sim = new AgentSimulator(env.handler);
    const start = await sim.startWorkflow('branching-4-node');

    expect(start).toBeAtNode('route');

    const branch = await sim.advance({ path: 'beta', reason: 'beta is preferred' });
    expect(branch).toBeAtNode('beta-task');
    expect(branch).toBeWaitingForAgent();

    const done = await sim.advance({ beta_output: 'beta work complete' });
    expect(done).toBeCompleted('success');
    expect(done.rawResponse).toContain('Beta path completed');
    expect(done.rawResponse).toContain('beta work complete');
  });

  it('should have different histories for alpha and beta paths', async () => {
    // Run alpha path
    const simA = new AgentSimulator(env.handler);
    await simA.startWorkflow('branching-4-node');
    await simA.advance({ path: 'alpha', reason: 'alpha' });
    const doneA = await simA.advance({ alpha_output: 'done' });

    // Run beta path
    const simB = new AgentSimulator(env.handler);
    await simB.startWorkflow('branching-4-node');
    await simB.advance({ path: 'beta', reason: 'beta' });
    const doneB = await simB.advance({ beta_output: 'done' });

    // Alpha history should NOT contain beta nodes
    expect(doneA.rawResponse).toContain('alpha-task');
    expect(doneA.rawResponse).not.toContain('beta-task');
    expect(doneA.rawResponse).toContain('alpha-done');
    expect(doneA.rawResponse).not.toContain('beta-done');

    // Beta history should NOT contain alpha nodes
    expect(doneB.rawResponse).toContain('beta-task');
    expect(doneB.rawResponse).not.toContain('alpha-task');
    expect(doneB.rawResponse).toContain('beta-done');
    expect(doneB.rawResponse).not.toContain('alpha-done');
  });

  it('should contain branch-specific data in completed payload', async () => {
    const simA = new AgentSimulator(env.handler);
    await simA.startWorkflow('branching-4-node');
    await simA.advance({ path: 'alpha', reason: 'testing alpha' });
    const doneA = await simA.advance({ alpha_output: 'alpha result 42' });

    // Alpha terminal message should contain alpha-specific data
    expect(doneA.rawResponse).toContain('alpha result 42');
  });

  it('should fallback to beta for unknown paths', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('branching-4-node');

    // Unknown path — the catch-all (priority 99) routes to beta
    const branch = await sim.advance({ path: 'unknown', reason: 'unknown route' });
    expect(branch).toBeAtNode('beta-task');
  });
});
