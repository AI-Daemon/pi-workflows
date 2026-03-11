/**
 * Unit tests for WorkflowRegistry — YAML scanning, loading, caching.
 *
 * Minimum 10 test cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { WorkflowRegistry } from '../../../src/extension/workflow-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve('tests/fixtures/workflows');
const TEMP_DIR = resolve('tests/fixtures/temp-registry');

function createTempDir(): void {
  mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanTempDir(): void {
  try {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function writeTempWorkflow(name: string, content: string): void {
  writeFileSync(resolve(TEMP_DIR, name), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRegistry', () => {
  beforeEach(() => {
    cleanTempDir();
  });

  // 1. Load from directory with valid YAML files → all loaded
  it('should load all valid YAML files from a directory', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    const workflows = registry.list();
    expect(workflows.length).toBeGreaterThanOrEqual(3);

    const names = workflows.map((w) => w.name);
    expect(names).toContain('simple-linear');
    expect(names).toContain('branching-workflow');
    expect(names).toContain('system-action-chain');
  });

  // 2. Load from directory with invalid YAML → valid ones loaded, invalid logged as warning
  it('should load valid workflows and warn about invalid ones', async () => {
    createTempDir();

    // Write a valid workflow
    writeTempWorkflow(
      'valid.yml',
      `
version: '1.0'
workflow_name: valid-test
description: A valid test workflow
initial_node: start
nodes:
  start:
    type: llm_task
    instruction: Do something
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: end
  end:
    type: terminal
    status: success
`,
    );

    // Write an invalid workflow
    writeTempWorkflow(
      'invalid.yml',
      `
version: '2.0'
workflow_name: invalid
`,
    );

    const registry = new WorkflowRegistry([TEMP_DIR]);
    await registry.loadAll();

    const workflows = registry.list();
    expect(workflows.length).toBe(1);
    expect(workflows[0]!.name).toBe('valid-test');

    const warnings = registry.getWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('invalid.yml'))).toBe(true);

    cleanTempDir();
  });

  // 3. Load from empty directory → empty registry
  it('should return empty list for empty directory', async () => {
    createTempDir();

    const registry = new WorkflowRegistry([TEMP_DIR]);
    await registry.loadAll();

    expect(registry.list()).toEqual([]);

    cleanTempDir();
  });

  // 4. Load from nonexistent directory → warning, empty registry
  it('should warn and return empty for nonexistent directory', async () => {
    const registry = new WorkflowRegistry(['/nonexistent/path/123456']);
    await registry.loadAll();

    expect(registry.list()).toEqual([]);
    const warnings = registry.getWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('not found or unreadable');
  });

  // 5. Get workflow by name → returns definition
  it('should get a workflow by name', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    const def = registry.get('simple-linear');
    expect(def).toBeDefined();
    expect(def!.workflow_name).toBe('simple-linear');
    expect(def!.initial_node).toBe('ask');
  });

  // 6. Get nonexistent workflow → returns undefined
  it('should return undefined for nonexistent workflow', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    const def = registry.get('does-not-exist');
    expect(def).toBeUndefined();
  });

  // 7. List workflows → returns names and descriptions
  it('should list workflow names and descriptions', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    const workflows = registry.list();

    for (const w of workflows) {
      expect(w.name).toBeTruthy();
      expect(w.description).toBeTruthy();
    }
  });

  // 8. Reload workflow → updated definition loaded
  it('should reload a workflow with updated content', async () => {
    createTempDir();

    writeTempWorkflow(
      'reloadable.yml',
      `
version: '1.0'
workflow_name: reloadable
description: Original description
initial_node: start
nodes:
  start:
    type: llm_task
    instruction: Do something
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: end
  end:
    type: terminal
    status: success
`,
    );

    const registry = new WorkflowRegistry([TEMP_DIR]);
    await registry.loadAll();

    expect(registry.get('reloadable')!.description).toBe('Original description');

    // Update the file
    writeTempWorkflow(
      'reloadable.yml',
      `
version: '1.0'
workflow_name: reloadable
description: Updated description
initial_node: start
nodes:
  start:
    type: llm_task
    instruction: Do something
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: end
  end:
    type: terminal
    status: success
`,
    );

    await registry.reload('reloadable');

    expect(registry.get('reloadable')!.description).toBe('Updated description');

    cleanTempDir();
  });

  // 9. Multiple directories scanned → workflows from all dirs available
  it('should load workflows from multiple directories', async () => {
    createTempDir();

    writeTempWorkflow(
      'extra.yml',
      `
version: '1.0'
workflow_name: extra-workflow
description: An extra workflow
initial_node: start
nodes:
  start:
    type: llm_task
    instruction: Do something
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: end
  end:
    type: terminal
    status: success
`,
    );

    const registry = new WorkflowRegistry([FIXTURES_DIR, TEMP_DIR]);
    await registry.loadAll();

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('simple-linear'); // from fixtures
    expect(names).toContain('extra-workflow'); // from temp

    cleanTempDir();
  });

  // 10. Duplicate workflow names across dirs → last loaded wins (with warning)
  it('should overwrite duplicate names with last loaded and warn', async () => {
    createTempDir();

    writeTempWorkflow(
      'simple-linear.yml',
      `
version: '1.0'
workflow_name: simple-linear
description: Overriding simple-linear
initial_node: start
nodes:
  start:
    type: llm_task
    instruction: Overridden
    completion_schema:
      result: string
    transitions:
      - condition: 'true'
        target: end
  end:
    type: terminal
    status: success
`,
    );

    const registry = new WorkflowRegistry([FIXTURES_DIR, TEMP_DIR]);
    await registry.loadAll();

    // Should have the overridden version
    const def = registry.get('simple-linear');
    expect(def!.description).toBe('Overriding simple-linear');

    const warnings = registry.getWarnings();
    expect(warnings.some((w) => w.includes('Duplicate workflow name'))).toBe(true);

    cleanTempDir();
  });

  // 11. Reload nonexistent workflow — no-op
  it('should no-op when reloading a workflow that does not exist', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    // Should not throw
    await registry.reload('nonexistent');
    expect(registry.get('nonexistent')).toBeUndefined();
  });
});
