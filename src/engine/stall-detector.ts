/**
 * Stall Detector — Cryptographic idempotency trap for bounded cycles.
 *
 * Before the runtime traverses a back-edge (cycle transition), it computes
 * a SHA-256 hash of the current workspace state (git diff + action output).
 * If this hash matches any previous iteration's hash, the agent has made
 * **zero functional progress** and the engine halts the loop immediately.
 *
 * This is the final safety layer in the DAWE loop protection stack:
 * 1. Schema validation (DAWE-014): Requires `max_visits` on cycle targets.
 * 2. Budget enforcement (DAWE-015): Caps total iterations per node.
 * 3. Stall detection (this module): Detects no-progress loops and short-circuits.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Separator between git diff and action output in the hash input. */
const HASH_SEPARATOR = '\n---DAWE-SEPARATOR---\n';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration options for the StallDetector. */
export interface StallDetectorOptions {
  /** Working directory for git operations (default: process.cwd()). */
  workingDir?: string;
  /** Whether to include git diff in hash (default: true). Set false in non-git environments. */
  includeGitDiff?: boolean;
}

/** Result of a stall check operation. */
export interface StallCheckResult {
  /** Whether a stall was detected (current hash matches a previous one). */
  stalled: boolean;
  /** The SHA-256 hash of the current workspace state. */
  currentHash: string;
  /** The hash it matched, if stalled. */
  matchedPreviousHash?: string;
  /** Which iteration this is (previousHashes.length + 1). */
  iterationNumber: number;
}

// ---------------------------------------------------------------------------
// StallDetector
// ---------------------------------------------------------------------------

export class StallDetector {
  private readonly workingDir: string;
  private readonly includeGitDiff: boolean;

  constructor(options?: StallDetectorOptions) {
    this.workingDir = options?.workingDir ?? process.cwd();
    this.includeGitDiff = options?.includeGitDiff ?? true;
  }

  /**
   * Compute a workspace state hash and compare against previous hashes.
   *
   * @param previousHashes - Hashes from prior cycle iterations ($metadata.state_hashes).
   * @param actionOutput - The stdout/stderr from the most recent system_action.
   * @returns StallCheckResult indicating whether progress was made.
   */
  async check(previousHashes: string[], actionOutput: string): Promise<StallCheckResult> {
    const currentHash = await this.computeHash(actionOutput);
    const iterationNumber = previousHashes.length + 1;

    // Check if the current hash matches any previous hash
    const matchedPreviousHash = previousHashes.find((h) => h === currentHash);

    if (matchedPreviousHash !== undefined) {
      return {
        stalled: true,
        currentHash,
        matchedPreviousHash,
        iterationNumber,
      };
    }

    return {
      stalled: false,
      currentHash,
      iterationNumber,
    };
  }

  /**
   * Compute a SHA-256 hash of the workspace state.
   *
   * The hash input is: `gitDiffOutput + SEPARATOR + actionOutput`.
   * If git diff is disabled or fails, only the action output is hashed.
   *
   * @param actionOutput - The stdout/stderr from the most recent system_action.
   * @returns Hex-encoded SHA-256 hash string.
   */
  async computeHash(actionOutput: string): Promise<string> {
    let input = '';

    if (this.includeGitDiff) {
      try {
        const gitDiff = await execAsync('git diff HEAD', {
          cwd: this.workingDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB max for large diffs
        });
        input += gitDiff.stdout;
      } catch {
        // Not a git repo or git not available — skip git diff
      }
    }

    input += HASH_SEPARATOR + actionOutput;

    return createHash('sha256').update(input, 'utf-8').digest('hex');
  }
}
