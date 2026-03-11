/**
 * System Action Chain E2E Tests
 *
 * Test fixture: tests/fixtures/e2e/system-chain.yml + real bash scripts
 *
 * Tests:
 * - Agent submits data → engine chains through 3 system_actions → returns to agent
 * - All 3 system action results present in response
 * - Bash scripts actually executed (temp file creation verified)
 * - System action output merged into payload
 * - Timeout behavior: slow script times out, workflow continues
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestEnvironment, type TestEnvironment } from '../setup.js';
import { AgentSimulator } from '../helpers/agent-simulator.js';
import { cleanupTempFiles } from '../teardown.js';
import '../helpers/assertion-helpers.js';

describe('System Action Chain E2E', () => {
  let env: TestEnvironment;
  let sim: AgentSimulator;

  beforeEach(async () => {
    env = await createTestEnvironment();
    sim = new AgentSimulator(env.handler);
  });

  afterEach(async () => {
    await cleanupTempFiles();
  });

  it('should chain through 3 system actions and land on llm node', async () => {
    const start = await sim.startWorkflow('system-chain');
    expect(start).toBeAtNode('gather-info');

    const state = await sim.advance({ project_name: 'e2e-test', environment: 'staging' });

    // Should have auto-chained through create-temp-file, check-env, process-data
    // and landed on review-results (llm_task)
    expect(state).toBeAtNode('review-results');
    expect(state).toBeWaitingForAgent();
  });

  it('should have all 3 system action results in the response', async () => {
    await sim.startWorkflow('system-chain');
    const state = await sim.advance({ project_name: 'e2e-test', environment: 'staging' });

    // The response should mention system actions executed
    expect(state.rawResponse).toContain('create-temp-file');
    expect(state.rawResponse).toContain('check-env');
    expect(state.rawResponse).toContain('process-data');
  });

  it('should actually execute bash scripts (temp file creation)', async () => {
    await sim.startWorkflow('system-chain');
    await sim.advance({ project_name: 'verify-exec', environment: 'test' });

    // Verify the create-temp-file.sh script actually created a file
    const tempDir = tmpdir();
    const files = readdirSync(tempDir);
    const daweFiles = files.filter((f) => f.startsWith('dawe-e2e-verify-exec'));

    expect(daweFiles.length).toBeGreaterThanOrEqual(1);

    // Verify the file has content
    const filePath = join(tempDir, daweFiles[0]!);
    const content = readFileSync(filePath, 'utf-8');
    expect(content.trim()).toBe('created');
  });

  it('should merge system action output into payload', async () => {
    await sim.startWorkflow('system-chain');
    const state = await sim.advance({ project_name: 'payload-test', environment: 'dev' });

    // The review-results node has context_keys that should include system action data
    // The instruction references the project name from payload
    expect(state.rawResponse).toContain('payload-test');
  });

  it('should complete the full workflow after reviewing results', async () => {
    await sim.startWorkflow('system-chain');
    await sim.advance({ project_name: 'full-test', environment: 'prod' });

    const done = await sim.advance({ review_status: 'approved' });
    expect(done).toBeCompleted('success');
    expect(done.rawResponse).toContain('full-test');
  });

  it('should handle timeout on slow script', async () => {
    // Use the timeout-workflow which has a 2-second timeout on a slow script
    const start = await sim.startWorkflow('timeout-workflow');
    expect(start).toBeAtNode('start');

    const state = await sim.advance({ duration: '10' });

    // The slow script should time out (2s timeout, 10s sleep)
    // This should result in non-zero exit code and route to done-timeout
    expect(state).toBeCompleted();
    // The timed out script has exit code -1, which is != 0, so it goes to done-timeout
    expect(state.rawResponse).toContain('timed out');
  });
});
