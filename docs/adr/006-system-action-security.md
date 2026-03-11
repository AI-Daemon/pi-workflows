# ADR-006: System Action Security Model

## Context

`system_action` nodes execute bash/Node.js commands natively. This is powerful but dangerous. The engine must prevent workflow definitions from executing destructive commands and prevent payload injection attacks.

## Decision

Implement a multi-layer security model:

1. **Template-level:** All `{{payload.x}}` values are auto-shell-escaped. Unescaped access requires explicit `{{{raw_payload.x}}}`.
2. **Command-level:** `SecurityValidator` blocks dangerous patterns (`rm -rf /`, `curl | sh`, `eval`, `exec`, etc.) on the raw command template (before variable resolution).
3. **Process-level:** `spawn()` with `detached: true` for clean process group kill. SIGTERM → 5s grace → SIGKILL.
4. **Output-level:** stdout capped at 1MB, stderr at 256KB.

## Consequences

- **Positive:** Payload values cannot escape their shell quoting context (injection prevention).
- **Positive:** Known dangerous commands are blocked at the template level.
- **Positive:** Timeouts and output limits prevent resource exhaustion.
- **Negative:** Security validation is pattern-based, not a true sandbox. Sufficiently creative commands may bypass patterns. The engine trusts the workflow author to some degree.
