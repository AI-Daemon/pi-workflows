/**
 * Tests for DAWE-018: error-formatter integration with DAWEError.
 *
 * Verifies that formatRuntimeError uses DAWEError.toAgentMessage() when
 * the input is a DAWEError, and still works with plain RuntimeError objects.
 */

import { describe, it, expect } from 'vitest';
import { formatRuntimeError } from '../../../src/extension/error-formatter.js';
import { RuntimeError as DAWERuntimeError, DAWEError } from '../../../src/utils/errors.js';
import type { RuntimeError } from '../../../src/engine/runtime-errors.js';
import { RuntimeErrorCode } from '../../../src/engine/runtime-errors.js';

describe('formatRuntimeError — DAWEError Integration (DAWE-018)', () => {
  it('uses DAWEError.toAgentMessage() when input is a DAWEError', () => {
    const error = new DAWERuntimeError('R-001', 'No matching transition', {
      agentHint: 'Check your payload values against the transition conditions.',
      context: {
        instanceId: 'abc-123',
        nodeId: 'start',
      },
    });

    const result = formatRuntimeError(error as unknown as RuntimeError);

    // Should contain the error code header
    expect(result).toContain('> **ERROR:** R-001');
    // Should contain the recovery hint from toAgentMessage()
    expect(result).toContain('RECOVERY:');
    expect(result).toContain('Check your payload values');
    // Should contain instance/node context
    expect(result).toContain('Instance: `abc-123`');
    expect(result).toContain('Node: `start`');
  });

  it('still works with plain RuntimeError interface (backward compat)', () => {
    const error: RuntimeError = {
      code: RuntimeErrorCode.NO_MATCHING_TRANSITION,
      message: 'No transition matched for node "start"',
      instanceId: 'abc-123',
      nodeId: 'start',
    };

    const result = formatRuntimeError(error);

    // Should contain the plain formatting
    expect(result).toContain('> **ERROR:** NO_MATCHING_TRANSITION');
    expect(result).toContain('No transition matched for node "start"');
    expect(result).toContain('Instance: `abc-123`');
    expect(result).toContain('Node: `start`');
    // Should NOT contain RECOVERY (plain objects don't have agentHint)
    expect(result).not.toContain('RECOVERY:');
  });

  it('handles DAWEError without context fields gracefully', () => {
    const error = new DAWEError('R-006', 'Workflow not found', {
      category: 'runtime',
    });

    const result = formatRuntimeError(error as unknown as RuntimeError);

    expect(result).toContain('> **ERROR:** R-006');
    expect(result).toContain('Workflow not found');
    // Should NOT have Instance/Node since context is empty
    expect(result).not.toContain('Instance:');
    expect(result).not.toContain('Node:');
  });
});
