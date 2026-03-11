# Error Code Reference

> **Who is this for?** Workflow authors and engine developers who need to understand, diagnose, and fix DAWE errors.
>
> **What you'll learn:** Every error code, its meaning, severity, recoverability, and recovery hint.

The single source of truth for error codes is `src/utils/error-codes.ts`. This document mirrors that registry.

## Schema Errors (S-xxx)

| Code    | Message                                | Severity | Recoverable | Agent Hint |
| ------- | -------------------------------------- | -------- | ----------- | ---------- |
| `S-001` | Invalid YAML syntax                    | error    | No          | —          |
| `S-002` | Missing required field                 | error    | No          | —          |
| `S-003` | Invalid field type                     | error    | No          | —          |
| `S-004` | Invalid node reference                 | error    | No          | —          |
| `S-005` | Missing terminal node                  | error    | No          | —          |
| `S-006` | Initial node is terminal               | error    | No          | —          |
| `S-007` | Terminal node has transitions          | error    | No          | —          |
| `S-008` | Non-terminal node has no transitions   | error    | No          | —          |
| `S-009` | Invalid workflow name                  | error    | No          | —          |
| `S-010` | Duplicate workflow name                | error    | No          | —          |
| `S-011` | Invalid expression syntax in condition | error    | No          | —          |

## Graph Errors (G-xxx)

| Code    | Message                                                 | Severity | Recoverable | Agent Hint |
| ------- | ------------------------------------------------------- | -------- | ----------- | ---------- |
| `G-001` | Cycle detected (v1.0 DAG violation)                     | error    | No          | —          |
| `G-002` | Unreachable node                                        | error    | No          | —          |
| `G-003` | No path to terminal                                     | error    | No          | —          |
| `G-004` | Unbounded cycle — back-edge target missing `max_visits` | error    | No          | —          |
| `G-005` | Orphaned node                                           | error    | No          | —          |
| `G-006` | Maximum graph depth exceeded                            | error    | No          | —          |

## Expression Errors (E-xxx)

| Code    | Message                           | Severity | Recoverable | Agent Hint |
| ------- | --------------------------------- | -------- | ----------- | ---------- |
| `E-001` | Invalid expression syntax         | error    | No          | —          |
| `E-002` | Expression evaluation failed      | error    | No          | —          |
| `E-003` | Expression did not return boolean | error    | No          | —          |
| `E-004` | Expression evaluation timed out   | error    | No          | —          |
| `E-005` | Expression exceeds maximum length | error    | No          | —          |

## Runtime Errors (R-xxx)

| Code    | Message                                                  | Severity | Recoverable | Agent Hint                                                                      |
| ------- | -------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------- |
| `R-001` | No matching transition                                   | error    | Yes         | Check your payload values against the transition conditions.                    |
| `R-002` | Node mismatch                                            | error    | Yes         | You submitted data for the wrong node. Check the `current_node_id`.             |
| `R-003` | Payload validation failed                                | error    | Yes         | Your payload is missing required fields. Review the required schema.            |
| `R-004` | Instance not active                                      | error    | No          | —                                                                               |
| `R-005` | Budget exhausted — `max_visits` reached with no fallback | error    | No          | The test-fix cycle has exhausted its retry budget. Human intervention required. |
| `R-006` | Workflow not found                                       | error    | No          | —                                                                               |
| `R-007` | Instance not found                                       | error    | No          | —                                                                               |
| `R-008` | Expression evaluation failed during transition           | error    | No          | —                                                                               |
| `R-009` | System action chain exceeded maximum length              | error    | No          | —                                                                               |
| `R-010` | System action failed                                     | error    | Yes         | The system action command failed. Check the command output for details.         |

## Execution Errors (X-xxx)

| Code    | Message                            | Severity | Recoverable | Agent Hint                                                                              |
| ------- | ---------------------------------- | -------- | ----------- | --------------------------------------------------------------------------------------- |
| `X-001` | System action timed out            | error    | Yes         | The command exceeded its timeout. Consider a longer timeout or simpler command.         |
| `X-002` | System action failed               | error    | Yes         | —                                                                                       |
| `X-003` | Command blocked by security policy | error    | No          | —                                                                                       |
| `X-004` | JSON extraction failed             | warning  | Yes         | The `extract_json` file could not be parsed. Use the `log_pointer_path` for raw output. |
| `X-005` | File pointer write failed          | warning  | Yes         | —                                                                                       |

## Cycle Safety Errors (C-xxx)

| Code    | Message                                                          | Severity | Recoverable | Agent Hint                                                                           |
| ------- | ---------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------ |
| `C-001` | Stall detected — workspace state identical to previous iteration | error    | No          | You applied the same fix as a previous attempt. Workflow suspended for human review. |

## Payload Errors (P-xxx)

| Code    | Message                                                   | Severity | Recoverable | Agent Hint                                                                                  |
| ------- | --------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------- |
| `P-001` | Protected key overwrite attempt (`$metadata`)             | error    | Yes         | Your payload tried to overwrite a protected internal key.                                   |
| `P-002` | Template resolution failed                                | error    | No          | —                                                                                           |
| `P-003` | Instance file write failed                                | error    | No          | —                                                                                           |
| `P-004` | Instance directory inaccessible                           | error    | No          | —                                                                                           |
| `P-005` | Instance file corrupted — invalid JSON                    | warning  | No          | —                                                                                           |
| `P-006` | Instance recovery — workflow definition not found (stale) | warning  | No          | —                                                                                           |
| `P-007` | Instance recovery — file pointer lost (container restart) | warning  | Yes         | The raw log file was lost during restart. Use `payload.extracted_json` for structured data. |

## Searching Structured Logs by Error Code

When using JSON log format, errors can be searched with standard tools:

```bash
# Find all R-001 errors
grep '"code":"R-001"' dawe.log | jq .

# Find all errors for a specific instance
grep '"instanceId":"abc-123"' dawe.log | jq .

# Find all cycle safety errors
grep '"category":"cycle"' dawe.log | jq .

# Count errors by code
grep '"level":"error"' dawe.log | jq -r '.code' | sort | uniq -c | sort -rn
```

---

_See also: [Workflow Authoring Guide](./workflow-authoring-guide.md) · [API Reference](./api-reference.md) · [Contributing](./contributing.md)_
