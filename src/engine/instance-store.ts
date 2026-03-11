/**
 * Instance persistence layer for the Workflow Runtime Engine.
 *
 * Defines the `InstanceStore` interface for pluggable persistence
 * and provides an `InMemoryInstanceStore` default implementation.
 */

import type { WorkflowInstance } from './advance-result.js';

// ---------------------------------------------------------------------------
// InstanceStore interface
// ---------------------------------------------------------------------------

/** Pluggable persistence interface for workflow instances. */
export interface InstanceStore {
  /** Save (create or update) a workflow instance. */
  save(instance: WorkflowInstance): Promise<void>;
  /** Load a workflow instance by ID. Returns null if not found. */
  load(instanceId: string): Promise<WorkflowInstance | null>;
  /** List all stored workflow instances. */
  list(): Promise<WorkflowInstance[]>;
  /** Delete a workflow instance by ID. */
  delete(instanceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryInstanceStore
// ---------------------------------------------------------------------------

/** In-memory implementation of InstanceStore. Suitable for testing and development. */
export class InMemoryInstanceStore implements InstanceStore {
  private readonly instances = new Map<string, WorkflowInstance>();

  save(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.instanceId, structuredClone(instance));
    return Promise.resolve();
  }

  load(instanceId: string): Promise<WorkflowInstance | null> {
    const instance = this.instances.get(instanceId);
    return Promise.resolve(instance ? structuredClone(instance) : null);
  }

  list(): Promise<WorkflowInstance[]> {
    return Promise.resolve([...this.instances.values()].map((i) => structuredClone(i)));
  }

  delete(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    return Promise.resolve();
  }
}
