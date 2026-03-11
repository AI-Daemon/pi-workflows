/**
 * Unit tests for the unified error hierarchy.
 *
 * Covers:
 * - DAWEError base class construction, serialization, agent messaging
 * - Category-specific subclasses (SchemaValidationError, CycleSafetyError, etc.)
 * - Error code registry integration
 * - ErrorCollector utility
 */

import { describe, it, expect } from 'vitest';
import {
  DAWEError,
  SchemaValidationError,
  GraphValidationError,
  ExpressionEvaluationError,
  PayloadError,
  SystemActionError,
  RuntimeError,
  SecurityViolationError,
  CycleSafetyError,
} from '../../../src/utils/errors.js';
import { ERROR_CODES, getErrorCodeEntry } from '../../../src/utils/error-codes.js';
import type { ErrorCode } from '../../../src/utils/error-codes.js';
import { ErrorCollector } from '../../../src/utils/error-collector.js';

// ===========================================================================
// DAWEError base class
// ===========================================================================

describe('DAWEError — base class', () => {
  it('constructor sets all fields correctly', () => {
    const err = new DAWEError('R-001', 'No matching transition', {
      category: 'runtime',
      severity: 'error',
      recoverable: true,
      agentHint: 'Check your payload.',
      context: { instanceId: 'abc-123', nodeId: 'decide' },
    });

    expect(err.code).toBe('R-001');
    expect(err.message).toBe('No matching transition');
    expect(err.category).toBe('runtime');
    expect(err.severity).toBe('error');
    expect(err.recoverable).toBe(true);
    expect(err.agentHint).toBe('Check your payload.');
    expect(err.context).toEqual({ instanceId: 'abc-123', nodeId: 'decide' });
    expect(err.name).toBe('DAWEError');
    expect(err).toBeInstanceOf(Error);
  });

  it('fills defaults from error code registry when options are omitted', () => {
    const err = new DAWEError('R-001', 'Test message');

    expect(err.category).toBe('runtime'); // from registry
    expect(err.recoverable).toBe(true); // from registry
    expect(err.agentHint).toBeDefined(); // from registry
  });

  it('toJSON() produces valid serializable object', () => {
    const err = new DAWEError('S-001', 'Invalid YAML syntax', {
      context: { path: 'nodes.assess' },
    });

    const json = err.toJSON();

    expect(json.code).toBe('S-001');
    expect(json.message).toBe('Invalid YAML syntax');
    expect(json.category).toBe('schema');
    expect(json.severity).toBe('error');
    expect(json.recoverable).toBe(false);
    expect(json.context).toEqual({ path: 'nodes.assess' });
    // Should be serializable
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('toAgentMessage() produces human-readable string', () => {
    const err = new DAWEError('R-003', 'Payload validation failed', {
      context: { nodeId: 'assess_intent' },
    });

    const msg = err.toAgentMessage();

    expect(msg).toContain('ERROR (R-003)');
    expect(msg).toContain('Payload validation failed');
    expect(msg).toContain('nodeId: assess_intent');
  });

  it('toAgentMessage() includes recovery hint when available', () => {
    const err = new DAWEError('R-001', 'No matching transition', {
      agentHint: 'Check your payload values against the transition conditions.',
    });

    const msg = err.toAgentMessage();

    expect(msg).toContain('RECOVERY:');
    expect(msg).toContain('Check your payload values');
  });

  it('toAgentMessage() omits recovery hint when not available', () => {
    const err = new DAWEError('G-001', 'Cycle detected', {
      recoverable: false,
    });

    const msg = err.toAgentMessage();

    expect(msg).not.toContain('RECOVERY:');
  });

  it('defaults to system category and error severity when code is not in registry', () => {
    const err = new DAWEError('UNKNOWN-999', 'Something unexpected');

    expect(err.category).toBe('system');
    expect(err.severity).toBe('error');
    expect(err.recoverable).toBe(false);
  });
});

// ===========================================================================
// Category-specific subclasses
// ===========================================================================

describe('Error subclasses — category auto-set', () => {
  it('SchemaValidationError sets category: schema', () => {
    const err = new SchemaValidationError('S-001', 'Invalid YAML');
    expect(err.category).toBe('schema');
    expect(err.name).toBe('SchemaValidationError');
    expect(err).toBeInstanceOf(DAWEError);
  });

  it('GraphValidationError sets category: graph', () => {
    const err = new GraphValidationError('G-001', 'Cycle detected');
    expect(err.category).toBe('graph');
    expect(err.name).toBe('GraphValidationError');
  });

  it('ExpressionEvaluationError sets category: expression', () => {
    const err = new ExpressionEvaluationError('E-001', 'Invalid syntax');
    expect(err.category).toBe('expression');
    expect(err.name).toBe('ExpressionEvaluationError');
  });

  it('PayloadError sets category: payload', () => {
    const err = new PayloadError('P-001', 'Protected key overwrite');
    expect(err.category).toBe('payload');
    expect(err.name).toBe('PayloadError');
  });

  it('SystemActionError sets category: execution', () => {
    const err = new SystemActionError('X-001', 'Timed out');
    expect(err.category).toBe('execution');
    expect(err.name).toBe('SystemActionError');
  });

  it('RuntimeError sets category: runtime', () => {
    const err = new RuntimeError('R-004', 'Instance not active');
    expect(err.category).toBe('runtime');
    expect(err.name).toBe('RuntimeError');
  });

  it('SecurityViolationError sets category: security', () => {
    const err = new SecurityViolationError('X-003', 'Blocked command');
    expect(err.category).toBe('security');
    expect(err.name).toBe('SecurityViolationError');
  });

  it('CycleSafetyError sets category: cycle', () => {
    const err = new CycleSafetyError('C-001', 'Stall detected');
    expect(err.category).toBe('cycle');
    expect(err.name).toBe('CycleSafetyError');
  });
});

// ===========================================================================
// v2.0 error subclasses — detailed context
// ===========================================================================

describe('v2.0 error subclasses — context fields', () => {
  it('CycleSafetyError with C-001 includes stall hash and iteration in context', () => {
    const err = new CycleSafetyError('C-001', 'Stall detected', {
      context: {
        stateHash: 'sha256:abc123',
        matchedIteration: 1,
        nodeId: 'run_tests',
        visitCount: 2,
      },
    });

    expect(err.context['stateHash']).toBe('sha256:abc123');
    expect(err.context['matchedIteration']).toBe(1);
    expect(err.toAgentMessage()).toContain('stateHash: sha256:abc123');
  });

  it('GraphValidationError with G-004 includes the unbounded cycle node ID', () => {
    const err = new GraphValidationError('G-004', 'Unbounded cycle — back-edge target missing max_visits', {
      context: { nodeId: 'run_tests' },
    });

    expect(err.context['nodeId']).toBe('run_tests');
    expect(err.code).toBe('G-004');
  });

  it('RuntimeError with R-005 includes visit count and max_visits in context', () => {
    const err = new RuntimeError('R-005', 'Budget exhausted', {
      context: { visitCount: 3, maxVisits: 3, nodeId: 'run_tests' },
    });

    expect(err.context['visitCount']).toBe(3);
    expect(err.context['maxVisits']).toBe(3);
    expect(err.recoverable).toBe(false); // from registry
  });

  it('subclass includes category-specific context', () => {
    const err = new SchemaValidationError('S-002', 'Missing required field', {
      context: { path: 'nodes.start', field: 'instruction' },
    });

    expect(err.context['path']).toBe('nodes.start');
    expect(err.context['field']).toBe('instruction');
  });
});

// ===========================================================================
// Error code registry
// ===========================================================================

describe('Error code registry', () => {
  it('all codes have unique keys', () => {
    const keys = Object.keys(ERROR_CODES);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all codes have message and category fields', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(entry.message, `${code} missing message`).toBeTruthy();
      expect(entry.category, `${code} missing category`).toBeTruthy();
    }
  });

  it('recoverable codes have agentHint', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      if (entry.recoverable && entry.agentHint !== undefined) {
        expect(entry.agentHint, `${code} recoverable but no agentHint`).toBeTruthy();
      }
    }
  });

  it('code prefix matches category', () => {
    const prefixMap: Record<string, string[]> = {
      S: ['schema'],
      G: ['graph'],
      E: ['expression'],
      R: ['runtime'],
      X: ['execution', 'security'], // X-003 is security
      C: ['cycle'],
      P: ['payload'],
    };

    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      const prefix = code.split('-')[0]!;
      const allowed = prefixMap[prefix];
      expect(allowed, `Unknown prefix ${prefix} for code ${code}`).toBeDefined();
      expect(
        allowed!.includes(entry.category),
        `${code} has category "${entry.category}" but prefix "${prefix}" expects one of: ${allowed!.join(', ')}`,
      ).toBe(true);
    }
  });

  it('v2.0 codes are present and well-formed', () => {
    const v2Codes: ErrorCode[] = ['G-004', 'R-005', 'X-004', 'X-005', 'C-001'];
    for (const code of v2Codes) {
      const entry = getErrorCodeEntry(code);
      expect(entry, `${code} not found in registry`).toBeDefined();
      expect(entry!.message).toBeTruthy();
    }
  });

  it('getErrorCodeEntry returns undefined for unknown code', () => {
    expect(getErrorCodeEntry('Z-999')).toBeUndefined();
  });
});

// ===========================================================================
// ErrorCollector
// ===========================================================================

describe('ErrorCollector', () => {
  it('empty collector → hasErrors() false', () => {
    const collector = new ErrorCollector();
    expect(collector.hasErrors()).toBe(false);
    expect(collector.getErrors()).toEqual([]);
  });

  it('add single error → hasErrors() true', () => {
    const collector = new ErrorCollector();
    collector.add(new DAWEError('S-001', 'Invalid YAML'));
    expect(collector.hasErrors()).toBe(true);
    expect(collector.getErrors()).toHaveLength(1);
  });

  it('add multiple errors → getErrors() returns all', () => {
    const collector = new ErrorCollector();
    collector.add(new DAWEError('S-001', 'Error 1'));
    collector.add(new DAWEError('S-002', 'Error 2'));
    collector.add(new DAWEError('G-001', 'Error 3'));
    expect(collector.getErrors()).toHaveLength(3);
  });

  it('hasFatal() → true only when fatal error present', () => {
    const collector = new ErrorCollector();
    collector.add(new DAWEError('S-001', 'Non-fatal'));
    expect(collector.hasFatal()).toBe(false);

    collector.add(new DAWEError('FATAL-1', 'Fatal error', { severity: 'fatal' }));
    expect(collector.hasFatal()).toBe(true);
  });

  it('getByCategory() filters correctly', () => {
    const collector = new ErrorCollector();
    collector.add(new SchemaValidationError('S-001', 'Schema err'));
    collector.add(new GraphValidationError('G-001', 'Graph err'));
    collector.add(new CycleSafetyError('C-001', 'Cycle err'));
    collector.add(new SchemaValidationError('S-002', 'Schema err 2'));

    expect(collector.getByCategory('schema')).toHaveLength(2);
    expect(collector.getByCategory('graph')).toHaveLength(1);
    expect(collector.getByCategory('cycle')).toHaveLength(1);
    expect(collector.getByCategory('runtime')).toHaveLength(0);
  });

  it('toResult() with no errors → ok: true', () => {
    const collector = new ErrorCollector();
    const result = collector.toResult('success');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('success');
    }
  });

  it('toResult() with errors → ok: false', () => {
    const collector = new ErrorCollector();
    collector.add(new DAWEError('S-001', 'Error'));
    const result = collector.toResult('data');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
    }
  });

  it('toSummary() produces readable multi-error summary', () => {
    const collector = new ErrorCollector();
    collector.add(new DAWEError('S-001', 'Invalid YAML'));
    collector.add(new DAWEError('G-002', 'Unreachable node', { severity: 'warning' }));

    const summary = collector.toSummary();
    expect(summary).toContain('2 error(s)');
    expect(summary).toContain('[S-001]');
    expect(summary).toContain('[G-002]');
    expect(summary).toContain('(warning)');
  });

  it('empty collector toSummary() → "No errors."', () => {
    const collector = new ErrorCollector();
    expect(collector.toSummary()).toBe('No errors.');
  });
});
