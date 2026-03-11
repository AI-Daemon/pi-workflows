# ADR-005: Vitest Over Jest

## Context

DAWE needs a test runner for unit, integration, and e2e tests. Options:

1. **Jest** — Industry standard, huge ecosystem. But ESM support is experimental and buggy. Requires transforms for TypeScript.
2. **Vitest** — ESM-native, fast, Vite-powered, compatible API with Jest.
3. **Node.js test runner** — Built-in, no dependencies. But immature assertion library, limited reporter ecosystem.

## Decision

Use **Vitest** as the test runner.

## Consequences

- **Positive:** Native ESM support. No transforms needed for TypeScript with `vitest`.
- **Positive:** Jest-compatible API (`describe`, `it`, `expect`). Low migration cost.
- **Positive:** Fast — uses Vite's module resolution and caching.
- **Positive:** Workspace support (`vitest.workspace.ts`) for separating unit/integration/e2e.
- **Negative:** Smaller ecosystem than Jest. Some Jest plugins don't have Vitest equivalents.
