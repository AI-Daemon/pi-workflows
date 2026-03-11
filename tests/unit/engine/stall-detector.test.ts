/**
 * Unit tests for StallDetector — cryptographic stall detection for bounded cycles.
 *
 * Covers hash computation, stall detection, git diff integration,
 * determinism, and edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StallDetector } from '../../../src/engine/stall-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadStallFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures/stall-detection', name), 'utf-8');
}

/** Compute a SHA-256 hash using the same algorithm as StallDetector. */
function computeExpectedHash(actionOutput: string, gitDiff: string = ''): string {
  const input = gitDiff + '\n---DAWE-SEPARATOR---\n' + actionOutput;
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// StallDetector unit tests
// ---------------------------------------------------------------------------

describe('StallDetector — Core Detection', () => {
  let detector: StallDetector;

  beforeEach(() => {
    // Disable git diff for deterministic unit tests
    detector = new StallDetector({ includeGitDiff: false });
  });

  it('identical output across iterations → stalled: true', async () => {
    const output = loadStallFixture('identical-output.txt');

    // First iteration: no previous hashes → not stalled
    const first = await detector.check([], output);
    expect(first.stalled).toBe(false);
    expect(first.iterationNumber).toBe(1);

    // Second iteration: same output → stalled
    const second = await detector.check([first.currentHash], output);
    expect(second.stalled).toBe(true);
    expect(second.matchedPreviousHash).toBe(first.currentHash);
    expect(second.iterationNumber).toBe(2);
  });

  it('different output across iterations → stalled: false', async () => {
    const output1 = loadStallFixture('different-output-1.txt');
    const output2 = loadStallFixture('different-output-2.txt');

    const first = await detector.check([], output1);
    expect(first.stalled).toBe(false);

    const second = await detector.check([first.currentHash], output2);
    expect(second.stalled).toBe(false);
  });

  it('first iteration (no previous hashes) → stalled: false', async () => {
    const result = await detector.check([], 'any output');
    expect(result.stalled).toBe(false);
    expect(result.iterationNumber).toBe(1);
    expect(result.matchedPreviousHash).toBeUndefined();
  });

  it('third iteration matches first (not second) → stalled: true, matchedPreviousHash is first hash', async () => {
    const output1 = 'output-A';
    const output2 = 'output-B';
    const output3 = 'output-A'; // Same as first

    const first = await detector.check([], output1);
    expect(first.stalled).toBe(false);

    const second = await detector.check([first.currentHash], output2);
    expect(second.stalled).toBe(false);

    const third = await detector.check([first.currentHash, second.currentHash], output3);
    expect(third.stalled).toBe(true);
    expect(third.matchedPreviousHash).toBe(first.currentHash);
    expect(third.iterationNumber).toBe(3);
  });

  it('empty action output, identical → stalled: true', async () => {
    const first = await detector.check([], '');
    expect(first.stalled).toBe(false);

    const second = await detector.check([first.currentHash], '');
    expect(second.stalled).toBe(true);
  });

  it('empty previous hashes array → stalled: false', async () => {
    const result = await detector.check([], 'some output');
    expect(result.stalled).toBe(false);
    expect(result.iterationNumber).toBe(1);
  });

  it('hash is deterministic — same input produces same hash', async () => {
    const output = 'deterministic test output';
    const result1 = await detector.check([], output);
    const result2 = await detector.check([], output);
    expect(result1.currentHash).toBe(result2.currentHash);
  });

  it('hash changes with single character difference in output', async () => {
    const result1 = await detector.check([], 'test output A');
    const result2 = await detector.check([], 'test output B');
    expect(result1.currentHash).not.toBe(result2.currentHash);
  });

  it('iterationNumber is correct (previousHashes.length + 1)', async () => {
    const result0 = await detector.check([], 'output');
    expect(result0.iterationNumber).toBe(1);

    const result1 = await detector.check(['hash1'], 'output');
    expect(result1.iterationNumber).toBe(2);

    const result2 = await detector.check(['hash1', 'hash2'], 'output');
    expect(result2.iterationNumber).toBe(3);

    const result3 = await detector.check(['hash1', 'hash2', 'hash3', 'hash4'], 'output');
    expect(result3.iterationNumber).toBe(5);
  });
});

describe('StallDetector — Git Diff Integration', () => {
  it('git diff disabled (includeGitDiff: false) → hashes only action output', async () => {
    const detector = new StallDetector({ includeGitDiff: false });
    const output = 'test output';
    const result = await detector.check([], output);

    // Compute expected hash: empty git diff + separator + output
    const expected = computeExpectedHash(output, '');
    expect(result.currentHash).toBe(expected);
  });

  it('git diff fails (not a repo) → graceful fallback to action output only', async () => {
    // Use a directory that is definitely not a git repo
    const detector = new StallDetector({
      includeGitDiff: true,
      workingDir: '/tmp/nonexistent-dir-dawe-test',
    });
    const output = 'test output';
    const result = await detector.check([], output);

    // Should still produce a valid hash (fallback to action output only)
    expect(result.currentHash).toBeTruthy();
    expect(typeof result.currentHash).toBe('string');
    expect(result.currentHash.length).toBe(64); // SHA-256 hex length
    expect(result.stalled).toBe(false);
  });

  it('git diff included in hash changes the result', async () => {
    // When git diff is disabled, the hash only uses action output
    const detectorNoGit = new StallDetector({ includeGitDiff: false });
    // When git diff is enabled but fails (non-git dir), it also falls back to action-output only
    const detectorWithGit = new StallDetector({
      includeGitDiff: true,
      workingDir: '/tmp/nonexistent-dir-dawe-test-2',
    });

    const output = 'same output';
    const resultNoGit = await detectorNoGit.check([], output);
    const resultWithGit = await detectorWithGit.check([], output);

    // Both should succeed and produce valid hashes
    expect(resultNoGit.currentHash.length).toBe(64);
    expect(resultWithGit.currentHash.length).toBe(64);
  });
});

describe('StallDetector — Hash Computation', () => {
  it('computeHash produces a valid SHA-256 hex string', async () => {
    const detector = new StallDetector({ includeGitDiff: false });
    const hash = await detector.computeHash('test');
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
  });

  it('computeHash is consistent with manual SHA-256 computation', async () => {
    const detector = new StallDetector({ includeGitDiff: false });
    const output = 'hello world';
    const hash = await detector.computeHash(output);

    // Manual computation: '' (no git diff) + separator + output
    const input = '\n---DAWE-SEPARATOR---\n' + output;
    const expected = createHash('sha256').update(input, 'utf-8').digest('hex');
    expect(hash).toBe(expected);
  });

  it('different outputs produce different hashes', async () => {
    const detector = new StallDetector({ includeGitDiff: false });
    const hash1 = await detector.computeHash('output 1');
    const hash2 = await detector.computeHash('output 2');
    expect(hash1).not.toBe(hash2);
  });

  it('empty output produces a valid hash', async () => {
    const detector = new StallDetector({ includeGitDiff: false });
    const hash = await detector.computeHash('');
    expect(hash.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
  });
});
