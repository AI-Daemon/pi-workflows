/**
 * Integration tests for workflow instance persistence.
 *
 * Tests the full lifecycle: start workflow → advance nodes → "kill" runtime →
 * create new runtime → recover → resume → complete.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileInstanceStore } from '../../src/engine/instance-store-file.js';
import type { WorkflowInstance } from '../../src/engine/advance-result.js';
import type { WorkflowMetadata } from '../../src/engine/expression-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstance(overrides?: Partial<WorkflowInstance>): WorkflowInstance {
  const now = Date.now();
  return {
    instanceId: overrides?.instanceId ?? `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workflowId: 'wf-int-001',
    workflowName: 'integration-test-workflow',
    status: 'active',
    currentNodeId: 'start_node',
    currentNodeType: 'system_action',
    payload: { step: 0 },
    history: [
      {
        nodeId: 'start_node',
        nodeType: 'system_action',
        enteredAt: now,
        payloadSnapshot: { step: 0 },
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Persistence Integration', () => {
  let tempDir: string;
  let store: FileInstanceStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dawe-int-'));
    store = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('full lifecycle: start → advance 3 nodes → kill → recover → resume → complete', async () => {
    // --- Phase 1: Create and advance the instance ---
    const instance = makeInstance({ instanceId: 'lifecycle-1' });

    // Simulate advancing through 3 nodes
    instance.currentNodeId = 'node_1';
    instance.currentNodeType = 'llm_task';
    instance.payload = { step: 1, node_1_result: 'done' };
    instance.status = 'active';
    instance.history.push({
      nodeId: 'node_1',
      nodeType: 'llm_task',
      enteredAt: Date.now(),
      completedAt: Date.now(),
      payloadSnapshot: { step: 1 },
    });
    instance.updatedAt = Date.now();
    // Save as completed so it writes immediately
    instance.status = 'waiting_for_agent';
    // For waiting_for_agent, mark as completed temporarily to force immediate write
    const savedInstance = structuredClone(instance);
    savedInstance.status = 'completed';
    savedInstance.completedAt = Date.now();
    await store.save(savedInstance);
    await new Promise((r) => setTimeout(r, 50));

    // Overwrite with waiting_for_agent status to simulate mid-workflow
    const filePath = join(tempDir, 'lifecycle-1.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8')) as {
      instance: { status: string; completedAt?: number; currentNodeId: string; payload: Record<string, unknown> };
    };
    content.instance.status = 'waiting_for_agent';
    delete content.instance.completedAt;
    content.instance.currentNodeId = 'node_3';
    content.instance.payload = { step: 3, node_1_result: 'done', node_2_result: 'ok', node_3_result: 'pending' };
    await writeFile(filePath, JSON.stringify(content), 'utf-8');

    // --- Phase 2: "Kill" the runtime (store goes out of scope) ---
    // Create a new store (simulating restart)
    const store2 = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });

    // --- Phase 3: Recover ---
    const recovery = await store2.recoverInstances(() => true);
    expect(recovery.recovered).toContain('lifecycle-1');

    // --- Phase 4: Load and verify state ---
    const recovered = await store2.load('lifecycle-1');
    expect(recovered).not.toBeNull();
    expect(recovered!.currentNodeId).toBe('node_3');
    expect(recovered!.payload['node_1_result']).toBe('done');
    expect(recovered!.payload['node_2_result']).toBe('ok');

    // --- Phase 5: "Complete" the workflow ---
    recovered!.status = 'completed';
    recovered!.completedAt = Date.now();
    recovered!.terminalStatus = 'success';
    await store2.save(recovered!);
    await new Promise((r) => setTimeout(r, 50));

    const final = await store2.load('lifecycle-1');
    expect(final!.status).toBe('completed');
    expect(final!.terminalStatus).toBe('success');
  });

  it('two instances persisted → both recovered independently', async () => {
    const i1 = makeInstance({ instanceId: 'multi-1', payload: { data: 'first' } });
    const i2 = makeInstance({ instanceId: 'multi-2', payload: { data: 'second' } });

    // Write both as active instances
    for (const inst of [i1, i2]) {
      const filePath = join(tempDir, `${inst.instanceId}.json`);
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: inst,
          payload: inst.payload,
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );
    }

    const newStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });
    const recovery = await newStore.recoverInstances(() => true);

    expect(recovery.recovered.sort()).toEqual(['multi-1', 'multi-2']);

    const loaded1 = await newStore.load('multi-1');
    const loaded2 = await newStore.load('multi-2');
    expect(loaded1!.payload['data']).toBe('first');
    expect(loaded2!.payload['data']).toBe('second');
  });

  it('recovered instance payload contains all accumulated data from pre-crash nodes', async () => {
    const instance = makeInstance({ instanceId: 'accum-1' });
    instance.payload = {
      step1_result: 'done',
      step2_data: { count: 42 },
      step3_array: [1, 2, 3],
      action_result: { exit_code: 0, stdout: 'success', stderr: '' },
    };

    const filePath = join(tempDir, 'accum-1.json');
    await writeFile(
      filePath,
      JSON.stringify({
        version: '1.0',
        instance,
        payload: instance.payload,
        payloadHistory: [],
        savedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const newStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });
    const recovery = await newStore.recoverInstances(() => true);
    expect(recovery.recovered).toContain('accum-1');

    const loaded = await newStore.load('accum-1');
    expect(loaded!.payload['step1_result']).toBe('done');
    expect(loaded!.payload['step2_data']).toEqual({ count: 42 });
    expect(loaded!.payload['step3_array']).toEqual([1, 2, 3]);
  });

  it('v2.0 cycle recovery: visits and metadata preserved across restart', async () => {
    const now = Date.now();
    const metadata: WorkflowMetadata = {
      visits: { assess_intent: 1, run_tests: 2, fix_tests: 1 },
      state_hashes: ['sha256:aaa', 'sha256:bbb'],
      instance_id: 'cycle-recover-1',
      started_at: new Date(now - 5000).toISOString(),
    };

    const instance = makeInstance({
      instanceId: 'cycle-recover-1',
      workflowName: 'issue-first-development',
      currentNodeId: 'run_tests',
      status: 'waiting_for_agent',
      payload: {
        project_name: 'pi-daemon',
        $metadata: metadata,
      },
    });

    const filePath = join(tempDir, 'cycle-recover-1.json');
    await writeFile(
      filePath,
      JSON.stringify({
        version: '1.0',
        instance,
        payload: instance.payload,
        payloadHistory: [],
        savedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    // Simulate restart
    const newStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });
    const recovery = await newStore.recoverInstances(() => true);
    expect(recovery.recovered).toContain('cycle-recover-1');

    const loaded = await newStore.load('cycle-recover-1');
    const meta = loaded!.payload['$metadata'] as WorkflowMetadata;
    expect(meta.visits['run_tests']).toBe(2);
    expect(meta.visits['fix_tests']).toBe(1);
    expect(meta.state_hashes).toEqual(['sha256:aaa', 'sha256:bbb']);
  });

  it('v2.0 suspended recovery: instance listed as suspended with correct stall hash', async () => {
    const now = Date.now();
    const metadata: WorkflowMetadata = {
      visits: { run_tests: 3, fix_tests: 2 },
      state_hashes: ['sha256:aaa', 'sha256:bbb', 'sha256:aaa'],
      instance_id: 'stall-recover-1',
      started_at: new Date(now - 10000).toISOString(),
      stall_detected: true,
    };

    const instance: WorkflowInstance = {
      instanceId: 'stall-recover-1',
      workflowId: 'wf-v2',
      workflowName: 'issue-first-development',
      status: 'suspended',
      currentNodeId: 'run_tests',
      currentNodeType: 'system_action',
      payload: {
        project_name: 'pi-daemon',
        $metadata: metadata,
      },
      history: [],
      createdAt: now - 10000,
      updatedAt: now,
      completedAt: now,
      terminalStatus: 'suspended',
    };

    const filePath = join(tempDir, 'stall-recover-1.json');
    await writeFile(
      filePath,
      JSON.stringify({
        version: '1.0',
        instance,
        payload: instance.payload,
        payloadHistory: [],
        savedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const newStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0 });
    const recovery = await newStore.recoverInstances(() => true);
    expect(recovery.suspended).toContain('stall-recover-1');

    const loaded = await newStore.load('stall-recover-1');
    expect(loaded!.status).toBe('suspended');
    const meta = loaded!.payload['$metadata'] as WorkflowMetadata;
    expect(meta.stall_detected).toBe(true);
    expect(meta.state_hashes).toEqual(['sha256:aaa', 'sha256:bbb', 'sha256:aaa']);
  });
});
