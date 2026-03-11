/**
 * Integration tests for SystemActionExecutor.
 *
 * Tests end-to-end scenarios with real file system interaction,
 * PayloadManager integration, and command chaining.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SystemActionExecutor } from '../../src/engine/system-action-executor.js';
import { PayloadManager } from '../../src/engine/payload-manager.js';
import type { SystemActionNode } from '../../src/schemas/workflow.schema.js';
import type { ExpressionContext } from '../../src/engine/expression-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<SystemActionNode> = {}): SystemActionNode {
  return {
    type: 'system_action',
    runtime: 'bash',
    command: 'echo "hello"',
    transitions: [{ condition: 'true', target: 'next' }],
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dawe-integ-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('SystemActionExecutor integration', () => {
  it('execute a real bash script file → correct output', () => {
    const dir = makeTempDir();
    const scriptPath = join(dir, 'greet.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho "Hello, $1!"');
    chmodSync(scriptPath, '755');

    const executor = new SystemActionExecutor({ workingDir: dir });
    const node = makeNode({ command: `${scriptPath} World` });

    return executor.execute(node, { payload: {} }).then((result) => {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exit_code).toBe(0);
        expect(result.data.stdout.trim()).toBe('Hello, World!');
      }
    });
  });

  it('execute command with real file system interaction', async () => {
    const dir = makeTempDir();
    const executor = new SystemActionExecutor({ workingDir: dir });

    // Create a file
    const createNode = makeNode({
      command: 'echo "test content" > output.txt && echo "created"',
      working_dir: dir,
    });
    const createResult = await executor.execute(createNode, { payload: {} });
    expect(createResult.ok).toBe(true);
    if (createResult.ok) {
      expect(createResult.data.exit_code).toBe(0);
    }

    // Read it back
    const readNode = makeNode({
      command: 'cat output.txt',
      working_dir: dir,
    });
    const readResult = await executor.execute(readNode, { payload: {} });
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.data.stdout.trim()).toBe('test content');
    }
  });

  it('execute with PayloadManager-resolved templates end-to-end', async () => {
    const dir = makeTempDir();
    const executor = new SystemActionExecutor({ workingDir: dir });

    // Create a PayloadManager with some state
    const pm = new PayloadManager({
      project_name: 'my-project',
      version: '1.2.3',
    });

    // The executor uses its own template resolution, but we verify the
    // PayloadManager payload feeds in correctly
    // Note: payload values are auto-shell-escaped (wrapped in single quotes).
    // Use unquoted template so bash interprets the single-quoted values.
    const node = makeNode({
      command: 'echo {{payload.project_name}} v{{payload.version}}',
    });

    const context: ExpressionContext = {
      payload: pm.getPayload() as Record<string, unknown>,
    };

    const result = await executor.execute(node, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stdout.trim()).toBe('my-project v1.2.3');
    }
  });

  it('chain: system_action → capture result → template into next command', async () => {
    const dir = makeTempDir();
    const executor = new SystemActionExecutor({ workingDir: dir });
    const pm = new PayloadManager();

    // Step 1: Generate some data
    const step1Node = makeNode({
      command: 'echo \'{"count": 42, "status": "ready"}\'',
    });
    const step1Result = await executor.execute(step1Node, {
      payload: pm.getPayload() as Record<string, unknown>,
    });
    expect(step1Result.ok).toBe(true);
    if (!step1Result.ok) return;

    // Merge the result into the payload
    pm.merge('step1', {
      action_result: {
        exit_code: step1Result.data.exit_code,
        stdout: step1Result.data.stdout,
        data: step1Result.data.data,
      },
    });

    // Step 2: Use the data from step 1
    const step2Node = makeNode({
      command: 'echo "Count is {{payload.action_result.data.count}}"',
    });
    const step2Result = await executor.execute(step2Node, {
      payload: pm.getPayload() as Record<string, unknown>,
    });
    expect(step2Result.ok).toBe(true);
    if (step2Result.ok) {
      expect(step2Result.data.stdout.trim()).toBe("Count is '42'");
    }
  });

  it('multiple concurrent executions do not interfere', async () => {
    const executor = new SystemActionExecutor({ workingDir: tmpdir() });

    const promises = Array.from({ length: 5 }, (_, i) => {
      const node = makeNode({ command: `echo "task-${i}"` });
      return executor.execute(node, { payload: {} });
    });

    const results = await Promise.all(promises);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.stdout.trim()).toBe(`task-${i}`);
      }
    }
  });

  it('end-to-end with environment and working directory', async () => {
    const dir = makeTempDir();
    const executor = new SystemActionExecutor({
      workingDir: dir,
      env: { GREETING: 'hello' },
    });

    const node = makeNode({
      command: 'echo "$GREETING from $(basename $(pwd)) by $AUTHOR"',
      env: { AUTHOR: 'dawe' },
    });

    const result = await executor.execute(node, { payload: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const dirBasename = dir.split('/').pop();
      expect(result.data.stdout.trim()).toBe(`hello from ${dirBasename} by dawe`);
    }
  });
});
