/**
 * JSON Extractor — Parses structured JSON output from `extract_json` files.
 *
 * `system_action` nodes can specify an `extract_json` file path where the
 * command writes structured JSON (e.g., `npm test -- --reporter=json`).
 * This module reads that file, parses the JSON, and returns a structured
 * result for merging into `payload.extracted_json`.
 *
 * On failure (file not found, invalid JSON, empty file, permission denied),
 * returns a graceful error result with `fallbackToPointer: true` — the
 * engine should fall back to `payload.log_pointer_path` for the LLM.
 *
 * Never throws.
 */

import { readFile, access, constants } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a JSON extraction attempt. */
export interface JsonExtractionResult {
  /** Whether the JSON was successfully parsed. */
  success: boolean;
  /** Parsed JSON data (when success is true). */
  data?: Record<string, unknown>;
  /** Error description (when success is false). */
  error?: string;
  /** Whether the agent should fall back to the log pointer. */
  fallbackToPointer: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file at the given path.
 *
 * @param filePath - Absolute or relative path to the JSON output file.
 * @returns A `JsonExtractionResult` — never throws.
 */
export async function extractJson(filePath: string): Promise<JsonExtractionResult> {
  // 1. Check file exists and is readable
  try {
    await access(filePath, constants.R_OK);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${filePath}`,
        fallbackToPointer: true,
      };
    }
    if (code === 'EACCES') {
      return {
        success: false,
        error: `Permission denied: ${filePath}`,
        fallbackToPointer: true,
      };
    }
    return {
      success: false,
      error: `Cannot access file: ${filePath} (${code ?? 'unknown error'})`,
      fallbackToPointer: true,
    };
  }

  // 2. Read file contents
  let content: string;
  try {
    const buffer = await readFile(filePath);
    content = buffer.toString('utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to read file: ${message}`,
      fallbackToPointer: true,
    };
  }

  // 3. Strip BOM if present (UTF-8 BOM: 0xEF 0xBB 0xBF)
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  // 4. Trim whitespace
  content = content.trim();

  // 5. Check for empty file
  if (content.length === 0) {
    return {
      success: false,
      error: `Empty file: ${filePath}`,
      fallbackToPointer: true,
    };
  }

  // 6. Parse JSON
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      return {
        success: true,
        data: parsed as Record<string, unknown>,
        fallbackToPointer: false,
      };
    }
    // Primitive JSON values (string, number, boolean) — wrap in a data envelope
    return {
      success: true,
      data: { value: parsed } as Record<string, unknown>,
      fallbackToPointer: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Invalid JSON in ${filePath}: ${message}`,
      fallbackToPointer: true,
    };
  }
}
