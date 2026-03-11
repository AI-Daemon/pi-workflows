/**
 * PayloadManager — structured, immutable-by-default state container
 * for accumulating context across workflow node transitions.
 *
 * Key responsibilities:
 * 1. **Hydration** — Merging node outputs into the payload safely.
 * 2. **Templating** — Resolving Handlebars templates against payload state.
 * 3. **Scoping** — Providing only relevant payload subsets via `context_keys`.
 * 4. **Serialization** — Persisting payload state for crash recovery.
 *
 * All reads return deep clones. The only way to mutate state is `merge()`.
 */

import type { z } from 'zod';
import type { Result } from '../utils/result.js';
import type { PayloadHistoryEntry } from './payload-history.js';
import { resolveTemplate, type TemplateError } from './template-engine.js';
import { DAWELogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard: is the value a plain object (not null, not an array)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive deep merge.
 *
 * - Plain objects are merged recursively.
 * - Arrays are **replaced** (atomic).
 * - `undefined` values are skipped.
 * - `null` values explicitly set the key to `null`.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    if (sourceVal === undefined) continue; // skip undefined

    const targetVal = target[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      target[key] = deepMerge({ ...targetVal }, sourceVal);
    } else {
      target[key] = structuredClone(sourceVal);
    }
  }
  return target;
}

/**
 * Get a nested value from an object using dot-notation.
 * Returns `undefined` if any segment is missing.
 */
function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const segments = dotPath.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }

  return current;
}

/**
 * Set a nested value on an object using dot-notation, creating intermediate
 * objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  const lastSegment = segments[segments.length - 1]!;
  current[lastSegment] = value;
}

/**
 * Collect all top-level and nested keys modified in a source object,
 * expressed as dot-paths.
 */
function collectModifiedKeys(source: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(source)) {
    if (source[key] === undefined) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Validation error type
// ---------------------------------------------------------------------------

/** Structured error from payload validation. */
export interface PayloadValidationError {
  /** Dot-path of the offending key. */
  path: string;
  /** Human-readable description. */
  message: string;
}

// ---------------------------------------------------------------------------
// Serialization shape
// ---------------------------------------------------------------------------

/** JSON shape produced by `serialize()`. */
interface SerializedPayload {
  version: 1;
  payload: Record<string, unknown>;
  history: PayloadHistoryEntry[];
}

// ---------------------------------------------------------------------------
// PayloadManager
// ---------------------------------------------------------------------------

/** Default maximum history entries retained. */
const DEFAULT_MAX_HISTORY = 100;
/** Default maximum serialized payload size in bytes (1 MB). */
const DEFAULT_MAX_SIZE_BYTES = 1_048_576;

export class PayloadManager {
  private payload: Record<string, unknown>;
  private history: PayloadHistoryEntry[];
  private maxHistoryEntries: number;
  private maxSizeBytes: number;
  private readonly logger: DAWELogger;

  constructor(initialPayload?: Record<string, unknown>, options?: { logger?: DAWELogger }) {
    this.payload = initialPayload ? structuredClone(initialPayload) : {};
    this.history = [];
    this.maxHistoryEntries = DEFAULT_MAX_HISTORY;
    this.maxSizeBytes = DEFAULT_MAX_SIZE_BYTES;
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /** Set the maximum number of history entries to retain. */
  setMaxHistoryEntries(max: number): void {
    this.maxHistoryEntries = max;
  }

  /** Set the maximum serialized payload size in bytes. */
  setMaxSizeBytes(max: number): void {
    this.maxSizeBytes = max;
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /** Get the full current payload (read-only deep clone). */
  getPayload(): Readonly<Record<string, unknown>> {
    return structuredClone(this.payload);
  }

  /**
   * Merge new data into the payload.
   *
   * - Shallow merge for top-level primitives.
   * - Deep merge for nested plain objects.
   * - Arrays are replaced (atomic).
   * - `null` sets the key to `null`.
   * - `undefined` values are stripped (ignored).
   *
   * @param nodeId - The ID of the node producing this data (provenance).
   * @param data   - Key-value pairs to merge.
   */
  merge(nodeId: string, data: Record<string, unknown>): void {
    // Capture the keys being modified (top-level only for the history entry)
    const keysModified = collectModifiedKeys(data);

    // Clone the incoming data so caller mutations don't affect us
    const clonedData = structuredClone(data);

    // Strip undefined values from cloned data
    for (const key of Object.keys(clonedData)) {
      if (clonedData[key] === undefined) {
        delete clonedData[key];
      }
    }

    // Protect $metadata as a reserved key — prevent user payloads from overwriting it
    if ('$metadata' in clonedData) {
      this.logger.debug('Blocked $metadata overwrite attempt', { nodeId, code: 'P-001' });
      delete clonedData['$metadata'];
    }

    // Apply the deep merge
    this.payload = deepMerge({ ...this.payload }, clonedData);
    this.logger.debug('Payload merged', { nodeId, keysModified });

    // Record history
    const entry: PayloadHistoryEntry = {
      nodeId,
      timestamp: Date.now(),
      keysModified,
      snapshot: structuredClone(this.payload),
    };
    this.history.push(entry);

    // Trim history if necessary
    if (this.history.length > this.maxHistoryEntries) {
      this.history = this.history.slice(this.history.length - this.maxHistoryEntries);
    }
  }

  /**
   * Get a scoped view of the payload containing only the specified keys.
   * Supports dot-notation for nested keys (e.g. `"user.role"`).
   * Missing keys are omitted.
   *
   * @param keys - Array of dot-path keys to include.
   * @returns Deep clone of the scoped payload subset.
   */
  getScoped(keys: string[]): Record<string, unknown> {
    const scoped: Record<string, unknown> = {};
    for (const key of keys) {
      const value = getNestedValue(this.payload, key);
      if (value !== undefined) {
        setNestedValue(scoped, key, structuredClone(value));
      }
    }
    return scoped;
  }

  /**
   * Resolve a Handlebars template string against the current payload.
   *
   * The template receives `{ payload: <currentPayload> }` as context,
   * so references look like `{{payload.some_key}}`.
   *
   * @param template - Handlebars template string.
   * @returns Result with the resolved string or a `TemplateError`.
   */
  resolveTemplate(template: string): Result<string, TemplateError> {
    const result = resolveTemplate(template, { payload: this.payload });
    if (!result.ok) {
      this.logger.error('Template resolution failed', undefined, {
        code: 'P-002',
        template: template.substring(0, 200),
      });
    }
    return result;
  }

  /**
   * Get the full history of merge operations (deep cloned).
   * Useful for debugging and audit trails.
   */
  getHistory(): PayloadHistoryEntry[] {
    return structuredClone(this.history);
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /**
   * Serialize the payload and history to a JSON string.
   * Used for persisting workflow instance state.
   */
  serialize(): string {
    const data: SerializedPayload = {
      version: 1,
      payload: this.payload,
      history: this.history,
    };
    return JSON.stringify(data);
  }

  /**
   * Restore a PayloadManager from a serialized JSON string.
   *
   * @param json - Output of a previous `serialize()` call.
   * @returns A fully functional PayloadManager instance.
   * @throws Error if the JSON is invalid or has an unexpected shape.
   */
  static deserialize(json: string): PayloadManager {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to deserialize PayloadManager: invalid JSON — ${message}`);
    }

    if (!isPlainObject(parsed)) {
      throw new Error('Failed to deserialize PayloadManager: expected a JSON object');
    }

    // After isPlainObject guard, `parsed` is narrowed to Record<string, unknown>
    const obj = parsed;

    if (obj['version'] !== 1) {
      throw new Error(`Failed to deserialize PayloadManager: unsupported version "${String(obj['version'])}"`);
    }

    if (!isPlainObject(obj['payload'])) {
      throw new Error('Failed to deserialize PayloadManager: missing or invalid "payload" field');
    }

    if (!Array.isArray(obj['history'])) {
      throw new Error('Failed to deserialize PayloadManager: missing or invalid "history" field');
    }

    // After isPlainObject guard, obj['payload'] is Record<string, unknown>
    const manager = new PayloadManager(obj['payload']);
    manager.history = structuredClone(obj['history']) as PayloadHistoryEntry[];
    return manager;
  }

  /** Reset the payload and history to empty state. */
  reset(): void {
    this.payload = {};
    this.history = [];
  }

  // -----------------------------------------------------------------------
  // P1 — Should Have
  // -----------------------------------------------------------------------

  /**
   * Validate the current payload against a Zod schema.
   *
   * @param schema - A Zod schema to validate against.
   * @returns `Result` with void on success, or an array of `ValidationError`s.
   */
  validatePayload(schema: z.ZodType): Result<void, PayloadValidationError[]> {
    const result = schema.safeParse(this.payload);
    if (result.success) {
      return { ok: true, data: undefined };
    }

    const errors: PayloadValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    return { ok: false, errors };
  }

  /**
   * Compute a diff of all keys changed in the most recent merge.
   * Returns a map of dot-paths to `{ before, after }` for each changed key.
   *
   * @returns The diff, or an empty object if there are fewer than 1 merge.
   */
  diffFromLastMerge(): Record<string, { before: unknown; after: unknown }> {
    if (this.history.length === 0) return {};

    const lastEntry = this.history[this.history.length - 1]!;
    const previousSnapshot: Record<string, unknown> =
      this.history.length >= 2 ? this.history[this.history.length - 2]!.snapshot : {};

    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of lastEntry.keysModified) {
      const before = getNestedValue(previousSnapshot, key);
      const after = getNestedValue(lastEntry.snapshot, key);
      diff[key] = {
        before: before !== undefined ? structuredClone(before) : undefined,
        after: after !== undefined ? structuredClone(after) : undefined,
      };
    }

    return diff;
  }

  /**
   * Check if the serialized payload exceeds the configured size limit.
   *
   * @returns `true` if within limits, `false` if the payload is too large.
   */
  isWithinSizeLimit(): boolean {
    const serialized = this.serialize();
    return Buffer.byteLength(serialized, 'utf-8') <= this.maxSizeBytes;
  }
}
