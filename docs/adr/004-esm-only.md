# ADR-004: ESM Only (No CommonJS Dual Build)

## Context

The Node.js ecosystem is transitioning from CommonJS to ES Modules. DAWE could support both via a dual build (`dist/cjs/` + `dist/esm/`), or commit to ESM only.

## Decision

ESM only. No CommonJS build. `"type": "module"` in `package.json`.

## Consequences

- **Positive:** Simpler build configuration. One `tsconfig.json`, one output directory.
- **Positive:** Tree-shakeable by default. Bundlers can statically analyze ESM imports.
- **Positive:** Aligns with the direction of Node.js, TypeScript, and the Pi ecosystem.
- **Negative:** Cannot be `require()`'d from CommonJS code. Consumers must use `import`.
- **Negative:** Some older tooling may not support ESM fully. Mitigated by requiring Node.js 20+.
