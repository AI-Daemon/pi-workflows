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
