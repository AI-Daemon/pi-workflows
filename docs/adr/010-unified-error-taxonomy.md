# ADR-010: Unified Error Taxonomy with Error Code Registry (DAWE-012)

## Context

Before DAWE-012, each engine module had its own error interface:

- `RuntimeError` (plain object with `code` + `message`)
- `ExpressionError` (code + message + expression)
- `SecurityError` (code + message + command)
- `GraphValidationError` (code + message + nodeIds)

This created several problems:

1. **Inconsistent error shapes** — Callers needed different handling for each module's errors.
2. **No agent recovery hints** — Errors didn't tell the LLM how to self-correct.
3. **No structured logging** — Errors were logged as strings, not structured JSON.
4. **No centralized code registry** — Error codes were scattered across modules with no single source of truth.

## Decision

Implement a **unified `DAWEError` hierarchy** with a **centralized error code registry**:

- Single `DAWEError` base class with 8 category-specific subclasses
- `ERROR_CODES` registry in `src/utils/error-codes.ts` as the single source of truth
- Every error carries `code`, `category`, `severity`, `recoverable`, `agentHint`, `context`
- Dual-output contract: `toJSON()` for machines, `toAgentMessage()` for the LLM
- `ErrorCollector` for multi-error validation pipelines
- `DAWELogger` for structured JSON/pretty logging with child loggers

## Consequences

- **Positive:** Every error is grep-able by code (`grep 'R-001' dawe.log`).
- **Positive:** Agent can self-recover via `agentHint` — the LLM reads the hint and adjusts.
- **Positive:** Error codes are documented, stable, and versioned. Breaking changes require new codes.
- **Positive:** Structured logging enables log aggregation and alerting in production.
- **Negative:** Larger error infrastructure. Contributors must learn the subclass hierarchy and registry.
- **Negative:** Backward compatibility requires keeping the old `RuntimeError` interface alongside `DAWEError`.

Reference: [DAWE-012 PR #52](https://github.com/AI-Daemon/pi-workflows/pull/52)
