# ADR-002: jexl Expression Engine

## Context

Workflow transitions use conditional expressions (e.g., `payload.count > 5 && action_result.exit_code == 0`). The engine needs a safe, sandboxed expression evaluator. Options considered:

1. **`eval()` / `new Function()`** — Powerful but completely unsafe. Access to Node.js globals, filesystem, process.
2. **`vm2`** — Node.js VM sandbox. Complex, has had security vulnerabilities, deprecated.
3. **`expr-eval`** — Simple math expression parser. No object property access (`payload.x`), no transforms.
4. **`jexl`** — JavaScript Expression Language. Supports property access, comparisons, logical operators, custom transforms. No access to Node.js globals.

## Decision

Use **jexl** for expression evaluation.

## Consequences

- **Positive:** Safe by default — no access to `process`, `require`, `fs`, or any Node.js globals. Expressions operate only on the provided context object.
- **Positive:** Supports dot-notation property access (`payload.project_name`), array membership (`'admin' in payload.roles`), and custom transforms (`payload.name|lower`).
- **Positive:** Async evaluation with configurable timeout (default 100ms).
- **Negative:** Limited to jexl syntax — no full JavaScript. Some developers may find it restrictive.
- **Negative:** Small community compared to mainstream alternatives. However, the library is stable and well-tested.
