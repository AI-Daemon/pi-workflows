/**
 * Shared E2E test teardown — cleanup temp files and processes.
 */

import { readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Clean up temp files created by E2E test scripts.
 * Removes files matching the pattern `dawe-e2e-*`.
 */
export async function cleanupTempFiles(): Promise<void> {
  const tempDir = tmpdir();
  try {
    const entries = await readdir(tempDir);
    const daweFiles = entries.filter((f) => f.startsWith('dawe-e2e-'));
    await Promise.all(daweFiles.map((f) => unlink(join(tempDir, f)).catch(() => {})));
  } catch {
    // Temp directory might not be accessible — ignore
  }
}
