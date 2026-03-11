# ADR-008: SHA-256 State Hashing for Stall Detection (v2.0)

## Context

Bounded cycles with `max_visits` cap total iterations, but an agent could waste all iterations applying the same fix repeatedly. We need to detect zero-progress loops and short-circuit early.

Options:

1. **Global step counter** — Simple but doesn't distinguish "making progress but slowly" from "stuck in a loop."
2. **Output diff comparison** — Compare action output between iterations. Fragile with timestamps, PIDs, etc.
3. **SHA-256 hash of workspace state** — Hash the git diff + action output. Cryptographic collision resistance ensures identical hashes mean identical states.

## Decision

Use **SHA-256 hashing** of `git diff HEAD + action output` as the stall detection mechanism.

## Consequences

- **Positive:** Cryptographic collision resistance — if hashes match, the states are identical with overwhelming probability.
- **Positive:** Fast computation. SHA-256 is built into Node.js `crypto` module.
- **Positive:** Captures both code changes (git diff) and test output (action stdout/stderr).
- **Positive:** Configurable — `includeGitDiff` can be disabled for non-git environments.
- **Negative:** False negatives if the agent makes cosmetic changes (whitespace, comments) that don't affect test results.
- **Negative:** Requires git to be available in the execution environment for full effectiveness.
