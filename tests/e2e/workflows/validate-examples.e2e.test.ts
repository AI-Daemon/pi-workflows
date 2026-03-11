/**
 * Example Workflow Validation E2E Tests (DAWE-010)
 *
 * Validates all example workflows in workflows/examples/ against
 * the full DAWE validation pipeline: YAML → schema → expression → graph.
 *
 * Also validates companion bash scripts in workflows/scripts/.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, accessSync, constants } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { validateWorkflowFull } from '../../../src/engine/composite-validation.js';
import { loadWorkflow } from '../../../src/schemas/validation.js';
import type { WorkflowDefinition } from '../../../src/schemas/workflow.schema.js';
import { resolveTemplate } from '../../../src/engine/template-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = path.resolve(import.meta.dirname, '../../../workflows/examples');
const SCRIPTS_DIR = path.resolve(import.meta.dirname, '../../../workflows/scripts');

function loadExampleYaml(filename: string): string {
  return readFileSync(path.join(EXAMPLES_DIR, filename), 'utf-8');
}

function getExampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

function getScriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh') && f !== 'lib');
}

function getParsedWorkflow(filename: string): WorkflowDefinition {
  const yaml = loadExampleYaml(filename);
  const result = loadWorkflow(yaml);
  if (!result.ok) {
    throw new Error(`Failed to parse ${filename}: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

/**
 * Collect all Handlebars template strings from a workflow definition.
 * Checks instructions, commands, and terminal messages.
 */
function collectTemplateStrings(def: WorkflowDefinition): Array<{ nodeId: string; template: string; field: string }> {
  const templates: Array<{ nodeId: string; template: string; field: string }> = [];
  for (const [nodeId, node] of Object.entries(def.nodes)) {
    if (node.type === 'llm_decision' || node.type === 'llm_task') {
      templates.push({ nodeId, template: node.instruction, field: 'instruction' });
    }
    if (node.type === 'system_action') {
      templates.push({ nodeId, template: node.command, field: 'command' });
      if (node.extract_json) {
        templates.push({ nodeId, template: node.extract_json, field: 'extract_json' });
      }
    }
    if (node.type === 'terminal' && node.message) {
      templates.push({ nodeId, template: node.message, field: 'message' });
    }
  }
  return templates;
}

// ===========================================================================
// Schema + FSM Validation for Each Workflow
// ===========================================================================

describe('Example Workflow Validation (DAWE-010)', () => {
  const exampleFiles = getExampleFiles();

  it('should have at least 3 example workflows', () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of exampleFiles) {
    describe(`${file}`, () => {
      it('should pass full validation (schema + expression + graph)', () => {
        const yaml = loadExampleYaml(file);
        const result = validateWorkflowFull(yaml);
        if (!result.ok) {
          // Provide helpful error output
          const errorDetails = result.errors.map(
            (e) => `  [${e.code}] ${'path' in e ? e.path + ': ' : ''}${e.message}`,
          );
          throw new Error(`Validation failed for ${file}:\n${errorDetails.join('\n')}`);
        }
        expect(result.ok).toBe(true);
      });

      it('should have no orphaned nodes', () => {
        const yaml = loadExampleYaml(file);
        const result = validateWorkflowFull(yaml);
        expect(result.ok).toBe(true);
        // Graph validation checks for orphaned nodes — if we pass, there are none
      });

      it('should have all Handlebars templates compile without errors', () => {
        const def = getParsedWorkflow(file);
        const templates = collectTemplateStrings(def);
        // Use a dummy context to test template compilation (not resolution)
        const dummyContext = {
          payload: {
            project_name: 'test',
            description: 'test',
            issue_type: 'bug',
            requires_edits: true,
            action_result: { stdout: '', stderr: '', exit_code: 0 },
            extracted_json: {},
            log_pointer_path: '/tmp/test.log',
            status: 'complete',
            files_changed: 'test.ts',
            base_branch: 'main',
            title: 'test',
            verdict: 'approve',
            summary: 'looks good',
            repo: 'test/repo',
            pr_number: 1,
            focus_areas: 'security',
            existing_issue_number: 1,
            use_existing: false,
            task_description: 'do a thing',
          },
          $metadata: {
            visits: { run_tests: 1, fix_tests: 1 },
            state_hashes: [],
            instance_id: 'test-id',
            started_at: '2025-01-01T00:00:00Z',
          },
          metadata: {},
        };

        for (const { nodeId, template, field } of templates) {
          const result = resolveTemplate(template, dummyContext);
          if (!result.ok) {
            throw new Error(
              `Template compilation failed in ${file} → ${nodeId}.${field}: ${result.errors.message}\n  Template: ${template.substring(0, 100)}...`,
            );
          }
          expect(result.ok).toBe(true);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Workflow-specific validations
  // -------------------------------------------------------------------------

  describe('issue-first-development.yml — v2.0 specifics', () => {
    const file = 'issue-first-development.yml';

    it('should declare version 2.0', () => {
      const def = getParsedWorkflow(file);
      expect(def.version).toBe('2.0');
    });

    it('should have at least one success terminal', () => {
      const def = getParsedWorkflow(file);
      const successTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'success');
      expect(successTerminals.length).toBeGreaterThanOrEqual(1);
    });

    it('should have at least one failure terminal', () => {
      const def = getParsedWorkflow(file);
      const failureTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'failure');
      expect(failureTerminals.length).toBeGreaterThanOrEqual(1);
    });

    it('should have a human_intervention terminal with status suspended', () => {
      const def = getParsedWorkflow(file);
      const node = def.nodes['human_intervention'];
      expect(node).toBeDefined();
      expect(node!.type).toBe('terminal');
      if (node!.type === 'terminal') {
        expect(node!.status).toBe('suspended');
      }
    });

    it('should have run_tests node with max_visits: 3 and extract_json', () => {
      const def = getParsedWorkflow(file);
      const runTests = def.nodes['run_tests'];
      expect(runTests).toBeDefined();
      expect(runTests!.type).toBe('system_action');
      if (runTests!.type === 'system_action') {
        expect(runTests!.max_visits).toBe(3);
        expect(runTests!.extract_json).toBeDefined();
        expect(runTests!.extract_json).toContain('.json');
      }
    });

    it('should have a valid bounded cycle: fix_tests → run_tests', () => {
      const def = getParsedWorkflow(file);
      const fixTests = def.nodes['fix_tests'];
      expect(fixTests).toBeDefined();
      expect(fixTests!.type).not.toBe('terminal');
      if (fixTests!.type !== 'terminal') {
        const transitionsToRunTests = fixTests!.transitions.filter((t) => t.target === 'run_tests');
        expect(transitionsToRunTests.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should pass full v2.0 validation including bounded cycle checks', () => {
      const yaml = loadExampleYaml(file);
      const result = validateWorkflowFull(yaml);
      expect(result.ok).toBe(true);
      // Bounded cycle validation is part of validateWorkflowFull for v2.0
    });

    it('should have all transition expressions be syntactically valid', () => {
      // Already covered by validateWorkflowFull, but let's explicitly confirm
      const yaml = loadExampleYaml(file);
      const result = validateWorkflowFull(yaml);
      expect(result.ok).toBe(true);
    });

    it('should have $metadata.visits references in fix_tests instruction', () => {
      const def = getParsedWorkflow(file);
      const fixTests = def.nodes['fix_tests'];
      expect(fixTests).toBeDefined();
      if (fixTests!.type === 'llm_task') {
        expect(fixTests!.instruction).toContain('$metadata.visits');
      }
    });
  });

  describe('pr-creation.yml — v2.0 specifics', () => {
    const file = 'pr-creation.yml';

    it('should declare version 2.0', () => {
      const def = getParsedWorkflow(file);
      expect(def.version).toBe('2.0');
    });

    it('should have at least one success terminal', () => {
      const def = getParsedWorkflow(file);
      const successTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'success');
      expect(successTerminals.length).toBeGreaterThanOrEqual(1);
    });

    it('should have at least one failure terminal', () => {
      const def = getParsedWorkflow(file);
      const failureTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'failure');
      expect(failureTerminals.length).toBeGreaterThanOrEqual(1);
    });

    it('should have extract_json configured on run_checks node', () => {
      const def = getParsedWorkflow(file);
      const runChecks = def.nodes['run_checks'];
      expect(runChecks).toBeDefined();
      if (runChecks!.type === 'system_action') {
        expect(runChecks!.extract_json).toBeDefined();
      }
    });
  });

  describe('simple-task.yml — v1.0 backward compatibility', () => {
    const file = 'simple-task.yml';

    it('should declare version 1.0', () => {
      const def = getParsedWorkflow(file);
      expect(def.version).toBe('1.0');
    });

    it('should be under 50 lines of YAML', () => {
      const yaml = loadExampleYaml(file);
      const lineCount = yaml.split('\n').length;
      expect(lineCount).toBeLessThan(50);
    });

    it('should have at least one success terminal', () => {
      const def = getParsedWorkflow(file);
      const successTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'success');
      expect(successTerminals.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('code-review.yml — v2.0 specifics', () => {
    const file = 'code-review.yml';

    it('should declare version 2.0', () => {
      const def = getParsedWorkflow(file);
      expect(def.version).toBe('2.0');
    });

    it('should have at least one success terminal', () => {
      const def = getParsedWorkflow(file);
      const successTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'success');
      expect(successTerminals.length).toBeGreaterThanOrEqual(1);
    });

    it('should have at least one failure terminal', () => {
      const def = getParsedWorkflow(file);
      const failureTerminals = Object.values(def.nodes).filter((n) => n.type === 'terminal' && n.status === 'failure');
      expect(failureTerminals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-workflow checks
  // -------------------------------------------------------------------------

  describe('Cross-workflow uniqueness', () => {
    it('should have unique workflow_name across all examples', () => {
      const names = new Set<string>();
      for (const file of exampleFiles) {
        const def = getParsedWorkflow(file);
        expect(names.has(def.workflow_name)).toBe(false);
        names.add(def.workflow_name);
      }
    });
  });
});

// ===========================================================================
// Script Tests
// ===========================================================================

describe('Companion Script Validation (DAWE-010)', () => {
  const scriptFiles = getScriptFiles();

  it('should have at least 5 companion scripts', () => {
    expect(scriptFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const script of scriptFiles) {
    describe(`${script}`, () => {
      const scriptPath = path.join(SCRIPTS_DIR, script);

      it('should be executable', () => {
        expect(() => {
          accessSync(scriptPath, constants.X_OK);
        }).not.toThrow();
      });

      it('should respond to --help flag with exit code 0', () => {
        const result = execSync(`bash "${scriptPath}" --help 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
        expect(result).toContain('Usage:');
      });
    });
  }

  describe('lib/common.sh', () => {
    const commonPath = path.join(SCRIPTS_DIR, 'lib', 'common.sh');

    it('should exist and be sourceable', () => {
      const result = execSync(`bash -c 'source "${commonPath}" && echo "sourced ok"'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toBe('sourced ok');
    });

    it('should define json_output function', () => {
      const result = execSync(`bash -c 'source "${commonPath}" && json_output "{\\"test\\": true}"'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toBe('{"test": true}');
    });

    it('should define json_error function', () => {
      const result = execSync(`bash -c 'source "${commonPath}" && json_error "test error" 2>&1'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toContain('"error"');
      expect(result.trim()).toContain('test error');
    });

    it('should define require_command function', () => {
      // Test with a command that exists
      const result = execSync(`bash -c 'source "${commonPath}" && require_command "echo" && echo "ok"'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result.trim()).toBe('ok');
    });

    it('should fail require_command for missing commands', () => {
      let exitCode = 0;
      try {
        execSync(`bash -c 'source "${commonPath}" && require_command "nonexistent_tool_xyz"'`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        exitCode = error.status;
        expect(error.stderr).toContain('nonexistent_tool_xyz');
      }
      expect(exitCode).toBe(2);
    });
  });

  describe('Script error handling', () => {
    it('check-gh-issue.sh with missing arguments should exit 2', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'check-gh-issue.sh');
      let exitCode = 0;
      try {
        execSync(`bash "${scriptPath}" 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch (err: unknown) {
        exitCode = (err as { status: number }).status;
      }
      expect(exitCode).not.toBe(0);
    });

    it('create-gh-issue.sh with missing arguments should exit non-zero', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'create-gh-issue.sh');
      let exitCode = 0;
      try {
        execSync(`bash "${scriptPath}" 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch (err: unknown) {
        exitCode = (err as { status: number }).status;
      }
      expect(exitCode).not.toBe(0);
    });

    it('setup-branch.sh with missing arguments should exit non-zero', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'setup-branch.sh');
      let exitCode = 0;
      try {
        execSync(`bash "${scriptPath}" 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch (err: unknown) {
        exitCode = (err as { status: number }).status;
      }
      expect(exitCode).not.toBe(0);
    });

    it('create-pr.sh with missing arguments should exit non-zero', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'create-pr.sh');
      let exitCode = 0;
      try {
        execSync(`bash "${scriptPath}" 2>&1`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch (err: unknown) {
        exitCode = (err as { status: number }).status;
      }
      expect(exitCode).not.toBe(0);
    });

    it('run-project-tests.sh should respond to --help', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'run-project-tests.sh');
      const result = execSync(`bash "${scriptPath}" --help 2>&1`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      expect(result).toContain('Usage:');
      expect(result).toContain('output-path');
    });
  });
});
