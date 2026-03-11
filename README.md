# pi-workflows — Declarative Agent Workflow Engine (DAWE)

<!-- Badges -->

![CI](https://github.com/AI-Daemon/pi-workflows/actions/workflows/ci.yml/badge.svg)

A state-machine-based workflow engine for Pi agents. Replaces text-based skill routing with deterministic YAML/JSON workflows.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Create your first workflow
cat > workflows/examples/my-first-workflow.yml << 'EOF'
version: '1.0'
workflow_name: my-first-workflow
description: A simple example workflow.
initial_node: ask_task

nodes:
  ask_task:
    type: llm_decision
    instruction: 'What task do you need?'
    required_schema:
      task: string
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
    message: 'Task noted: {{payload.task}}'
EOF
```

## Features

### Core Engine

- **YAML workflow definitions** with Zod schema validation
- **Four node types:** `llm_decision`, `llm_task`, `system_action`, `terminal`
- **jexl expression evaluator** for safe, sandboxed transition conditions
- **Handlebars templating** for dynamic instructions and commands
- **Auto-advancing system actions** with security validation and shell escaping

### v2.0: Bounded Cycles

- **`max_visits`** per-node budget enforcement for safe iteration
- **`extract_json`** structured output extraction from command output files
- **`$metadata.visits`** cycle-aware instructions and transitions
- **Stall detection** via SHA-256 workspace state hashing
- **`suspended` terminal status** for human intervention fallback

### Error & Observability

- **Unified `DAWEError` hierarchy** with 8 category-specific subclasses
- **Error code registry** (`S-001` through `P-007`) as single source of truth
- **`DAWELogger`** structured JSON/pretty logging with child loggers
- **`ErrorCollector`** for multi-error validation pipelines
- **Agent recovery hints** (`agentHint`) guide the LLM through self-recovery

### Persistence

- **`FileInstanceStore`** for durable file-based persistence with atomic writes
- **Write debouncing** for performance during rapid state changes
- **Instance recovery** after process/container restarts

## Architecture

```
YAML Workflow Files
    ↓ Parser & Validator
Workflow Runtime (FSM)
    ↓ Expression Evaluator + Payload Manager + System Action Executor
Pi Extension Tool (advance_workflow)
    ↓ Response & Error Formatters
Pi Agent / LLM
```

Three layers: **Definition** (YAML) → **Engine** (TypeScript) → **Agent Interface** (Pi Extension).

## Node Types

| Type            | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `llm_decision`  | Prompts the agent to extract specific JSON variables from user text     |
| `llm_task`      | Hands control to the agent for open-ended work with completion criteria |
| `system_action` | Executes commands natively (bash/Node.js) without LLM intervention      |
| `terminal`      | End state: `success`, `failure`, `cancelled`, or `suspended`            |

## Example: Test-Fix Cycle (v2.0)

```yaml
version: '2.0'
workflow_name: test-fix-cycle
description: Run tests, fix failures, retry up to 3 times.
initial_node: run_tests

nodes:
  run_tests:
    type: system_action
    runtime: bash
    command: 'npm test'
    max_visits: 3
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: done
      - condition: 'true'
        target: fix_tests

  fix_tests:
    type: llm_task
    instruction: 'Fix the failing tests. Attempt {{$metadata.visits.run_tests}} of 3.'
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  done:
    type: terminal
    status: success
    message: 'All tests pass!'

  stuck:
    type: terminal
    status: suspended
    message: 'Tests still failing after 3 attempts.'
```

## Documentation

- [Architecture](./docs/architecture.md) — System design, data flow, FSM model, security
- [Workflow Authoring Guide](./docs/workflow-authoring-guide.md) — How to write workflows
- [API Reference](./docs/api-reference.md) — TypeScript API for engine developers
- [Expression Reference](./docs/expression-reference.md) — jexl syntax and examples
- [Error Code Reference](./docs/error-code-reference.md) — All error codes with recovery hints
- [Contributing](./docs/contributing.md) — Development setup, standards, how to extend
- [Migration Guide](./docs/migration-guide.md) — Migrating from Markdown skills
- [Architecture Decision Records](./docs/adr/) — Why we made specific design choices

## Tech Stack

- TypeScript / Node.js (ESM only)
- Zod for runtime schema validation
- jexl for safe expression evaluation
- Handlebars for template interpolation
- Vitest for testing

## License

See [LICENSE](./LICENSE).
