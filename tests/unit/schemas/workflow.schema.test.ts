/**
 * Unit tests for the DAWE workflow Zod schema and validation functions.
 *
 * Minimum 25 test cases as specified in the issue.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateWorkflow, loadWorkflow, SchemaErrorCode, getSchemaVersion } from '../../../src/schemas/index.js';
import type { ValidationError } from '../../../src/schemas/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures');

function readFixture(relativePath: string): string {
  return readFileSync(resolve(FIXTURES_DIR, relativePath), 'utf-8');
}

/** Build a minimal valid workflow object for mutation tests. */
function minimalWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    workflow_name: 'test-workflow',
    description: 'A test workflow.',
    initial_node: 'start',
    nodes: {
      start: {
        type: 'llm_decision',
        instruction: 'Decide.',
        required_schema: { answer: 'string' },
        transitions: [{ condition: 'true', target: 'done' }],
      },
      done: {
        type: 'terminal',
        status: 'success',
      },
    },
    ...overrides,
  };
}

function findError(errors: ValidationError[], code: string): ValidationError | undefined {
  return errors.find((e) => e.code === code);
}

// ===================================================================
// Valid workflow tests
// ===================================================================

describe('Valid workflows', () => {
  it('parses a minimal valid workflow (1 llm_decision + 1 terminal)', () => {
    const result = loadWorkflow(readFixture('valid/minimal.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workflow_name).toBe('minimal-workflow');
      expect(result.data.version).toBe('1.0');
      expect(Object.keys(result.data.nodes)).toHaveLength(2);
    }
  });

  it('parses a full-featured workflow with all 4 node types', () => {
    const result = loadWorkflow(readFixture('valid/full-featured.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const types = Object.values(result.data.nodes).map((n) => n.type);
      expect(types).toContain('llm_decision');
      expect(types).toContain('llm_task');
      expect(types).toContain('system_action');
      expect(types).toContain('terminal');
    }
  });

  it('parses a workflow with multiple terminal nodes (success + failure + cancelled)', () => {
    const result = loadWorkflow(readFixture('valid/multi-terminal.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const terminals = Object.values(result.data.nodes).filter((n) => n.type === 'terminal');
      expect(terminals).toHaveLength(3);
    }
  });

  it('parses a workflow with optional fields (metadata, timeout, retry, env)', () => {
    const result = loadWorkflow(readFixture('valid/full-featured.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.metadata).toEqual({ author: 'test-suite', version: 42 });
      const assess = result.data.nodes['assess'];
      expect(assess).toBeDefined();
      if (assess?.type === 'llm_decision') {
        expect(assess.timeout_seconds).toBe(60);
        expect(assess.retry).toEqual({ max_attempts: 3, backoff_ms: 1000 });
      }
      const runAction = result.data.nodes['run-action'];
      if (runAction?.type === 'system_action') {
        expect(runAction.env).toEqual({ NODE_ENV: 'test' });
        expect(runAction.working_dir).toBe('/tmp');
      }
    }
  });

  it('parses a workflow with context_keys on llm_task nodes', () => {
    const result = loadWorkflow(readFixture('valid/full-featured.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const doTask = result.data.nodes['do-task'];
      if (doTask?.type === 'llm_task') {
        expect(doTask.context_keys).toEqual(['user_input', 'session_id']);
      }
    }
  });

  it('parses a workflow with transition priorities', () => {
    const result = loadWorkflow(readFixture('valid/full-featured.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const assess = result.data.nodes['assess'];
      if (assess?.type === 'llm_decision') {
        expect(assess.transitions[0]?.priority).toBe(0);
        expect(assess.transitions[1]?.priority).toBe(1);
        expect(assess.transitions[2]?.priority).toBe(99);
      }
    }
  });
});

// ===================================================================
// Invalid workflow — structural errors
// ===================================================================

describe('Invalid workflows — structural errors', () => {
  it('rejects a workflow missing the version field', () => {
    const result = loadWorkflow(readFixture('invalid/missing-version.yml'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === 'version');
      expect(err).toBeDefined();
    }
  });

  it('rejects a workflow missing workflow_name', () => {
    const { workflow_name: _, ...rest } = minimalWorkflow();
    const result = validateWorkflow(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === 'workflow_name');
      expect(err).toBeDefined();
    }
  });

  it('rejects a workflow missing nodes', () => {
    const { nodes: _, ...rest } = minimalWorkflow();
    const result = validateWorkflow(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === 'nodes');
      expect(err).toBeDefined();
    }
  });

  it('rejects a workflow with an empty nodes object', () => {
    const result = validateWorkflow(minimalWorkflow({ nodes: {} }));
    expect(result.ok).toBe(false);
  });

  it('accepts version "2.0" as valid', () => {
    const result = validateWorkflow(minimalWorkflow({ version: '2.0' }));
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid version value ("3.0")', () => {
    const result = validateWorkflow(minimalWorkflow({ version: '3.0' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === 'version');
      expect(err).toBeDefined();
    }
  });

  it('rejects a workflow_name with spaces → INVALID_WORKFLOW_NAME', () => {
    const result = validateWorkflow(minimalWorkflow({ workflow_name: 'bad name' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.INVALID_WORKFLOW_NAME);
      expect(err).toBeDefined();
    }
  });

  it('rejects a workflow_name starting with a number', () => {
    const result = validateWorkflow(minimalWorkflow({ workflow_name: '1bad' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.INVALID_WORKFLOW_NAME);
      expect(err).toBeDefined();
    }
  });
});

// ===================================================================
// Invalid workflow — cross-reference errors
// ===================================================================

describe('Invalid workflows — cross-reference errors', () => {
  it('rejects initial_node referencing a nonexistent node → INVALID_NODE_REFERENCE', () => {
    const result = validateWorkflow(minimalWorkflow({ initial_node: 'nonexistent' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.INVALID_NODE_REFERENCE);
      expect(err).toBeDefined();
      expect(err!.path).toBe('initial_node');
    }
  });

  it('rejects transition target referencing nonexistent node → INVALID_NODE_REFERENCE with correct path', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [{ condition: 'true', target: 'ghost' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.INVALID_NODE_REFERENCE);
      expect(err).toBeDefined();
      expect(err!.path).toContain('transitions');
      expect(err!.path).toContain('target');
    }
  });

  it('rejects a workflow with no terminal node → MISSING_TERMINAL_NODE', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [{ condition: 'true', target: 'other' }],
        },
        other: {
          type: 'llm_task',
          instruction: 'Do work.',
          completion_schema: { result: 'string' },
          transitions: [{ condition: 'true', target: 'start' }],
        },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.MISSING_TERMINAL_NODE);
      expect(err).toBeDefined();
    }
  });

  it('rejects initial_node pointing to a terminal node → INITIAL_NODE_IS_TERMINAL', () => {
    const wf = minimalWorkflow({
      initial_node: 'done',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = findError(result.errors, SchemaErrorCode.INITIAL_NODE_IS_TERMINAL);
      expect(err).toBeDefined();
    }
  });

  it('rejects a terminal node that has transitions → structural error (strict object)', () => {
    // Since TerminalNodeSchema is strict and doesn't define `transitions`,
    // adding transitions will be a structural parse error.
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: {
          type: 'terminal',
          status: 'success',
          transitions: [{ condition: 'true', target: 'start' }],
        },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-terminal node with zero transitions → NON_TERMINAL_NO_TRANSITIONS', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // There will be both a structural min(1) error and a cross-field error
      const hasRelevantError = result.errors.some((e) => e.path.includes('transitions'));
      expect(hasRelevantError).toBe(true);
    }
  });
});

// ===================================================================
// Invalid workflow — node-specific errors
// ===================================================================

describe('Invalid workflows — node-specific errors', () => {
  it('rejects llm_decision with empty required_schema', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: {},
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });

  it('rejects system_action with invalid runtime value', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'system_action',
          runtime: 'python',
          command: 'echo hi',
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });

  it('rejects llm_task with timeout_seconds: 0 (below minimum)', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_task',
          instruction: 'Do work.',
          completion_schema: { result: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
          timeout_seconds: 0,
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });

  it('rejects a node with an unknown type value', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'unknown_type',
          instruction: 'Do something.',
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });
});

// ===================================================================
// Loader tests
// ===================================================================

describe('loadWorkflow', () => {
  it('returns a parsed WorkflowDefinition for valid YAML', () => {
    const yaml = readFixture('valid/minimal.yml');
    const result = loadWorkflow(yaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workflow_name).toBe('minimal-workflow');
    }
  });

  it('returns INVALID_YAML for unparseable YAML', () => {
    const result = loadWorkflow('key: [unterminated');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe(SchemaErrorCode.INVALID_YAML);
    }
  });

  it('returns schema errors for valid YAML with invalid schema', () => {
    const yaml = `
version: '3.0'
workflow_name: bad
description: Bad workflow
initial_node: x
nodes: {}
`;
    const result = loadWorkflow(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      // Should include version error
      const versionErr = result.errors.find((e) => e.path === 'version');
      expect(versionErr).toBeDefined();
    }
  });

  it('detects duplicate workflow names when existingNames is provided (P1)', () => {
    const yaml = readFixture('valid/minimal.yml');
    const existing = new Set(['minimal-workflow']);
    const result = loadWorkflow(yaml, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe(SchemaErrorCode.DUPLICATE_WORKFLOW_NAME);
    }
  });

  it('allows a name not in the existingNames set', () => {
    const yaml = readFixture('valid/minimal.yml');
    const existing = new Set(['other-workflow']);
    const result = loadWorkflow(yaml, existing);
    expect(result.ok).toBe(true);
  });
});

// ===================================================================
// validateWorkflow direct
// ===================================================================

describe('validateWorkflow', () => {
  it('returns ok: true for a minimal valid object', () => {
    const result = validateWorkflow(minimalWorkflow());
    expect(result.ok).toBe(true);
  });

  it('returns ok: false with errors for an invalid object', () => {
    const result = validateWorkflow({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

// ===================================================================
// v2.0 Schema — max_visits, extract_json, bounded cycles
// ===================================================================

describe('v2.0 Schema — max_visits', () => {
  it('v2.0 workflow with max_visits on system_action → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-bounded-cycle.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe('2.0');
      const runTests = result.data.nodes['run_tests'];
      expect(runTests).toBeDefined();
      if (runTests?.type === 'system_action') {
        expect(runTests.max_visits).toBe(3);
      }
    }
  });

  it('v2.0 workflow with max_visits on llm_task → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-max-visits-all-types.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const doWork = result.data.nodes['do_work'];
      expect(doWork).toBeDefined();
      if (doWork?.type === 'llm_task') {
        expect(doWork.max_visits).toBe(3);
      }
    }
  });

  it('v2.0 workflow with max_visits on llm_decision → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-max-visits-all-types.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decide = result.data.nodes['decide'];
      expect(decide).toBeDefined();
      if (decide?.type === 'llm_decision') {
        expect(decide.max_visits).toBe(5);
      }
    }
  });

  it('v2.0 workflow without max_visits (no cycles) → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-extract-json.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe('2.0');
      const runChecks = result.data.nodes['run_checks'];
      if (runChecks?.type === 'system_action') {
        expect(runChecks.max_visits).toBeUndefined();
      }
    }
  });

  it('v2.0 workflow with max_visits: 0 → invalid', () => {
    const result = loadWorkflow(readFixture('invalid/v2-max-visits-zero.yml'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hasMaxVisitsError = result.errors.some(
        (e) => e.message.includes('max_visits') || e.path.includes('max_visits'),
      );
      expect(hasMaxVisitsError).toBe(true);
    }
  });

  it('v2.0 workflow with max_visits: -1 → invalid', () => {
    const result = loadWorkflow(readFixture('invalid/v2-max-visits-negative.yml'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hasMaxVisitsError = result.errors.some(
        (e) => e.message.includes('max_visits') || e.path.includes('max_visits'),
      );
      expect(hasMaxVisitsError).toBe(true);
    }
  });

  it('v2.0 workflow with max_visits: 101 → invalid (exceeds maximum)', () => {
    const wf = minimalWorkflow({
      version: '2.0',
      nodes: {
        start: {
          type: 'system_action',
          runtime: 'bash',
          command: 'echo hello',
          max_visits: 101,
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const hasMaxVisitsError = result.errors.some(
        (e) => e.message.includes('max_visits') || e.path.includes('max_visits'),
      );
      expect(hasMaxVisitsError).toBe(true);
    }
  });

  it('v1.0 workflow unchanged → still valid', () => {
    const result = loadWorkflow(readFixture('valid/minimal.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe('1.0');
    }
  });

  it('v1.0 workflow with max_visits → valid (field is optional, ignored at runtime for v1.0)', () => {
    const wf = minimalWorkflow({
      version: '1.0',
      nodes: {
        start: {
          type: 'system_action',
          runtime: 'bash',
          command: 'echo hello',
          max_visits: 5,
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const start = result.data.nodes['start'];
      if (start?.type === 'system_action') {
        expect(start.max_visits).toBe(5);
      }
    }
  });
});

describe('v2.0 Schema — extract_json', () => {
  it('v2.0 workflow with extract_json on system_action → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-extract-json.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const runChecks = result.data.nodes['run_checks'];
      if (runChecks?.type === 'system_action') {
        expect(runChecks.extract_json).toBe('/tmp/dawe/lint.json');
      }
    }
  });

  it('extract_json on llm_decision node → invalid (strict schema rejects unknown fields)', () => {
    const result = loadWorkflow(readFixture('invalid/v2-extract-json-on-llm-node.yml'));
    expect(result.ok).toBe(false);
  });

  it('extract_json on llm_task node → invalid', () => {
    const wf = minimalWorkflow({
      version: '2.0',
      nodes: {
        start: {
          type: 'llm_task',
          instruction: 'Do work.',
          completion_schema: { result: 'string' },
          extract_json: '/tmp/output.json',
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
  });
});

describe('v2.0 Schema — suspended terminal status', () => {
  it('v2.0 workflow with suspended terminal → valid', () => {
    const result = loadWorkflow(readFixture('valid/v2-bounded-cycle.yml'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const humanIntervention = result.data.nodes['human_intervention'];
      expect(humanIntervention).toBeDefined();
      if (humanIntervention?.type === 'terminal') {
        expect(humanIntervention.status).toBe('suspended');
      }
    }
  });

  it('suspended terminal in v1.0 workflow → also valid (schema allows it)', () => {
    const wf = minimalWorkflow({
      version: '1.0',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { answer: 'string' },
          transitions: [{ condition: 'true', target: 'suspended' }],
        },
        suspended: { type: 'terminal', status: 'suspended', message: 'Needs human review.' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(true);
  });
});

// ===================================================================
// getSchemaVersion utility
// ===================================================================

describe('getSchemaVersion', () => {
  it('returns "1.0" for a v1.0 workflow', () => {
    expect(getSchemaVersion({ version: '1.0' })).toBe('1.0');
  });

  it('returns "2.0" for a v2.0 workflow', () => {
    expect(getSchemaVersion({ version: '2.0' })).toBe('2.0');
  });

  it('returns undefined for unknown version', () => {
    expect(getSchemaVersion({ version: '3.0' })).toBeUndefined();
  });

  it('returns undefined for missing version field', () => {
    expect(getSchemaVersion({})).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(getSchemaVersion(null)).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(getSchemaVersion('1.0')).toBeUndefined();
  });
});
