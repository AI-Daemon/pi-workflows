# ADR-001: Zod Over JSON Schema for Runtime Validation

## Context

DAWE needs to validate workflow YAML files at runtime. The two main options were:

1. **JSON Schema** — Industry standard, language-agnostic, wide tooling support (editors, CI). But runtime validation in Node.js requires a separate library (e.g., `ajv`), error messages are opaque, and TypeScript type inference requires code generation.
2. **Zod** — TypeScript-first schema library. Defines schemas in code, validates at runtime, and infers TypeScript types from the same definition. Error messages are structured and customizable.

The workflow schema needs both an editor-facing spec (for YAML autocomplete/linting) and a runtime validator (for the engine). We could maintain both a JSON Schema file and a Zod schema, or use Zod as the source of truth and generate JSON Schema for tooling.

## Decision

Use **Zod** as the runtime validation engine and source of truth for the workflow contract. Maintain a separate `workflow.schema.json` for editor tooling, kept in sync manually.

## Consequences

- **Positive:** Single source of truth for TypeScript types. `z.infer<typeof WorkflowDefinitionSchema>` produces the `WorkflowDefinition` type automatically. No code generation step.
- **Positive:** Rich, structured error messages via `ZodError.issues`. Each issue has a path, code, and message. Custom cross-field validations via `superRefine()` collect all errors in a single pass.
- **Positive:** Composable schemas. Node type schemas are defined independently and combined via `discriminatedUnion('type', [...])`.
- **Negative:** JSON Schema file must be manually kept in sync. Drift is possible.
- **Negative:** Zod is a runtime dependency (not just devDependency). Bundle size impact is minimal (~50KB).
