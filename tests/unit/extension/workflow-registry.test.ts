/**
 * Unit tests for WorkflowRegistry — YAML scanning, loading, caching.
 *
 * Minimum 10 test cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { WorkflowRegistry, BUNDLED_SCRIPTS_DIR } from '../../../src/extension/workflow-registry.js';

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

function createTempSubDir(subDir: string): string {
  const fullPath = resolve(TEMP_DIR, subDir);
  mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

function writeTempSubWorkflow(subDir: string, fileName: string, content: string): void {
  const dirPath = createTempSubDir(subDir);
  writeFileSync(resolve(dirPath, fileName), content, 'utf-8');
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

  // ---------------------------------------------------------------------------
  // New tests for default constructor (issue #58 — pi install packaging)
  // ---------------------------------------------------------------------------

  // 12. Default constructor discovers bundled examples from package root
  it('should discover bundled examples with default constructor', async () => {
    const registry = new WorkflowRegistry();
    await registry.loadAll();

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('simple-task');
    expect(names).toContain('code-review');
    expect(names).toContain('issue-first-development');
    expect(names).toContain('pr-creation');
  });

  // 13. Default constructor discovers workflows from ~/.pi/workflows/ (via temp dir)
  it('should discover workflows from user directory when present', async () => {
    // We test the mechanism by passing a temp dir simulating ~/.pi/workflows/
    createTempDir();
    writeTempWorkflow(
      'user-custom.yml',
      `
version: '1.0'
workflow_name: user-custom
description: A user-authored workflow
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

    // Include bundled examples dir + temp dir simulating user dir
    const { BUNDLED_EXAMPLES_DIR } = await import('../../../src/extension/workflow-registry.js');
    const registry = new WorkflowRegistry([BUNDLED_EXAMPLES_DIR, TEMP_DIR]);
    await registry.loadAll();

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('simple-task'); // bundled
    expect(names).toContain('user-custom'); // user-authored

    cleanTempDir();
  });

  // 14. Default constructor handles missing ./workflows/ directory gracefully
  it('should handle missing CWD workflows directory gracefully', async () => {
    // Pass a nonexistent CWD-style path alongside bundled examples
    const { BUNDLED_EXAMPLES_DIR } = await import('../../../src/extension/workflow-registry.js');
    const registry = new WorkflowRegistry([
      BUNDLED_EXAMPLES_DIR,
      '/nonexistent/user-workflows-dir',
      '/nonexistent/cwd-workflows-dir',
    ]);
    await registry.loadAll();

    // Bundled examples should still load
    const names = registry.list().map((w) => w.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain('simple-task');

    // Warnings logged for missing dirs but no crash
    const warnings = registry.getWarnings();
    expect(warnings.some((w) => w.includes('/nonexistent/'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // New tests for subdirectory scanning & per-workflow scripts (issues #71, #72)
  // ---------------------------------------------------------------------------

  // 15. Discovers workflows inside subdirectories
  it('should discover workflow YAML inside subdirectories', async () => {
    createTempDir();

    writeTempSubWorkflow(
      'my-workflow',
      'my-workflow.yml',
      `
version: '1.0'
workflow_name: my-workflow
description: A workflow in a subdirectory
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

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('my-workflow');

    cleanTempDir();
  });

  // 16. Discovers both top-level and subdirectory workflows in the same scan
  it('should discover both top-level and subdirectory workflows', async () => {
    createTempDir();

    // Top-level workflow
    writeTempWorkflow(
      'top-level.yml',
      `
version: '1.0'
workflow_name: top-level
description: A top-level workflow
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

    // Subdirectory workflow
    writeTempSubWorkflow(
      'sub-workflow',
      'sub-workflow.yml',
      `
version: '1.0'
workflow_name: sub-workflow
description: A subdirectory workflow
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

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('top-level');
    expect(names).toContain('sub-workflow');

    cleanTempDir();
  });

  // 17. Skips _-prefixed directories (e.g., _scripts)
  it('should skip directories prefixed with underscore', async () => {
    createTempDir();

    // Create an _scripts directory with a YAML file (should be skipped)
    writeTempSubWorkflow(
      '_scripts',
      'not-a-workflow.yml',
      `
version: '1.0'
workflow_name: should-not-load
description: This should not be discovered
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

    // Also add a real workflow in a non-prefixed subdir
    writeTempSubWorkflow(
      'real-workflow',
      'real-workflow.yml',
      `
version: '1.0'
workflow_name: real-workflow
description: A real workflow
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

    const names = registry.list().map((w) => w.name);
    expect(names).not.toContain('should-not-load');
    expect(names).toContain('real-workflow');

    cleanTempDir();
  });

  // 18. getWorkflowScriptsDir returns scripts path when scripts/ exists in workflow dir
  it('should return per-workflow scripts dir when scripts/ exists', async () => {
    createTempDir();

    // Create a workflow with a scripts/ subdirectory
    writeTempSubWorkflow(
      'scripted-workflow',
      'scripted-workflow.yml',
      `
version: '1.0'
workflow_name: scripted-workflow
description: A workflow with its own scripts
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

    // Create the scripts/ subdirectory inside the workflow dir
    createTempSubDir('scripted-workflow/scripts');

    const registry = new WorkflowRegistry([TEMP_DIR]);
    await registry.loadAll();

    const scriptsDir = registry.getWorkflowScriptsDir('scripted-workflow');
    expect(scriptsDir).toBeDefined();
    expect(scriptsDir).toBe(resolve(TEMP_DIR, 'scripted-workflow', 'scripts'));

    cleanTempDir();
  });

  // 19. getWorkflowScriptsDir returns undefined when no scripts/ exists
  it('should return undefined for workflow without scripts dir', async () => {
    createTempDir();

    writeTempSubWorkflow(
      'no-scripts-workflow',
      'no-scripts-workflow.yml',
      `
version: '1.0'
workflow_name: no-scripts-workflow
description: A workflow without scripts
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

    const scriptsDir = registry.getWorkflowScriptsDir('no-scripts-workflow');
    expect(scriptsDir).toBeUndefined();

    cleanTempDir();
  });

  // 20. getWorkflowScriptsDir returns undefined for nonexistent workflow
  it('should return undefined for nonexistent workflow scripts dir', async () => {
    const registry = new WorkflowRegistry([FIXTURES_DIR]);
    await registry.loadAll();

    const scriptsDir = registry.getWorkflowScriptsDir('nonexistent');
    expect(scriptsDir).toBeUndefined();
  });

  // 21. BUNDLED_SCRIPTS_DIR points to _scripts (issue #72)
  it('should point BUNDLED_SCRIPTS_DIR to _scripts directory', () => {
    expect(BUNDLED_SCRIPTS_DIR).toMatch(/_scripts$/);
  });

  // 22. Default constructor discovers the bundled create-workflow from subdirectory
  it('should discover bundled create-workflow from its subdirectory', async () => {
    // Use a registry that points at the real workflows/ directory
    // which contains create-workflow/create-workflow.yml
    const workflowsDir = resolve('workflows');
    const registry = new WorkflowRegistry([workflowsDir]);
    await registry.loadAll();

    const names = registry.list().map((w) => w.name);
    expect(names).toContain('create-workflow');
  });
});
