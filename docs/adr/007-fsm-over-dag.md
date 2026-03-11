# ADR-007: FSM with Bounded Cycles Over Strict DAG (v2.0)

## Context

DAWE v1.0 used a strict DAG — no cycles allowed. This prevented iterative workflows like "run tests → fix failures → run tests again." Real development workflows require retry loops.

Options:

1. **Keep strict DAG** — Force workflow authors to create linear chains with explicit "retry_1", "retry_2" nodes. Verbose and inflexible.
2. **Allow unbounded cycles** — Maximum flexibility but risk of infinite loops.
3. **Allow bounded cycles with `max_visits`** — Controlled iteration with per-node budgets.

## Decision

Introduce FSM semantics in v2.0 with **bounded cycles**. Back-edges are allowed only when the target node has a `max_visits` limit. Workflows declare `version: '2.0'` to opt in.

## Consequences

- **Positive:** Natural modeling of test-fix loops, retry patterns, and iterative refinement.
- **Positive:** Per-node budgets provide fine-grained control. Workflow authors set budgets based on workflow complexity.
- **Positive:** Backward compatible — v1.0 workflows are still validated as strict DAGs.
- **Negative:** Cycles introduce complexity in graph validation, runtime tracking, and stall detection.
- **Negative:** Requires additional infrastructure: `$metadata.visits`, stall detector, `suspended` terminal status.

Reference: [DAWE PRD v2.0 Architectural Review](../prd.md)
