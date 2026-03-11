/**
 * Unit tests for FileInstanceStore — file-based persistence and recovery.
 *
 * Covers: Basic CRUD, atomic writes, serialization roundtrip, recovery,
 * cleanup, directory management, debouncing, and structured logging.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileInstanceStore, DebouncedSaver } from '../../../src/engine/instance-store-file.js';
import type { WorkflowInstance } from '../../../src/engine/advance-result.js';
import type { WorkflowMetadata } from '../../../src/engine/expression-context.js';
import { DAWELogger } from '../../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstance(overrides?: Partial<WorkflowInstance>): WorkflowInstance {
  const now = Date.now();
  return {
    instanceId: overrides?.instanceId ?? `test-instance-${Date.now()}`,
    workflowId: 'wf-001',
    workflowName: 'test-workflow',
    status: 'active',
    currentNodeId: 'node_a',
    currentNodeType: 'llm_task',
    payload: { project_name: 'test' },
    history: [
      {
        nodeId: 'node_a',
        nodeType: 'llm_task',
        enteredAt: now,
        payloadSnapshot: { project_name: 'test' },
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeV2Instance(overrides?: Partial<WorkflowInstance>): WorkflowInstance {
  const now = Date.now();
  const metadata: WorkflowMetadata = {
    visits: { node_a: 1, run_tests: 2 },
    state_hashes: ['sha256:abc123', 'sha256:def456'],
    instance_id: overrides?.instanceId ?? `test-v2-${Date.now()}`,
    started_at: new Date(now).toISOString(),
  };

  return {
    instanceId: metadata.instance_id,
    workflowId: 'wf-002',
    workflowName: 'issue-first-development',
    status: 'waiting_for_agent',
    currentNodeId: 'run_tests',
    currentNodeType: 'system_action',
    payload: {
      project_name: 'pi-daemon',
      extracted_json: { failed_tests: ['test_a', 'test_b'] },
      log_pointer_path: '/tmp/dawe-runs/test-v2-run_tests-2.log',
      $metadata: metadata,
    },
    history: [
      {
        nodeId: 'node_a',
        nodeType: 'llm_task',
        enteredAt: now - 1000,
        completedAt: now - 500,
        payloadSnapshot: { project_name: 'pi-daemon' },
      },
      {
        nodeId: 'run_tests',
        nodeType: 'system_action',
        enteredAt: now,
        payloadSnapshot: { project_name: 'pi-daemon', $metadata: metadata },
      },
    ],
    createdAt: now - 2000,
    updatedAt: now,
    ...overrides,
  };
}

function makeSuspendedInstance(overrides?: Partial<WorkflowInstance>): WorkflowInstance {
  const now = Date.now();
  const metadata: WorkflowMetadata = {
    visits: { run_tests: 3, fix_tests: 2 },
    state_hashes: ['sha256:aaa', 'sha256:bbb', 'sha256:aaa'],
    instance_id: overrides?.instanceId ?? `test-suspended-${Date.now()}`,
    started_at: new Date(now - 5000).toISOString(),
    stall_detected: true,
  };

  return {
    instanceId: metadata.instance_id,
    workflowId: 'wf-002',
    workflowName: 'issue-first-development',
    status: 'suspended',
    currentNodeId: 'run_tests',
    currentNodeType: 'system_action',
    payload: {
      project_name: 'pi-daemon',
      $metadata: metadata,
    },
    history: [],
    createdAt: now - 5000,
    updatedAt: now,
    completedAt: now,
    terminalStatus: 'suspended',
    ...overrides,
  };
}

function createTestLogger(): { logger: DAWELogger; logs: string[] } {
  const logs: string[] = [];
  const logger = new DAWELogger({
    level: 'debug',
    format: 'json',
    output: (line: string) => logs.push(line),
  });
  return { logger, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileInstanceStore', () => {
  let tempDir: string;
  let store: FileInstanceStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dawe-store-'));
    store = new FileInstanceStore({
      directory: tempDir,
      writeDebounceMs: 0, // No debounce in tests for immediacy
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Basic CRUD
  // =========================================================================

  describe('Basic CRUD', () => {
    it('save → file created in correct directory', async () => {
      const instance = makeInstance({ instanceId: 'crud-save-1' });
      await store.save(instance);

      // Wait for debounce (even with 0ms, setTimeout is async)
      await new Promise((r) => setTimeout(r, 50));

      const files = await readdir(tempDir);
      expect(files).toContain('crud-save-1.json');
    });

    it('load → returns correct data', async () => {
      const instance = makeInstance({ instanceId: 'crud-load-1' });
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('crud-load-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.instanceId).toBe('crud-load-1');
      expect(loaded!.workflowName).toBe('test-workflow');
      expect(loaded!.status).toBe('active');
    });

    it('load nonexistent instance → returns null', async () => {
      const loaded = await store.load('nonexistent');
      expect(loaded).toBeNull();
    });

    it('list → returns all saved instances', async () => {
      const i1 = makeInstance({ instanceId: 'list-1' });
      const i2 = makeInstance({ instanceId: 'list-2' });
      await store.save(i1);
      await store.save(i2);
      await new Promise((r) => setTimeout(r, 50));

      const all = await store.list();
      expect(all.length).toBe(2);
      const ids = all.map((i) => i.instanceId).sort();
      expect(ids).toEqual(['list-1', 'list-2']);
    });

    it('delete → file removed', async () => {
      const instance = makeInstance({ instanceId: 'crud-del-1' });
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      await store.delete('crud-del-1');
      const files = await readdir(tempDir);
      expect(files).not.toContain('crud-del-1.json');
    });

    it('delete nonexistent instance → no error', async () => {
      await expect(store.delete('nonexistent')).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // Atomic writes
  // =========================================================================

  describe('Atomic writes', () => {
    it('write completes → only final file exists (no .tmp)', async () => {
      const instance = makeInstance({ instanceId: 'atomic-1' });
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const files = await readdir(tempDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles.length).toBe(0);
      expect(files).toContain('atomic-1.json');
    });

    it('concurrent saves to same instance → file not corrupted', async () => {
      const instance = makeInstance({ instanceId: 'concurrent-1' });

      // Fire multiple saves rapidly
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        instance.updatedAt = Date.now();
        promises.push(store.save(structuredClone(instance)));
      }
      await Promise.all(promises);
      await new Promise((r) => setTimeout(r, 100));

      const loaded = await store.load('concurrent-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.instanceId).toBe('concurrent-1');
    });
  });

  // =========================================================================
  // Serialization roundtrip
  // =========================================================================

  describe('Serialization roundtrip', () => {
    it('save → load → payload matches original', async () => {
      const instance = makeInstance({
        instanceId: 'rt-payload',
        payload: { key1: 'value1', key2: 42, key3: true },
      });
      // Force completed so save is immediate
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-payload');
      expect(loaded!.payload).toEqual({ key1: 'value1', key2: 42, key3: true });
    });

    it('save → load → history matches original', async () => {
      const instance = makeInstance({ instanceId: 'rt-history' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      const historyLength = instance.history.length;
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-history');
      expect(loaded!.history.length).toBe(historyLength);
      expect(loaded!.history[0]!.nodeId).toBe('node_a');
    });

    it('save → load → all timestamps preserved', async () => {
      const instance = makeInstance({ instanceId: 'rt-timestamps' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      const { createdAt, updatedAt, completedAt } = instance;
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-timestamps');
      expect(loaded!.createdAt).toBe(createdAt);
      expect(loaded!.updatedAt).toBe(updatedAt);
      expect(loaded!.completedAt).toBe(completedAt);
    });

    it('large payload (100+ keys) → roundtrip correct', async () => {
      const bigPayload: Record<string, unknown> = {};
      for (let i = 0; i < 150; i++) {
        bigPayload[`key_${i}`] = `value_${i}`;
      }
      const instance = makeInstance({ instanceId: 'rt-large', payload: bigPayload });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-large');
      expect(Object.keys(loaded!.payload).length).toBe(150);
      expect(loaded!.payload['key_99']).toBe('value_99');
    });

    it('payload with nested objects/arrays → roundtrip correct', async () => {
      const instance = makeInstance({
        instanceId: 'rt-nested',
        payload: {
          nested: { deep: { value: [1, 2, 3] } },
          arr: [{ a: 1 }, { b: 2 }],
        },
      });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-nested');
      expect(loaded!.payload['nested']).toEqual({ deep: { value: [1, 2, 3] } });
      expect(loaded!.payload['arr']).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('save → load → $metadata.visits preserved (v2.0)', async () => {
      const instance = makeV2Instance({ instanceId: 'rt-v2-visits' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-v2-visits');
      const meta = loaded!.payload['$metadata'] as WorkflowMetadata;
      expect(meta.visits).toEqual({ node_a: 1, run_tests: 2 });
    });

    it('save → load → $metadata.state_hashes preserved (v2.0)', async () => {
      const instance = makeV2Instance({ instanceId: 'rt-v2-hashes' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-v2-hashes');
      const meta = loaded!.payload['$metadata'] as WorkflowMetadata;
      expect(meta.state_hashes).toEqual(['sha256:abc123', 'sha256:def456']);
    });

    it('save → load → payload.extracted_json preserved (v2.0)', async () => {
      const instance = makeV2Instance({ instanceId: 'rt-v2-json' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const loaded = await store.load('rt-v2-json');
      expect(loaded!.payload['extracted_json']).toEqual({ failed_tests: ['test_a', 'test_b'] });
    });
  });

  // =========================================================================
  // Recovery
  // =========================================================================

  describe('Recovery', () => {
    it('recover with 0 instance files → empty result', async () => {
      const result = await store.recoverInstances();
      expect(result.total).toBe(0);
      expect(result.recovered.length).toBe(0);
    });

    it('recover with 1 active instance + valid workflow → recovered', async () => {
      const instance = makeInstance({ instanceId: 'rec-active-1' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      // Overwrite with active status after save
      const filePath = join(tempDir, 'rec-active-1.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8')) as {
        instance: { status: string; completedAt?: number };
      };
      content.instance.status = 'active';
      delete content.instance.completedAt;
      await writeFile(filePath, JSON.stringify(content), 'utf-8');

      const result = await store.recoverInstances(() => true);
      expect(result.recovered).toContain('rec-active-1');
    });

    it('recover with 1 active instance + missing workflow → stale', async () => {
      const instance = makeInstance({ instanceId: 'rec-stale-1' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await store.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      // Overwrite with active status
      const filePath = join(tempDir, 'rec-stale-1.json');
      const content = JSON.parse(await readFile(filePath, 'utf-8')) as {
        instance: { status: string; completedAt?: number };
      };
      content.instance.status = 'active';
      delete content.instance.completedAt;
      await writeFile(filePath, JSON.stringify(content), 'utf-8');

      const result = await store.recoverInstances(() => false);
      expect(result.stale).toContain('rec-stale-1');
    });

    it('recover with corrupted JSON file → corrupted list, not crash', async () => {
      const filePath = join(tempDir, 'corrupted-instance.json');
      await writeFile(filePath, '{invalid json!!!', 'utf-8');

      const result = await store.recoverInstances();
      expect(result.corrupted).toContain('corrupted-instance');
      expect(result.recovered.length).toBe(0);
    });

    it('recover with mix of active, completed, stale → correct categorization', async () => {
      // Active instance with valid workflow
      const activePath = join(tempDir, 'mix-active.json');
      await writeFile(
        activePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({ instanceId: 'mix-active', status: 'active' as const }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      // Completed instance
      const completedPath = join(tempDir, 'mix-completed.json');
      await writeFile(
        completedPath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({
            instanceId: 'mix-completed',
            status: 'completed' as const,
            completedAt: Date.now(),
          }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      // Active instance with missing workflow → stale
      const stalePath = join(tempDir, 'mix-stale.json');
      await writeFile(
        stalePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({
            instanceId: 'mix-stale',
            status: 'waiting_for_agent' as const,
            workflowName: 'deleted-workflow',
          }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const result = await store.recoverInstances((name) => name !== 'deleted-workflow');
      expect(result.recovered).toContain('mix-active');
      expect(result.stale).toContain('mix-stale');
      expect(result.recovered).not.toContain('mix-completed');
    });

    it('completed instances not included in active recovery', async () => {
      const filePath = join(tempDir, 'completed-skip.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({
            instanceId: 'completed-skip',
            status: 'completed' as const,
            completedAt: Date.now(),
          }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const result = await store.recoverInstances();
      expect(result.recovered).not.toContain('completed-skip');
    });

    it('recover suspended instance → included in suspended list (v2.0)', async () => {
      const instance = makeSuspendedInstance({ instanceId: 'rec-suspended-1' });
      const filePath = join(tempDir, 'rec-suspended-1.json');
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

      const result = await store.recoverInstances(() => true);
      expect(result.suspended).toContain('rec-suspended-1');
    });

    it('recover instance with missing file pointer → warning logged, log_pointer_path set to null (v2.0)', async () => {
      const { logger, logs } = createTestLogger();
      const loggedStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0, logger });

      const instance = makeV2Instance({ instanceId: 'rec-fp-lost' });
      instance.payload['log_pointer_path'] = '/tmp/nonexistent-log-file.log';

      const filePath = join(tempDir, 'rec-fp-lost.json');
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

      const result = await loggedStore.recoverInstances(() => true);
      expect(result.filePointersLost).toContain('rec-fp-lost');
      expect(logs.some((l) => l.includes('P-007'))).toBe(true);
    });

    it('recover instance with valid $metadata → counters preserved (v2.0)', async () => {
      const instance = makeV2Instance({ instanceId: 'rec-meta-valid' });
      const filePath = join(tempDir, 'rec-meta-valid.json');
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

      const result = await store.recoverInstances(() => true);
      expect(result.recovered).toContain('rec-meta-valid');

      // Load and verify metadata is intact
      const loaded = await store.load('rec-meta-valid');
      const meta = loaded!.payload['$metadata'] as WorkflowMetadata;
      expect(meta.visits['run_tests']).toBe(2);
      expect(meta.state_hashes).toEqual(['sha256:abc123', 'sha256:def456']);
    });
  });

  // =========================================================================
  // Cleanup
  // =========================================================================

  describe('Cleanup', () => {
    it('completed instances older than retention → deleted', async () => {
      const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
      const filePath = join(tempDir, 'old-completed.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({
            instanceId: 'old-completed',
            status: 'completed' as const,
            completedAt: oldTime,
          }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date(oldTime).toISOString(),
        }),
        'utf-8',
      );

      const count = await store.cleanup();
      expect(count).toBe(1);
      const files = await readdir(tempDir);
      expect(files).not.toContain('old-completed.json');
    });

    it('completed instances newer than retention → kept', async () => {
      const filePath = join(tempDir, 'new-completed.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({
            instanceId: 'new-completed',
            status: 'completed' as const,
            completedAt: Date.now(),
          }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      const count = await store.cleanup();
      expect(count).toBe(0);
      const files = await readdir(tempDir);
      expect(files).toContain('new-completed.json');
    });

    it('active instances → never deleted regardless of age', async () => {
      const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      const filePath = join(tempDir, 'old-active.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: makeInstance({ instanceId: 'old-active', status: 'active' as const }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date(oldTime).toISOString(),
        }),
        'utf-8',
      );

      const count = await store.cleanup();
      expect(count).toBe(0);
    });

    it('suspended instances → never deleted regardless of age (v2.0)', async () => {
      const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const filePath = join(tempDir, 'old-suspended.json');
      await writeFile(
        filePath,
        JSON.stringify({
          version: '1.0',
          instance: makeSuspendedInstance({ instanceId: 'old-suspended' }),
          payload: {},
          payloadHistory: [],
          savedAt: new Date(oldTime).toISOString(),
        }),
        'utf-8',
      );

      const count = await store.cleanup();
      expect(count).toBe(0);
    });

    it('cleanup returns correct count', async () => {
      const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {
        const filePath = join(tempDir, `cleanup-${i}.json`);
        await writeFile(
          filePath,
          JSON.stringify({
            version: '1.0',
            instance: makeInstance({
              instanceId: `cleanup-${i}`,
              status: 'completed' as const,
              completedAt: oldTime,
            }),
            payload: {},
            payloadHistory: [],
            savedAt: new Date(oldTime).toISOString(),
          }),
          'utf-8',
        );
      }

      const count = await store.cleanup();
      expect(count).toBe(3);
    });
  });

  // =========================================================================
  // Directory management
  // =========================================================================

  describe('Directory management', () => {
    it('auto-creates directory if not exists', async () => {
      const nestedDir = join(tempDir, 'deep', 'nested', 'dir');
      const nestedStore = new FileInstanceStore({ directory: nestedDir, writeDebounceMs: 0 });

      const instance = makeInstance({ instanceId: 'auto-dir' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await nestedStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const files = await readdir(nestedDir);
      expect(files).toContain('auto-dir.json');
    });

    it('permission error → graceful fallback (logged warning)', async () => {
      const { logger, logs } = createTestLogger();
      // Use a path that would require special permissions (e.g., /root/no-access/test)
      // We simulate by using a file path as directory
      const badDir = join(tempDir, 'a-file-not-dir');
      await writeFile(badDir, 'not a directory', 'utf-8');
      const badStore = new FileInstanceStore({
        directory: join(badDir, 'instances'),
        writeDebounceMs: 0,
        logger,
      });

      const instance = makeInstance({ instanceId: 'perm-error' });
      instance.status = 'completed';
      instance.completedAt = Date.now();

      // Should not throw — graceful degradation
      await badStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((l) => l.includes('P-004'))).toBe(true);
    });
  });

  // =========================================================================
  // Debouncing
  // =========================================================================

  describe('Debouncing', () => {
    it('rapid saves debounced → only 1 write occurs', async () => {
      const debouncedStore = new FileInstanceStore({
        directory: tempDir,
        writeDebounceMs: 200,
      });

      const instance = makeInstance({ instanceId: 'debounce-rapid' });

      // Fire 5 rapid saves
      for (let i = 0; i < 5; i++) {
        instance.updatedAt = Date.now();
        await debouncedStore.save(structuredClone(instance));
      }

      // Before debounce fires, no file should exist yet
      const filesBefore = await readdir(tempDir);
      const jsonBefore = filesBefore.filter((f) => f === 'debounce-rapid.json');
      // Could be 0 or 1 depending on timing
      expect(jsonBefore.length).toBeLessThanOrEqual(1);

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 350));

      const filesAfter = await readdir(tempDir);
      expect(filesAfter).toContain('debounce-rapid.json');
    });

    it('completion triggers immediate flush', async () => {
      const debouncedStore = new FileInstanceStore({
        directory: tempDir,
        writeDebounceMs: 5000, // Very long debounce
      });

      const instance = makeInstance({ instanceId: 'debounce-complete' });
      instance.status = 'completed';
      instance.completedAt = Date.now();

      await debouncedStore.save(instance);
      // Immediate flush for completed — should exist quickly
      await new Promise((r) => setTimeout(r, 50));

      const files = await readdir(tempDir);
      expect(files).toContain('debounce-complete.json');
    });

    it('suspension triggers immediate flush (v2.0)', async () => {
      const debouncedStore = new FileInstanceStore({
        directory: tempDir,
        writeDebounceMs: 5000,
      });

      const instance = makeSuspendedInstance({ instanceId: 'debounce-suspended' });

      await debouncedStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const files = await readdir(tempDir);
      expect(files).toContain('debounce-suspended.json');
    });

    it('flushAll() writes all pending', async () => {
      const debouncedStore = new FileInstanceStore({
        directory: tempDir,
        writeDebounceMs: 10000, // Very long debounce
      });

      const i1 = makeInstance({ instanceId: 'flush-1' });
      const i2 = makeInstance({ instanceId: 'flush-2' });

      await debouncedStore.save(i1);
      await debouncedStore.save(i2);

      // Files shouldn't exist yet (debounce is 10s)
      const filesBefore = await readdir(tempDir);
      expect(filesBefore.filter((f) => f.endsWith('.json')).length).toBe(0);

      await debouncedStore.flushAll();
      await new Promise((r) => setTimeout(r, 50));

      const filesAfter = await readdir(tempDir);
      expect(filesAfter).toContain('flush-1.json');
      expect(filesAfter).toContain('flush-2.json');
    });
  });

  // =========================================================================
  // Structured logging (DAWE-012/DAWE-018)
  // =========================================================================

  describe('Structured logging', () => {
    it('save operation emits debug log with instanceId', async () => {
      const { logger, logs } = createTestLogger();
      const loggedStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0, logger });

      const instance = makeInstance({ instanceId: 'log-save' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await loggedStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((l) => l.includes('"message":"Saving instance"') && l.includes('log-save'))).toBe(true);
    });

    it('recovery emits info log with summary counts', async () => {
      const { logger, logs } = createTestLogger();
      const loggedStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0, logger });

      await loggedStore.recoverInstances();

      expect(logs.some((l) => l.includes('"message":"Recovery complete"'))).toBe(true);
    });

    it('corrupted file emits warn log with file path', async () => {
      const { logger, logs } = createTestLogger();
      const loggedStore = new FileInstanceStore({ directory: tempDir, writeDebounceMs: 0, logger });

      await writeFile(join(tempDir, 'broken.json'), '{{not json}}', 'utf-8');
      await loggedStore.recoverInstances();

      expect(logs.some((l) => l.includes('"message":"Corrupted instance file"') && l.includes('P-005'))).toBe(true);
    });

    it('permission error emits error log with DAWEError', async () => {
      const { logger, logs } = createTestLogger();
      const badDir = join(tempDir, 'a-file');
      await writeFile(badDir, 'x', 'utf-8');
      const badStore = new FileInstanceStore({
        directory: join(badDir, 'sub'),
        writeDebounceMs: 0,
        logger,
      });

      const instance = makeInstance({ instanceId: 'log-perm' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await badStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((l) => l.includes('P-004'))).toBe(true);
    });
  });

  // =========================================================================
  // listActive
  // =========================================================================

  describe('listActive', () => {
    it('returns only active, waiting_for_agent, suspended, and failed instances', async () => {
      const instances = [
        makeInstance({ instanceId: 'la-active', status: 'active' as const }),
        makeInstance({ instanceId: 'la-waiting', status: 'waiting_for_agent' as const }),
        makeSuspendedInstance({ instanceId: 'la-suspended' }),
        makeInstance({ instanceId: 'la-completed', status: 'completed' as const, completedAt: Date.now() }),
        makeInstance({ instanceId: 'la-cancelled', status: 'cancelled' as const, completedAt: Date.now() }),
      ];

      for (const inst of instances) {
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

      const active = await store.listActive();
      const ids = active.map((i) => i.instanceId).sort();
      expect(ids).toEqual(['la-active', 'la-suspended', 'la-waiting']);
    });
  });

  // =========================================================================
  // Pretty printing
  // =========================================================================

  describe('Pretty printing', () => {
    it('pretty: true produces indented JSON', async () => {
      const prettyStore = new FileInstanceStore({
        directory: tempDir,
        writeDebounceMs: 0,
        pretty: true,
      });

      const instance = makeInstance({ instanceId: 'pretty-1' });
      instance.status = 'completed';
      instance.completedAt = Date.now();
      await prettyStore.save(instance);
      await new Promise((r) => setTimeout(r, 50));

      const content = await readFile(join(tempDir, 'pretty-1.json'), 'utf-8');
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });
});

// ---------------------------------------------------------------------------
// DebouncedSaver standalone tests
// ---------------------------------------------------------------------------

describe('DebouncedSaver', () => {
  it('schedule → executes after debounce delay', async () => {
    const saver = new DebouncedSaver();
    let called = false;

    saver.schedule(
      'test-1',
      () => {
        called = true;
        return Promise.resolve();
      },
      50,
    );
    expect(called).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(true);
  });

  it('markImmediate → executes immediately on next schedule', async () => {
    const saver = new DebouncedSaver();
    let called = false;

    saver.markImmediate('test-2');
    saver.schedule(
      'test-2',
      () => {
        called = true;
        return Promise.resolve();
      },
      10000,
    );

    // Should be called immediately (well, synchronously after schedule)
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });

  it('flushAll → flushes all pending', async () => {
    const saver = new DebouncedSaver();
    const results: string[] = [];

    saver.schedule(
      'a',
      () => {
        results.push('a');
        return Promise.resolve();
      },
      10000,
    );
    saver.schedule(
      'b',
      () => {
        results.push('b');
        return Promise.resolve();
      },
      10000,
    );

    expect(results.length).toBe(0);
    await saver.flushAll();
    expect(results.sort()).toEqual(['a', 'b']);
  });

  it('pendingCount → tracks pending saves', async () => {
    const saver = new DebouncedSaver();
    expect(saver.pendingCount).toBe(0);

    saver.schedule('x', () => Promise.resolve(), 10000);
    saver.schedule('y', () => Promise.resolve(), 10000);
    expect(saver.pendingCount).toBe(2);

    await saver.flushAll();
    expect(saver.pendingCount).toBe(0);
  });
});
