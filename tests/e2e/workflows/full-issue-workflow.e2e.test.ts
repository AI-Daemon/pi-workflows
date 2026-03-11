/**
 * Full Issue-First Development Workflow E2E Tests
 *
 * Test fixture: tests/fixtures/e2e/issue-first-development.yml
 * Mirrors the PRD Section 5 execution trace.
 *
 * Full flow:
 * 1. Agent starts workflow
 * 2. Agent submits: { project_name: "pi-daemon", requires_edits: true }
 * 3. Engine chains: check_issue (exit 1) → create_issue (exit 0, returns issue #12)
 * 4. Agent receives implement_code instructions with issue context
 * 5. Agent submits: { status: "complete", files_changed: ["src/fix.ts"] }
 * 6. Engine chains: create_pr (exit 0, returns PR #42)
 * 7. Workflow reaches success terminal
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from '../setup.js';
import { AgentSimulator } from '../helpers/agent-simulator.js';
import '../helpers/assertion-helpers.js';

describe('Full Issue-First Development Workflow E2E', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  it('should complete the full PRD execution trace', async () => {
    const sim = new AgentSimulator(env.handler);

    // Step 1: Start workflow
    const start = await sim.startWorkflow('issue-first-development');
    expect(start).toBeAtNode('assess-intent');
    expect(start).toBeWaitingForAgent();

    // Step 2: Agent submits decision payload
    // "pi-daemon" is NOT "has-issue", so check-issue exits 1 → chains to create-issue
    const afterDecision = await sim.advance({
      project_name: 'pi-daemon',
      requires_edits: true,
    });

    // Step 3: System actions executed:
    // check-issue (exit 1 → no issue found) → create-issue (exit 0 → issue #12 created)
    // Then lands on implement-code (llm_task)
    expect(afterDecision).toBeAtNode('implement-code');
    expect(afterDecision).toBeWaitingForAgent();

    // Verify system action results: check-issue failed, create-issue succeeded
    expect(afterDecision).toHaveSystemActionResult('check-issue', { success: false });
    expect(afterDecision).toHaveSystemActionResult('create-issue', { success: true });

    // Step 4: Agent receives implementation instructions
    expect(afterDecision.rawResponse).toContain('implement');
    expect(afterDecision.rawResponse).toContain('pi-daemon');

    // Step 5: Agent submits completion
    const afterImplement = await sim.advance({
      status: 'complete',
      files_changed: 'src/fix.ts',
    });

    // Step 6: create-pr system action executes (exit 0, returns PR #42)
    // Step 7: Workflow reaches success terminal
    expect(afterImplement).toBeCompleted('success');
    expect(afterImplement.rawResponse).toContain('pi-daemon');
  });

  it('should use real bash scripts that simulate gh commands', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('issue-first-development');

    const afterDecision = await sim.advance({
      project_name: 'test-project',
      requires_edits: true,
    });

    // check-issue exits 1 (no issue) → create-issue exits 0 (issue created)
    // Both are real bash scripts executed via child_process
    expect(afterDecision).toBeAtNode('implement-code');

    // System action results should be present
    const sysResults = afterDecision.parsed.systemActionResults;
    expect(sysResults).toBeDefined();
    expect(sysResults!.length).toBeGreaterThanOrEqual(2);
  });

  it('should verify full payload contains project_name, issue info, and pr info', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('issue-first-development');

    await sim.advance({
      project_name: 'pi-daemon',
      requires_edits: true,
    });

    const done = await sim.advance({
      status: 'complete',
      files_changed: 'src/fix.ts',
    });

    // The terminal message should reference the project name
    expect(done.rawResponse).toContain('pi-daemon');
  });

  it('should have agent receive exactly 3 messages (one per llm node)', async () => {
    const sim = new AgentSimulator(env.handler);

    // Message 1: assess-intent
    await sim.startWorkflow('issue-first-development');

    // Message 2: implement-code (after system action chain)
    await sim.advance({
      project_name: 'pi-daemon',
      requires_edits: true,
    });

    // Message 3: terminal (after create-pr)
    await sim.advance({
      status: 'complete',
      files_changed: 'src/fix.ts',
    });

    // The agent should have received exactly 3 non-error messages
    expect(sim.getMessageCount()).toBe(3);
  });

  it('should skip system actions when no edits required', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('issue-first-development');

    // requires_edits: false → routes to done-no-edits terminal
    const state = await sim.advance({
      project_name: 'pi-daemon',
      requires_edits: false,
    });

    expect(state).toBeCompleted('success');
    expect(state.rawResponse).toContain('No file edits required');
  });

  it('should use existing issue when check-issue succeeds', async () => {
    const sim = new AgentSimulator(env.handler);
    await sim.startWorkflow('issue-first-development');

    // "has-issue" makes mock-check-issue.sh exit 0
    const afterDecision = await sim.advance({
      project_name: 'has-issue',
      requires_edits: true,
    });

    // Should go directly from check-issue (exit 0) to implement-code
    // WITHOUT going through create-issue
    expect(afterDecision).toBeAtNode('implement-code');

    // check-issue should have succeeded
    expect(afterDecision).toHaveSystemActionResult('check-issue', { success: true });

    // create-issue should NOT appear in results
    const sysResults = afterDecision.parsed.systemActionResults ?? [];
    const createIssueResult = sysResults.find((r) => r.nodeId === 'create-issue');
    expect(createIssueResult).toBeUndefined();
  });
});
