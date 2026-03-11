/**
 * Tests for validation error quality — path formatting, multiple error
 * collection, and error code correctness.
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow, SchemaErrorCode } from '../../../src/schemas/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ===================================================================
// Error message & path quality
// ===================================================================

describe('Error messages contain the YAML path', () => {
  it('includes the path for a missing top-level field', () => {
    const { version: _, ...rest } = minimalWorkflow();
    const result = validateWorkflow(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path === 'version');
      expect(err).toBeDefined();
      expect(err!.message).toBeTruthy();
    }
  });

  it('includes a dotted path for nested transition target errors', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { a: 'string' },
          transitions: [
            { condition: 'true', target: 'done' },
            { condition: 'other', target: 'nonexistent' },
          ],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.path.includes('transitions[1].target'));
      expect(err).toBeDefined();
      expect(err!.code).toBe(SchemaErrorCode.INVALID_NODE_REFERENCE);
    }
  });
});

describe('Multiple errors are collected (not fail-fast)', () => {
  it('collects multiple structural errors at once', () => {
    // Missing version AND bad workflow_name AND empty nodes
    const result = validateWorkflow({
      workflow_name: '1 bad name!',
      description: 'Test.',
      initial_node: 'x',
      nodes: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should have at least 2 errors (version missing + name invalid + nodes empty)
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('collects both structural and cross-field errors', () => {
    const wf = minimalWorkflow({
      initial_node: 'nonexistent',
      nodes: {
        // No terminal node, and initial_node is wrong
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { a: 'string' },
          transitions: [{ condition: 'true', target: 'start' }],
        },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toContain(SchemaErrorCode.INVALID_NODE_REFERENCE);
      expect(codes).toContain(SchemaErrorCode.MISSING_TERMINAL_NODE);
    }
  });
});

describe('Error codes match the SchemaErrorCode enum', () => {
  it('uses INVALID_NODE_REFERENCE for bad initial_node', () => {
    const result = validateWorkflow(minimalWorkflow({ initial_node: 'ghost' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === (SchemaErrorCode.INVALID_NODE_REFERENCE as string));
      expect(err).toBeDefined();
    }
  });

  it('uses MISSING_TERMINAL_NODE when no terminal exists', () => {
    const wf = minimalWorkflow({
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { a: 'string' },
          transitions: [{ condition: 'true', target: 'other' }],
        },
        other: {
          type: 'llm_task',
          instruction: 'Task.',
          completion_schema: { r: 'string' },
          transitions: [{ condition: 'true', target: 'start' }],
        },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === (SchemaErrorCode.MISSING_TERMINAL_NODE as string));
      expect(err).toBeDefined();
    }
  });

  it('uses INITIAL_NODE_IS_TERMINAL when initial is terminal', () => {
    const wf = minimalWorkflow({
      initial_node: 'done',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Decide.',
          required_schema: { a: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === (SchemaErrorCode.INITIAL_NODE_IS_TERMINAL as string));
      expect(err).toBeDefined();
    }
  });

  it('uses INVALID_WORKFLOW_NAME for bad workflow names', () => {
    const result = validateWorkflow(minimalWorkflow({ workflow_name: 'BAD NAME' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors.find((e) => e.code === (SchemaErrorCode.INVALID_WORKFLOW_NAME as string));
      expect(err).toBeDefined();
    }
  });

  it('every error has a non-empty code that is a string', () => {
    const result = validateWorkflow({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const err of result.errors) {
        expect(typeof err.code).toBe('string');
        expect(err.code.length).toBeGreaterThan(0);
      }
    }
  });
});
