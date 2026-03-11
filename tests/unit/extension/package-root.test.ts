/**
 * Unit tests for PACKAGE_ROOT resolution.
 *
 * Verifies that the import.meta.url-based PACKAGE_ROOT constant
 * resolves correctly to the pi-workflows package root in all environments.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGE_ROOT, BUNDLED_EXAMPLES_DIR, BUNDLED_SCRIPTS_DIR } from '../../../src/extension/workflow-registry.js';

describe('PACKAGE_ROOT resolution', () => {
  // 1. PACKAGE_ROOT resolves to a directory containing package.json
  it('should resolve to a directory containing package.json', () => {
    const packageJsonPath = join(PACKAGE_ROOT, 'package.json');
    expect(existsSync(packageJsonPath)).toBe(true);

    // Verify it's actually our package.json
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name: string };
    expect(pkg.name).toBe('@ai-daemon/pi-workflows');
  });

  // 2. PACKAGE_ROOT/workflows/examples/ contains the 4 bundled workflow YAML files
  it('should have workflows/examples/ with at least 4 bundled YAML files', () => {
    expect(existsSync(BUNDLED_EXAMPLES_DIR)).toBe(true);

    const files = readdirSync(BUNDLED_EXAMPLES_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(4);

    const expectedWorkflows = ['simple-task.yml', 'code-review.yml', 'issue-first-development.yml', 'pr-creation.yml'];
    for (const expected of expectedWorkflows) {
      expect(files).toContain(expected);
    }
  });

  // 3. BUNDLED_SCRIPTS_DIR points to a valid directory with executable scripts
  it('should have workflows/scripts/ with bundled scripts', () => {
    expect(existsSync(BUNDLED_SCRIPTS_DIR)).toBe(true);

    const files = readdirSync(BUNDLED_SCRIPTS_DIR).filter((f) => f.endsWith('.sh'));
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  // 4. BUNDLED_EXAMPLES_DIR is derived from PACKAGE_ROOT
  it('should derive BUNDLED_EXAMPLES_DIR from PACKAGE_ROOT', () => {
    expect(BUNDLED_EXAMPLES_DIR).toBe(join(PACKAGE_ROOT, 'workflows', 'examples'));
  });

  // 5. BUNDLED_SCRIPTS_DIR is derived from PACKAGE_ROOT
  it('should derive BUNDLED_SCRIPTS_DIR from PACKAGE_ROOT', () => {
    expect(BUNDLED_SCRIPTS_DIR).toBe(join(PACKAGE_ROOT, 'workflows', 'scripts'));
  });
});
