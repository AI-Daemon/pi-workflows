# ADR-009: Structured Extraction + File Pointers Over Raw Stdout (v2.0)

## Context

In cycle workflows, system action output (test results, lint output) must be passed to the LLM for analysis. Raw stdout can be very large (megabytes of test output) and wastes the LLM's context window.

Options:

1. **Pass raw stdout in payload** — Simple but context-window-expensive. Large outputs get truncated.
2. **Summarize output in the engine** — Complex NLP/regex logic in the engine. Fragile.
3. **Structured extraction + file pointers** — Scripts write structured JSON to a file. The engine extracts it into `payload.extracted_json`. Full output is saved to a log file referenced by `payload.log_pointer_path`.

## Decision

Use **structured extraction (`extract_json`) + file pointers** for context optimization.

## Consequences

- **Positive:** Compact, structured data in the LLM's context. `payload.extracted_json` contains only the relevant test results.
- **Positive:** Full output still accessible via file pointer for deep debugging.
- **Positive:** Graceful fallback — if JSON extraction fails, the engine falls back to the file pointer.
- **Negative:** Requires scripts to output valid JSON. Not all tools have JSON reporters.
- **Negative:** File pointer logs are ephemeral (container-local). Lost on restart. Mitigated by storing `extracted_json` in the payload.
