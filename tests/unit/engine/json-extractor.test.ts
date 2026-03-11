/**
 * Unit tests for the JSON Extractor module.
 *
 * Tests cover: valid JSON parsing, invalid JSON, empty files,
 * file not found, large files, nested objects, arrays, BOM handling,
 * trailing whitespace, and permission errors.
 *
 * Target: >= 90% line coverage, >= 85% branch coverage.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractJson } from '../../../src/engine/json-extractor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(import.meta.dirname, '../../fixtures/json-outputs');
const TMP_DIR = join(tmpdir(), 'dawe-json-extractor-tests');

function ensureTmpDir(): void {
  mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir(): void {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

afterEach(() => {
  cleanTmpDir();
});

// ===========================================================================
// extractJson tests
// ===========================================================================

describe('extractJson', () => {
  it('parses a valid JSON file and returns structured data', async () => {
    const result = await extractJson(join(FIXTURES_DIR, 'valid-test-results.json'));
    expect(result.success).toBe(true);
    expect(result.fallbackToPointer).toBe(false);
    expect(result.data).toBeDefined();
    expect(result.data!['numTotalTests']).toBe(10);
    expect(result.data!['numFailedTests']).toBe(2);
    expect(Array.isArray(result.data!['testResults'])).toBe(true);
  });

  it('returns error for invalid JSON file', async () => {
    const result = await extractJson(join(FIXTURES_DIR, 'invalid-json.txt'));
    expect(result.success).toBe(false);
    expect(result.fallbackToPointer).toBe(true);
    expect(result.error).toContain('Invalid JSON');
  });

  it('returns error for empty file', async () => {
    const result = await extractJson(join(FIXTURES_DIR, 'empty-file.json'));
    expect(result.success).toBe(false);
    expect(result.fallbackToPointer).toBe(true);
    expect(result.error).toContain('Empty file');
  });

  it('returns error for file not found', async () => {
    const result = await extractJson('/nonexistent/path/file.json');
    expect(result.success).toBe(false);
    expect(result.fallbackToPointer).toBe(true);
    expect(result.error).toContain('File not found');
  });

  it('parses a large JSON file (>1MB) successfully', async () => {
    ensureTmpDir();
    const largePath = join(TMP_DIR, 'large.json');
    // Create a ~1.5MB JSON file
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 10000; i++) {
      largeObj[`key_${i}`] = `value_${'x'.repeat(100)}_${i}`;
    }
    writeFileSync(largePath, JSON.stringify(largeObj), 'utf-8');

    const result = await extractJson(largePath);
    expect(result.success).toBe(true);
    expect(result.fallbackToPointer).toBe(false);
    expect(result.data).toBeDefined();
    expect(Object.keys(result.data!).length).toBe(10000);
  });

  it('preserves full structure of nested objects', async () => {
    ensureTmpDir();
    const nestedPath = join(TMP_DIR, 'nested.json');
    const nested = {
      level1: {
        level2: {
          level3: {
            value: 'deep',
            array: [1, 2, 3],
          },
        },
      },
    };
    writeFileSync(nestedPath, JSON.stringify(nested), 'utf-8');

    const result = await extractJson(nestedPath);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(nested);
  });

  it('parses JSON array and returns it in data field', async () => {
    ensureTmpDir();
    const arrayPath = join(TMP_DIR, 'array.json');
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    writeFileSync(arrayPath, JSON.stringify(arr), 'utf-8');

    const result = await extractJson(arrayPath);
    expect(result.success).toBe(true);
    // Arrays are objects in JS, so they should be returned as data
    expect(result.data).toEqual(arr);
  });

  it('strips BOM and parses correctly', async () => {
    ensureTmpDir();
    const bomPath = join(TMP_DIR, 'bom.json');
    const bom = '\uFEFF';
    const json = { hello: 'world' };
    writeFileSync(bomPath, bom + JSON.stringify(json), 'utf-8');

    const result = await extractJson(bomPath);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(json);
  });

  it('handles trailing whitespace and newlines', async () => {
    ensureTmpDir();
    const wsPath = join(TMP_DIR, 'whitespace.json');
    writeFileSync(wsPath, '  \n  {"key": "value"}  \n\n  ', 'utf-8');

    const result = await extractJson(wsPath);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ key: 'value' });
  });

  it('returns error for permission denied', async () => {
    // Skip on Windows or if running as root
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // Running as root — can't test permission denied, use a mock approach
      // Create a directory (not a file) at the path to trigger a read error
      ensureTmpDir();
      const dirPath = join(TMP_DIR, 'not-a-file');
      mkdirSync(dirPath, { recursive: true });
      const result = await extractJson(dirPath);
      expect(result.success).toBe(false);
      expect(result.fallbackToPointer).toBe(true);
      return;
    }

    ensureTmpDir();
    const noReadPath = join(TMP_DIR, 'no-read.json');
    writeFileSync(noReadPath, '{"key": "value"}', 'utf-8');
    chmodSync(noReadPath, 0o000);

    const result = await extractJson(noReadPath);
    expect(result.success).toBe(false);
    expect(result.fallbackToPointer).toBe(true);
    expect(result.error).toContain('Permission denied');

    // Restore permissions for cleanup
    chmodSync(noReadPath, 0o644);
  });

  it('handles primitive JSON values by wrapping in data envelope', async () => {
    ensureTmpDir();
    const primPath = join(TMP_DIR, 'primitive.json');
    writeFileSync(primPath, '"just a string"', 'utf-8');

    const result = await extractJson(primPath);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 'just a string' });
  });

  it('handles JSON with numeric primitive', async () => {
    ensureTmpDir();
    const numPath = join(TMP_DIR, 'number.json');
    writeFileSync(numPath, '42', 'utf-8');

    const result = await extractJson(numPath);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 42 });
  });
});
