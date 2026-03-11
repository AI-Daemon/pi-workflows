/**
 * Unit tests for DAWELogger.
 *
 * Covers:
 * - JSON and pretty output formats
 * - Level filtering
 * - Context handling and child loggers
 * - Error object serialization
 * - v2.0 cycle-aware logging
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DAWELogger } from '../../../src/utils/logger.js';
import { DAWEError, CycleSafetyError, SystemActionError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Helper — capture logger output
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  code?: string;
  category?: string;
  nodeId?: string;
  instanceId?: string;
  errorMessage?: string;
  component?: string;
  visitCount?: number;
  maxVisits?: number;
  stateHash?: string;
  matchedIteration?: number;
  filePath?: string;
  parseError?: string;
  [key: string]: unknown;
}

function createCapture() {
  const lines: string[] = [];
  const output = (line: string) => {
    lines.push(line);
  };
  return { lines, output };
}

function parseLine(line: string): LogEntry {
  return JSON.parse(line) as LogEntry;
}

// ===========================================================================
// JSON format
// ===========================================================================

describe('DAWELogger — JSON format', () => {
  let capture: ReturnType<typeof createCapture>;
  let logger: DAWELogger;

  beforeEach(() => {
    capture = createCapture();
    logger = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });
  });

  it('JSON format produces valid JSON to stdout', () => {
    logger.info('Test message');
    expect(capture.lines).toHaveLength(1);
    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Test message');
    expect(parsed.timestamp).toBeDefined();
  });

  it('context included in output', () => {
    logger.info('Node entered', { nodeId: 'start', instanceId: 'abc-123' });
    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.nodeId).toBe('start');
    expect(parsed.instanceId).toBe('abc-123');
  });

  it('error objects serialized correctly', () => {
    const err = new DAWEError('R-001', 'No matching transition', {
      context: { nodeId: 'decide' },
    });
    logger.error('Transition failed', err);

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.level).toBe('error');
    expect(parsed.code).toBe('R-001');
    expect(parsed.category).toBe('runtime');
    expect(parsed.nodeId).toBe('decide');
  });

  it('plain Error objects include errorMessage', () => {
    const err = new Error('Something went wrong');
    logger.error('Unexpected error', err);

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.errorMessage).toBe('Something went wrong');
  });

  it('timestamp included in all entries', () => {
    logger.debug('Debug msg');
    logger.info('Info msg');
    logger.warn('Warn msg');
    logger.error('Error msg');

    for (const line of capture.lines) {
      const parsed = parseLine(line);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ===========================================================================
// Pretty format
// ===========================================================================

describe('DAWELogger — Pretty format', () => {
  it('pretty format produces human-readable text', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'pretty', output: capture.output });

    logger.info('Node entered', { nodeId: 'start' });

    expect(capture.lines[0]).toMatch(/\[[\d:.]+\] INFO\s+Node entered/);
    expect(capture.lines[0]).toContain('nodeId: start');
  });

  it('pretty format shows error code in parentheses', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'pretty', output: capture.output });

    const err = new DAWEError('S-001', 'Invalid YAML');
    logger.error('Schema error', err);

    expect(capture.lines[0]).toContain('(S-001)');
  });
});

// ===========================================================================
// Level filtering
// ===========================================================================

describe('DAWELogger — Level filtering', () => {
  it('log level filtering works (debug suppressed at info level)', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'info', format: 'json', output: capture.output });

    logger.debug('Should be suppressed');
    logger.info('Should appear');

    expect(capture.lines).toHaveLength(1);
    expect(parseLine(capture.lines[0]!).message).toBe('Should appear');
  });

  it('warn level suppresses debug and info', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'warn', format: 'json', output: capture.output });

    logger.debug('No');
    logger.info('No');
    logger.warn('Yes');
    logger.error('Yes');

    expect(capture.lines).toHaveLength(2);
  });

  it('error level only shows errors', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'error', format: 'json', output: capture.output });

    logger.debug('No');
    logger.info('No');
    logger.warn('No');
    logger.error('Yes');

    expect(capture.lines).toHaveLength(1);
  });
});

// ===========================================================================
// Child loggers
// ===========================================================================

describe('DAWELogger — Child loggers', () => {
  it('child logger inherits parent context', () => {
    const capture = createCapture();
    const parent = new DAWELogger({
      level: 'debug',
      format: 'json',
      output: capture.output,
      context: { component: 'runtime' },
    });

    const child = parent.child({ instanceId: 'abc-123' });
    child.info('Test');

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.component).toBe('runtime');
    expect(parsed.instanceId).toBe('abc-123');
  });

  it('child logger adds its own context', () => {
    const capture = createCapture();
    const parent = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });
    const child = parent.child({ nodeId: 'run_tests' });

    child.info('Entered');

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.nodeId).toBe('run_tests');
  });

  it('child context overrides parent context for same key', () => {
    const capture = createCapture();
    const parent = new DAWELogger({
      level: 'debug',
      format: 'json',
      output: capture.output,
      context: { component: 'runtime' },
    });
    const child = parent.child({ component: 'executor' });

    child.info('Test');

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.component).toBe('executor');
  });
});

// ===========================================================================
// v2.0 cycle logging
// ===========================================================================

describe('DAWELogger — v2.0 cycle-aware logging', () => {
  it('stall detection log entry includes visitCount, maxVisits, stateHash', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });

    const err = new CycleSafetyError('C-001', 'Stall detected', {
      context: {
        nodeId: 'run_tests',
        visitCount: 2,
        maxVisits: 3,
        stateHash: 'sha256:a1b2c3',
        matchedIteration: 1,
      },
    });

    logger.error('Stall detected', err, { instanceId: 'abc-123' });

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.visitCount).toBe(2);
    expect(parsed.maxVisits).toBe(3);
    expect(parsed.stateHash).toBe('sha256:a1b2c3');
    expect(parsed.matchedIteration).toBe(1);
    expect(parsed.instanceId).toBe('abc-123');
    expect(parsed.code).toBe('C-001');
    expect(parsed.category).toBe('cycle');
  });

  it('budget exhaustion log entry includes nodeId, visitCount, maxVisits', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });

    const err = new DAWEError('R-005', 'Budget exhausted', {
      context: { nodeId: 'run_tests', visitCount: 3, maxVisits: 3 },
    });

    logger.error('Budget exhausted', err);

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.nodeId).toBe('run_tests');
    expect(parsed.visitCount).toBe(3);
    expect(parsed.maxVisits).toBe(3);
  });

  it('JSON extraction warning includes file path and parse error', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });

    const err = new SystemActionError('X-004', 'JSON extraction failed', {
      severity: 'warning',
      context: { filePath: '/tmp/dawe-runs/test.json', parseError: 'Unexpected token' },
    });

    logger.error('JSON extraction failed', err);

    const parsed = parseLine(capture.lines[0]!);
    expect(parsed.filePath).toBe('/tmp/dawe-runs/test.json');
    expect(parsed.parseError).toBe('Unexpected token');
    expect(parsed.code).toBe('X-004');
  });
});

// ===========================================================================
// Logger integration (verify logging actually happens)
// ===========================================================================

describe('DAWELogger — integration verification', () => {
  it('all four log levels produce output when level is debug', () => {
    const capture = createCapture();
    const logger = new DAWELogger({ level: 'debug', format: 'json', output: capture.output });

    logger.debug('Debug');
    logger.info('Info');
    logger.warn('Warn');
    logger.error('Error');

    expect(capture.lines).toHaveLength(4);
    expect(parseLine(capture.lines[0]!).level).toBe('debug');
    expect(parseLine(capture.lines[1]!).level).toBe('info');
    expect(parseLine(capture.lines[2]!).level).toBe('warn');
    expect(parseLine(capture.lines[3]!).level).toBe('error');
  });
});
