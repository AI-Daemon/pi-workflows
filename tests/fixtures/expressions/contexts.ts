/**
 * Reusable ExpressionContext objects for expression evaluator tests.
 */

import type { ExpressionContext } from '../../../src/engine/expression-context.js';

// ---------------------------------------------------------------------------
// Basic contexts
// ---------------------------------------------------------------------------

/** Simple payload with scalar values. */
export const simplePayload: ExpressionContext = {
  payload: {
    count: 5,
    name: 'admin',
    flag: false,
    a: true,
    b: true,
    c: false,
    type: 'bug',
    status: 'active',
    requires_edits: true,
    severity: 'critical',
    issue_count: 10,
  },
};

/** Payload with nested objects. */
export const nestedPayload: ExpressionContext = {
  payload: {
    user: {
      name: 'alice',
      role: 'admin',
      settings: {
        theme: 'dark',
      },
    },
    items: [
      { name: 'first', value: 10 },
      { name: 'second', value: 20 },
    ],
    deeply: {
      nested: {
        value: 42,
      },
    },
  },
};

/** Empty payload. */
export const emptyPayload: ExpressionContext = {
  payload: {},
};

/** Payload with array values. */
export const arrayPayload: ExpressionContext = {
  payload: {
    roles: ['admin', 'user', 'editor'],
    items: ['alpha', 'beta', 'gamma'],
    counts: [1, 2, 3],
  },
};

// ---------------------------------------------------------------------------
// Action result contexts
// ---------------------------------------------------------------------------

/** Successful system action result. */
export const successActionResult: ExpressionContext = {
  payload: {},
  action_result: {
    exit_code: 0,
    stdout: 'Build succeeded\n',
    stderr: '',
    data: {
      issue_number: 42,
      passed: true,
    },
  },
};

/** Failed system action result. */
export const failedActionResult: ExpressionContext = {
  payload: {},
  action_result: {
    exit_code: 1,
    stdout: '',
    stderr: 'Error: build failed\n',
    data: {
      error_count: 3,
    },
  },
};

// ---------------------------------------------------------------------------
// Metadata contexts
// ---------------------------------------------------------------------------

/** Context with metadata. */
export const withMetadata: ExpressionContext = {
  payload: { count: 5 },
  metadata: {
    workflow_id: 'wf-123',
    environment: 'production',
  },
};

// ---------------------------------------------------------------------------
// Mixed contexts (payload + action_result + metadata)
// ---------------------------------------------------------------------------

/** Full context with all fields populated. */
export const fullContext: ExpressionContext = {
  payload: {
    count: 10,
    name: 'test-workflow',
    requires_edits: true,
  },
  action_result: {
    exit_code: 0,
    stdout: 'OK',
    stderr: '',
    data: {
      result: 'success',
    },
  },
  metadata: {
    environment: 'staging',
  },
};
