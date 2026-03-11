# Contributing to pi-workflows

Thank you for your interest in contributing to the Declarative Agent Workflow Engine (DAWE)!

## Getting Started

1. **Fork & clone** the repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to verify compilation
4. Run `npm test` to run the test suite
5. Run `npm run lint` to check code style

## Branch Naming Convention

Use the following prefixes for branches:

| Prefix   | Use Case                          |
| -------- | --------------------------------- |
| `feat/`  | New features                      |
| `fix/`   | Bug fixes                         |
| `chore/` | Maintenance, refactoring, tooling |
| `docs/`  | Documentation-only changes        |
| `test/`  | Test-only changes                 |

**Examples:**

- `feat/dag-parser`
- `fix/transition-evaluator-null-check`
- `chore/update-dependencies`

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                  |
| ---------- | -------------------------------------------- |
| `feat`     | A new feature                                |
| `fix`      | A bug fix                                    |
| `docs`     | Documentation only changes                   |
| `style`    | Formatting, missing semi-colons, etc.        |
| `refactor` | Code change that neither fixes nor adds      |
| `test`     | Adding or updating tests                     |
| `chore`    | Build process, tooling, or auxiliary changes |
| `ci`       | CI/CD configuration changes                  |

### Scopes

Use the module name as scope when applicable: `engine`, `extension`, `schemas`, `scripts`, `utils`.

**Examples:**

```
feat(engine): add DAG parser with cycle detection
fix(schemas): handle optional transition conditions
chore(ci): add Node.js 22 to test matrix
```

## Pull Request Requirements

1. **Branch from `main`** — all PRs target `main`
2. **One logical change per PR** — keep PRs focused and reviewable
3. **All CI checks must pass** — lint, test, build
4. **Include tests** — new features require corresponding test coverage
5. **Update documentation** — if your change affects the public API or configuration
6. **Reference the issue** — include `Closes #N` or `Refs #N` in the PR description

## Code Style

- **TypeScript strict mode** — no `any` types, no type assertions unless absolutely necessary
- **ESM only** — use `import`/`export`, not `require()`
- **Prettier** handles formatting — run `npm run lint:fix` before committing
- **ESLint** enforces code quality — address all warnings

## Testing

- **Unit tests** go in `tests/unit/` and mirror the `src/` directory structure
- **Integration tests** go in `tests/integration/`
- **E2E tests** go in `tests/e2e/`
- **Test fixtures** (YAML workflows, mock payloads) go in `tests/fixtures/`
- Aim for ≥80% line and branch coverage

## Node.js Version

This project requires **Node.js 20+**. Use the `.nvmrc` file:

```bash
nvm use
```

## Error Handling Standards

### Use `DAWEError` Subclasses — Never Throw Raw `Error` Objects

Every error thrown or collected by the engine must be a `DAWEError` subclass. This ensures consistent error codes, structured logging, and agent recovery hints.

### Pick the Right Subclass

| Subclass                    | Category     | When to Use                        |
| --------------------------- | ------------ | ---------------------------------- |
| `SchemaValidationError`     | `schema`     | YAML parsing and schema validation |
| `GraphValidationError`      | `graph`      | Structural graph issues            |
| `ExpressionEvaluationError` | `expression` | jexl evaluation failures           |
| `PayloadError`              | `payload`    | Merge failures, protected keys     |
| `SystemActionError`         | `execution`  | Command execution failures         |
| `RuntimeError`              | `runtime`    | Lifecycle errors                   |
| `SecurityViolationError`    | `security`   | Blocked command patterns           |
| `CycleSafetyError`          | `cycle`      | Stall detection, budget exhaustion |

### How to Add a New Error Code

1. Open `src/utils/error-codes.ts`
2. Add a new entry to the `ERROR_CODES` object following the naming convention: `{PREFIX}-{NNN}`
   - Prefixes: `S` (schema), `G` (graph), `E` (expression), `R` (runtime), `X` (execution), `C` (cycle), `P` (payload)
   - Numbers are sequential within each prefix
3. Required fields: `message`, `category`, `recoverable`
4. Optional fields: `severity` (default: `'error'`), `agentHint` (required for recoverable errors)

```typescript
'R-011': {
  message: 'Custom runtime error description',
  category: 'runtime',
  recoverable: true,
  agentHint: 'Tell the LLM how to recover from this error.',
},
```

### Always Include `agentHint` for Recoverable Errors

If the error is recoverable (`recoverable: true`), you **must** provide an `agentHint`. The LLM reads these hints to self-correct.

### Use `ErrorCollector` in Validation Pipelines

When validating workflows (schema + graph), collect all errors before failing:

```typescript
const collector = new ErrorCollector();
// ... add errors ...
if (collector.hasErrors()) {
  return collector.toResult();
}
```

## Logging Standards

### Accept an Optional `DAWELogger` in Constructors

Every module constructor should accept an optional `logger` parameter. Default to a warn-level logger:

```typescript
export class MyModule {
  private readonly logger: DAWELogger;

  constructor(options?: { logger?: DAWELogger }) {
    this.logger = options?.logger ?? new DAWELogger({ level: 'warn' });
  }
}
```

### Use `child()` Loggers with Component Context

```typescript
const runtime = new WorkflowRuntime({ logger });
// Internal: this.executor = new SystemActionExecutor({
//   logger: this.logger.child({ component: 'executor' })
// });
```

### Log Level Guidelines

| Level   | Use For                                                                |
| ------- | ---------------------------------------------------------------------- |
| `debug` | Internal details: expression eval, payload merge, hash computation     |
| `info`  | Lifecycle events: instance start, node entry/completion, workflow load |
| `warn`  | Non-fatal issues: stale files, extraction fallback, stall detected     |
| `error` | Failures: expression error, command failure, security block            |

### Always Pass `DAWEError` to `logger.error()`

The logger automatically extracts `code`, `category`, and `context` from `DAWEError` instances:

```typescript
const error = new SystemActionError('X-001', 'Command timed out');
this.logger.error('System action failed', error, { nodeId: 'run_tests' });
```

### Never Use `console.log` Directly

Use `DAWELogger` for all output. This ensures structured formatting and level filtering.

### Test Logging with Injectable `output`

```typescript
const logs: string[] = [];
const logger = new DAWELogger({
  level: 'debug',
  format: 'json',
  output: (line) => logs.push(line),
});
// ... use logger ...
expect(logs.some((l) => l.includes('"message":"Expected message"'))).toBe(true);
```

## How to Add a New Node Type

1. Define the Zod schema in `src/schemas/workflow.schema.ts`
2. Add it to the `NodeDefinitionSchema` discriminated union
3. Handle the new type in `WorkflowRuntime.processCurrentNode()`
4. Add transition evaluation logic
5. Update `formatAgentMessage()` in `agent-message-formatter.ts`
6. Add test fixtures in `tests/fixtures/`
7. Write unit and integration tests
8. Update documentation

## How to Add a New Expression Transform

1. Open `src/engine/expression-evaluator.ts`
2. Add the transform in the constructor: `this.jexlInstance.addTransform('name', fn)`
3. Add tests in `tests/unit/engine/expression-evaluator.test.ts`
4. Document in `docs/expression-reference.md`

---

_See also: [Architecture](./architecture.md) · [API Reference](./api-reference.md) · [Error Code Reference](./error-code-reference.md)_
