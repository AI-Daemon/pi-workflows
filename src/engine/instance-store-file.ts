/**
 * FileInstanceStore — Durable file-based persistence for workflow instances.
 *
 * Stores each `WorkflowInstance` as a single JSON file with atomic writes
 * (write to temp, then rename). Includes write debouncing for performance
 * during rapid state changes, and recovery logic for resuming interrupted
 * workflows after process/container restarts.
 *
 * File format:
 * ```json
 * {
 *   "version": "1.0",
 *   "instance": { ... WorkflowInstance ... },
 *   "payload": { ... full payload with $metadata ... },
 *   "payloadHistory": [ ... PayloadHistoryEntry[] ... ],
 *   "savedAt": "2026-03-11T05:00:00.000Z"
 * }
 * ```
 *
 * Default directory: `~/.pi/workflows/instances/`
 */

import { readdir, readFile, rename, unlink, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import type { WorkflowInstance } from './advance-result.js';
import type { InstanceStore } from './instance-store.js';
import type { PayloadHistoryEntry } from './payload-history.js';
import { DAWELogger } from '../utils/logger.js';
import { DAWEError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration options for FileInstanceStore. */
export interface FileStoreOptions {
  /** Base directory for instance files. Default: `~/.pi/workflows/instances/` */
  directory?: string;
  /** How long to keep completed instances in ms (default: 7 days). */
  retentionMs?: number;
  /** Debounce writes in ms (default: 500ms). */
  writeDebounceMs?: number;
  /** Pretty-print JSON (default: false). */
  pretty?: boolean;
  /** Structured logger (default: warn-level logger). */
  logger?: DAWELogger;
}

/** Shape of the persisted JSON file. */
export interface PersistedInstance {
  /** File format version. */
  version: string;
  /** The workflow instance state. */
  instance: WorkflowInstance;
  /** Full payload including $metadata. */
  payload: Record<string, unknown>;
  /** Payload merge history. */
  payloadHistory: PayloadHistoryEntry[];
  /** ISO 8601 timestamp when the file was last saved. */
  savedAt: string;
}

/** Result of recovering instances from disk. */
export interface RecoveryResult {
  /** Instance IDs successfully recovered. */
  recovered: string[];
  /** Instances whose workflow definition no longer exists. */
  stale: string[];
  /** Files that couldn't be parsed. */
  corrupted: string[];
  /** v2.0: Instances in SUSPENDED state awaiting human review. */
  suspended: string[];
  /** v2.0: Instances where log pointer files were lost. */
  filePointersLost: string[];
  /** Total instance files found. */
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DIRECTORY = join(homedir(), '.pi', 'workflows', 'instances');
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_WRITE_DEBOUNCE_MS = 500;
const FILE_FORMAT_VERSION = '1.0';

// ---------------------------------------------------------------------------
// DebouncedSaver
// ---------------------------------------------------------------------------

/**
 * Manages debounced saves to avoid excessive I/O during rapid state changes.
 * Supports immediate flush for terminal states (completion, cancellation, suspension).
 */
export class DebouncedSaver {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly immediate = new Set<string>();
  private readonly pendingFns = new Map<string, () => Promise<void>>();

  /**
   * Schedule a save for the given instance ID.
   * If an immediate flush is marked, executes the save synchronously.
   * Otherwise debounces by the given interval.
   */
  schedule(instanceId: string, saveFn: () => Promise<void>, debounceMs: number): void {
    const existing = this.pending.get(instanceId);
    if (existing) clearTimeout(existing);

    if (this.immediate.has(instanceId)) {
      void saveFn();
      this.immediate.delete(instanceId);
      this.pendingFns.delete(instanceId);
      return;
    }

    this.pendingFns.set(instanceId, saveFn);
    this.pending.set(
      instanceId,
      setTimeout(() => {
        this.pending.delete(instanceId);
        const fn = this.pendingFns.get(instanceId);
        this.pendingFns.delete(instanceId);
        if (fn) fn().catch(() => {}); // Swallow errors — already logged at call site
      }, debounceMs),
    );
  }

  /** Mark an instance for immediate flush on the next schedule() call. */
  markImmediate(instanceId: string): void {
    this.immediate.add(instanceId);
  }

  /** Flush all pending saves immediately. */
  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [instanceId, timer] of this.pending) {
      clearTimeout(timer);
      this.pending.delete(instanceId);
      const fn = this.pendingFns.get(instanceId);
      this.pendingFns.delete(instanceId);
      if (fn) promises.push(fn());
    }
    await Promise.all(promises);
  }

  /** Get the number of pending saves. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, data, 'utf-8');
    await rename(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// FileInstanceStore
// ---------------------------------------------------------------------------

export class FileInstanceStore implements InstanceStore {
  readonly directory: string;
  private readonly retentionMs: number;
  private readonly writeDebounceMs: number;
  private readonly pretty: boolean;
  private readonly logger: DAWELogger;
  private readonly debouncer: DebouncedSaver;
  private directoryAccessible: boolean = true;

  constructor(options?: FileStoreOptions) {
    this.directory = options?.directory ?? DEFAULT_DIRECTORY;
    this.retentionMs = options?.retentionMs ?? DEFAULT_RETENTION_MS;
    this.writeDebounceMs = options?.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.pretty = options?.pretty ?? false;
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });
    this.debouncer = new DebouncedSaver();
  }

  // -----------------------------------------------------------------------
  // InstanceStore interface
  // -----------------------------------------------------------------------

  async save(instance: WorkflowInstance): Promise<void> {
    if (!this.directoryAccessible) {
      return; // Graceful degradation — directory was inaccessible
    }

    await this.ensureDirectory();

    const isTerminal =
      instance.status === 'completed' ||
      instance.status === 'cancelled' ||
      instance.status === 'failed' ||
      instance.status === 'suspended';

    if (isTerminal) {
      this.debouncer.markImmediate(instance.instanceId);
    }

    const saveFn = async (): Promise<void> => {
      if (!this.directoryAccessible) return;

      const filePath = this.instancePath(instance.instanceId);
      const data = this.serialize(instance);

      this.logger.debug('Saving instance', {
        instanceId: instance.instanceId,
        status: instance.status,
        component: 'persistence',
      });

      try {
        await atomicWrite(filePath, data);
        this.logger.debug('Instance saved', {
          instanceId: instance.instanceId,
          component: 'persistence',
        });
      } catch (err) {
        this.logger.error(
          'Failed to save instance',
          new DAWEError('P-003', 'Instance file write failed', {
            context: { instanceId: instance.instanceId, filePath },
            ...(err instanceof Error ? { cause: err } : {}),
          }),
        );
      }
    };

    if (isTerminal) {
      // Immediate save for terminal states
      this.debouncer.schedule(instance.instanceId, saveFn, this.writeDebounceMs);
    } else {
      // Debounced save for active states
      this.debouncer.schedule(instance.instanceId, saveFn, this.writeDebounceMs);
    }
  }

  async load(instanceId: string): Promise<WorkflowInstance | null> {
    const filePath = this.instancePath(instanceId);
    try {
      const content = await readFile(filePath, 'utf-8');
      const persisted = this.deserialize(content);
      this.logger.debug('Instance loaded', {
        instanceId,
        component: 'persistence',
      });
      return persisted.instance;
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null;
      }
      this.logger.warn('Failed to load instance', {
        instanceId,
        component: 'persistence',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async list(): Promise<WorkflowInstance[]> {
    const files = await this.listFiles();
    const instances: WorkflowInstance[] = [];

    for (const file of files) {
      const filePath = join(this.directory, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        const persisted = this.deserialize(content);
        instances.push(persisted.instance);
      } catch {
        // Skip corrupted files
      }
    }

    return instances;
  }

  async delete(instanceId: string): Promise<void> {
    const filePath = this.instancePath(instanceId);
    try {
      await unlink(filePath);
      this.logger.info('Instance deleted', {
        instanceId,
        component: 'persistence',
      });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return; // Already deleted — not an error
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Extended API
  // -----------------------------------------------------------------------

  /**
   * List only active (non-completed/cancelled) instances.
   * v2.0: Also includes 'suspended' instances — they need human review.
   */
  async listActive(): Promise<WorkflowInstance[]> {
    const all = await this.list();
    return all.filter(
      (i) =>
        i.status === 'active' || i.status === 'waiting_for_agent' || i.status === 'suspended' || i.status === 'failed',
    );
  }

  /**
   * Clean up completed instances older than retention period.
   * v2.0: Suspended instances are NEVER auto-deleted.
   * Active/failed instances are NEVER auto-deleted.
   *
   * @returns Count of deleted instances.
   */
  async cleanup(retentionMs?: number): Promise<number> {
    const retention = retentionMs ?? this.retentionMs;
    const cutoff = Date.now() - retention;
    const files = await this.listFiles();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = join(this.directory, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        const persisted = this.deserialize(content);
        const instance = persisted.instance;

        // Only delete completed/cancelled instances past retention
        if (
          (instance.status === 'completed' || instance.status === 'cancelled') &&
          instance.completedAt !== undefined &&
          instance.completedAt < cutoff
        ) {
          await unlink(filePath);
          deletedCount++;
        }
      } catch {
        // Skip corrupted files during cleanup
      }
    }

    this.logger.info('Cleanup completed', {
      deletedCount,
      retentionMs: retention,
      component: 'persistence',
    });

    return deletedCount;
  }

  /**
   * Recover instances from disk after a restart.
   *
   * For each persisted instance:
   * - Validates JSON integrity
   * - Checks if the workflow definition still exists (via the provided resolver)
   * - Validates $metadata integrity for v2.0
   * - Checks file pointer validity for v2.0
   *
   * @param workflowExists - Function that checks if a workflow name is still registered.
   */
  async recoverInstances(workflowExists?: (workflowName: string) => boolean): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      recovered: [],
      stale: [],
      corrupted: [],
      suspended: [],
      filePointersLost: [],
      total: 0,
    };

    this.logger.info('Starting instance recovery', {
      directory: this.directory,
      component: 'recovery',
    });

    const files = await this.listFiles();
    result.total = files.length;

    for (const file of files) {
      const filePath = join(this.directory, file);
      const instanceId = file.replace(/\.json$/, '');

      try {
        const content = await readFile(filePath, 'utf-8');
        let persisted: PersistedInstance;

        try {
          persisted = this.deserialize(content);
        } catch {
          result.corrupted.push(instanceId);
          this.logger.warn('Corrupted instance file', {
            instanceId,
            filePath,
            component: 'recovery',
            code: 'P-005',
          });
          continue;
        }

        const instance = persisted.instance;

        // Skip completed/cancelled instances — they don't need recovery
        if (instance.status === 'completed' || instance.status === 'cancelled') {
          continue;
        }

        // Check if workflow still exists
        if (workflowExists && !workflowExists(instance.workflowName)) {
          result.stale.push(instance.instanceId);
          this.logger.warn('Stale instance — workflow not found', {
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
            component: 'recovery',
            code: 'P-006',
          });
          continue;
        }

        // Validate $metadata integrity for v2.0
        this.validateMetadata(instance);

        // Check file pointer validity
        const logPointerPath = instance.payload['log_pointer_path'];
        if (typeof logPointerPath === 'string' && logPointerPath.length > 0) {
          if (!existsSync(logPointerPath)) {
            instance.payload['log_pointer_path'] = null;
            result.filePointersLost.push(instance.instanceId);
            this.logger.warn('File pointer lost — log file not found', {
              instanceId: instance.instanceId,
              logPointerPath,
              component: 'recovery',
              code: 'P-007',
            });
          }
        }

        // Categorize by status
        if (instance.status === 'suspended') {
          result.suspended.push(instance.instanceId);
          this.logger.info('Recovered suspended instance', {
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
            component: 'recovery',
          });
        } else {
          result.recovered.push(instance.instanceId);
          this.logger.info('Recovered instance', {
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
            status: instance.status,
            component: 'recovery',
          });
        }
      } catch (err) {
        result.corrupted.push(instanceId);
        this.logger.warn('Failed to process instance file during recovery', {
          instanceId,
          filePath,
          component: 'recovery',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('Recovery complete', {
      recovered: result.recovered.length,
      stale: result.stale.length,
      corrupted: result.corrupted.length,
      suspended: result.suspended.length,
      filePointersLost: result.filePointersLost.length,
      total: result.total,
      component: 'recovery',
    });

    return result;
  }

  /**
   * Flush all pending debounced writes immediately.
   * Called on process shutdown.
   */
  async flushAll(): Promise<void> {
    await this.debouncer.flushAll();
    this.logger.debug('All pending saves flushed', {
      component: 'persistence',
    });
  }

  /**
   * Load the raw persisted data for an instance (includes payload history).
   */
  async loadPersisted(instanceId: string): Promise<PersistedInstance | null> {
    const filePath = this.instancePath(instanceId);
    try {
      const content = await readFile(filePath, 'utf-8');
      return this.deserialize(content);
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private instancePath(instanceId: string): string {
    return join(this.directory, `${instanceId}.json`);
  }

  private serialize(instance: WorkflowInstance): string {
    const persisted: PersistedInstance = {
      version: FILE_FORMAT_VERSION,
      instance: structuredClone(instance),
      payload: structuredClone(instance.payload),
      payloadHistory: structuredClone(instance.history).map((h) => ({
        nodeId: h.nodeId,
        timestamp: h.enteredAt,
        keysModified: Object.keys(h.payloadSnapshot),
        snapshot: h.payloadSnapshot,
      })),
      savedAt: new Date().toISOString(),
    };

    return this.pretty ? JSON.stringify(persisted, null, 2) : JSON.stringify(persisted);
  }

  private deserialize(content: string): PersistedInstance {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new DAWEError('P-005', 'Instance file corrupted — invalid JSON', {
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }

    if (!isPlainObject(parsed)) {
      throw new DAWEError('P-005', 'Instance file corrupted — expected JSON object');
    }

    if (!isPlainObject(parsed['instance'])) {
      throw new DAWEError('P-005', 'Instance file corrupted — missing "instance" field');
    }

    return parsed as unknown as PersistedInstance;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
    } catch (err) {
      this.directoryAccessible = false;
      this.logger.error(
        'Instance directory inaccessible',
        new DAWEError('P-004', 'Instance directory inaccessible', {
          context: { directory: this.directory },
          ...(err instanceof Error ? { cause: err } : {}),
        }),
      );
    }
  }

  private async listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory);
      return entries.filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  /**
   * Validate $metadata integrity on a recovered instance.
   * Repairs invalid counters without crashing.
   */
  private validateMetadata(instance: WorkflowInstance): void {
    const $metadata = instance.payload['$metadata'];
    if (!isPlainObject($metadata)) {
      return; // v1.0 workflow — no $metadata
    }

    // Validate visits — ensure all values are non-negative integers
    const visits = $metadata['visits'];
    if (isPlainObject(visits)) {
      for (const [key, value] of Object.entries(visits)) {
        if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
          visits[key] = 0;
        }
      }
    }

    // Validate state_hashes — ensure it's a valid array of strings
    const stateHashes = $metadata['state_hashes'];
    if (!Array.isArray(stateHashes)) {
      $metadata['state_hashes'] = [];
    } else {
      // Filter out non-string entries
      $metadata['state_hashes'] = stateHashes.filter((h: unknown) => typeof h === 'string');
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err;
}
