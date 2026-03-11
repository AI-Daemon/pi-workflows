/**
 * Shared E2E test setup — creates runtime, loads workflows from fixtures.
 *
 * Each test suite should call `createTestEnvironment()` in beforeEach
 * to get a fresh runtime + handler for test isolation.
 */

import { resolve } from 'node:path';
import { WorkflowRuntime } from '../../src/engine/workflow-runtime.js';
import { WorkflowRegistry } from '../../src/extension/workflow-registry.js';
import { AdvanceWorkflowHandler } from '../../src/extension/advance-workflow-tool.js';

/** The resolved path to E2E workflow fixtures. */
export const E2E_FIXTURES_DIR = resolve('tests/fixtures/e2e');

/** Test environment with fresh runtime, registry, and handler. */
export interface TestEnvironment {
  runtime: WorkflowRuntime;
  registry: WorkflowRegistry;
  handler: AdvanceWorkflowHandler;
}

/**
 * Create a fresh test environment with isolated runtime and handler.
 *
 * Uses the E2E fixtures directory for workflow loading.
 * Each call returns a completely independent instance to prevent state leakage.
 */
export async function createTestEnvironment(): Promise<TestEnvironment> {
  const runtime = new WorkflowRuntime({
    executorOptions: {
      defaultTimeout: 10_000,
      maxTimeout: 30_000,
      workingDir: resolve('.'),
    },
  });

  const registry = new WorkflowRegistry([E2E_FIXTURES_DIR]);
  await registry.loadAll();

  const handler = new AdvanceWorkflowHandler(runtime, registry);

  return { runtime, registry, handler };
}
