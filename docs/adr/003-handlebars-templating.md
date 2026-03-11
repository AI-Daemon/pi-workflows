# ADR-003: Handlebars Templating

## Context

Node instructions and system action commands need to inject payload values at runtime. The engine needs a templating system that is safe, well-known, and supports basic helpers.

Options considered:

1. **Template literals** (`` `${payload.x}` ``) — Requires `eval()`, unsafe.
2. **Mustache** — Logic-less, safe, but no helpers (no `{{json ...}}`, no `{{default ...}}`).
3. **Handlebars** — Superset of Mustache. Logic-less by default, supports custom helpers, safe auto-escaping, well-known syntax.
4. **EJS** — Full JavaScript in templates. Unsafe for the same reasons as `eval()`.

## Decision

Use **Handlebars** for template interpolation.

## Consequences

- **Positive:** Logic-less templates prevent arbitrary code execution. `{{payload.x}}` is safe.
- **Positive:** Custom helpers (`{{json ...}}`, `{{default ...}}`) extend functionality without compromising safety.
- **Positive:** Well-known syntax. Most developers have used Handlebars or Mustache.
- **Positive:** Auto-escaping by default. In system action commands, `{{payload.x}}` values are pre-shell-escaped.
- **Negative:** Triple-stache `{{{raw_payload.x}}}` bypasses escaping. Must be used carefully.
