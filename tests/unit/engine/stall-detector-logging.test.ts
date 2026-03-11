/**
 * Tests for DAWE-018: StallDetector structured logging integration.
 *
 * Verifies that the stall detector logs hash computation at debug level.
 */

import { describe, it, expect } from 'vitest';
import { StallDetector } from '../../../src/engine/stall-detector.js';
import { DAWELogger } from '../../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  message: string;
  [key: string]: unknown;
}

function createLoggingDetector(): { detector: StallDetector; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const logger = new DAWELogger({
    level: 'debug',
    format: 'json',
    output: (line: string) => {
      try {
        logs.push(JSON.parse(line) as LogEntry);
      } catch {
        // ignore
      }
    },
  });
  const detector = new StallDetector({
    includeGitDiff: false,
    logger,
  });
  return { detector, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StallDetector — Structured Logging (DAWE-018)', () => {
  it('logs hash computation at debug level', async () => {
    const { detector, logs } = createLoggingDetector();

    await detector.check([], 'test action output');

    const hashLog = logs.find((l) => l.level === 'debug' && l.message === 'Stall check: hash computed');
    expect(hashLog).toBeDefined();
    expect(hashLog!['iterationNumber']).toBe(1);
    expect(hashLog!['previousHashCount']).toBe(0);
    expect(typeof hashLog!['currentHash']).toBe('string');
  });

  it('logs stall detection as warning when hash matches', async () => {
    const { detector, logs } = createLoggingDetector();

    // First check to get the hash
    const first = await detector.check([], 'same output');
    // Second check with same output and first hash in previous
    await detector.check([first.currentHash], 'same output');

    const stallLog = logs.find((l) => l.level === 'warn' && l.message.includes('Stall detected'));
    expect(stallLog).toBeDefined();
    expect(stallLog!['code']).toBe('C-001');
  });
});
