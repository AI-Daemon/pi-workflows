# Workflow Authoring Guide

> **Who is this for?** Workflow authors, agent engineers, and developers who write YAML workflow definitions for DAWE.
>
> **What you'll learn:** How to create workflow files, configure node types, write transitions, use bounded cycles, manage payload, author bash scripts, and troubleshoot errors.

## Table of Contents

- [Getting Started](#getting-started)
- [Node Types](#node-types)
- [Transitions](#transitions)
- [Bounded Cycles (v2.0)](#bounded-cycles-v20)
- [Payload](#payload)
- [Bash Scripts](#bash-scripts)
- [Best Practices](#best-practices)
- [Troubleshooting: Error Code Reference](#troubleshooting-error-code-reference)

---

## Getting Started

### Anatomy of a Workflow File

Every DAWE workflow is a YAML file with the following structure:

```yaml
# simple-task.yml — Minimal DAWE Workflow

version: '1.0' # Schema version: '1.0' or '2.0'
workflow_name: simple-task # Unique kebab-case identifier (3-64 chars)
description: A minimal example. # Human-readable summary (1-500 chars)
initial_node: get_task # The node where execution begins

nodes:
  get_task: # Node identifier (unique within workflow)
    type: llm_decision # One of: llm_decision, llm_task, system_action, terminal
    instruction: 'What task would you like to accomplish?'
    required_schema:
      task_description: string
    transitions:
      - condition: 'true'
        target: do_task

  do_task:
    type: llm_task
    instruction: 'Execute: {{payload.task_description}}'
    completion_schema:
      status: string
    context_keys:
      - task_description
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
    message: 'Task completed: {{payload.task_description}}'
```

### Required vs Optional Fields

**Required fields (top-level):**

| Field           | Type               | Description                                           |
| --------------- | ------------------ | ----------------------------------------------------- |
| `version`       | `'1.0'` or `'2.0'` | Schema version                                        |
| `workflow_name` | string             | Kebab-case, 3-64 chars, starts with letter            |
| `description`   | string             | 1-500 characters                                      |
| `initial_node`  | string             | Must reference an existing non-terminal node          |
| `nodes`         | map                | At least one node; must include at least one terminal |

**Optional fields (top-level):**

| Field      | Type | Description                                    |
| ---------- | ---- | ---------------------------------------------- |
| `metadata` | map  | Arbitrary key-value pairs (author, tags, etc.) |

### Schema Versioning

DAWE supports two schema versions:

- **`version: '1.0'`** — Strict DAG. No cycles allowed. All back-edges are rejected during validation. Use this for simple, linear workflows.
- **`version: '2.0'`** — FSM with bounded cycles. Back-edges are allowed if the target node has `max_visits`. Enables `extract_json`, `$metadata`, stall detection, and `suspended` terminals.

**When to use v2.0:** Any workflow that needs retry loops, iterative refinement, or test-fix cycles. If your workflow has a node that transitions back to a previously visited node, you need v2.0.

### How to Test a Workflow Locally

```bash
# 1. Validate the YAML schema
npm run build
node -e "
  import { loadWorkflow } from './dist/schemas/validation.js';
  import { readFileSync } from 'fs';
  const yaml = readFileSync('workflows/examples/simple-task.yml', 'utf-8');
  const result = loadWorkflow(yaml);
  console.log(result.ok ? 'Valid!' : JSON.stringify(result.errors, null, 2));
"

# 2. Run the full test suite
npm test
```

---

## Node Types

### `llm_decision` — LLM-Powered Decision Point

Use when the agent needs to **extract structured data** from user input or context to make a routing decision.

**Fields:**

| Field             | Required | Type                     | Description                                |
| ----------------- | -------- | ------------------------ | ------------------------------------------ |
| `type`            | Yes      | `'llm_decision'`         | Node type identifier                       |
| `instruction`     | Yes      | string (1-2000 chars)    | Prompt for the LLM                         |
| `required_schema` | Yes      | map of field→type        | Fields the LLM must return                 |
| `transitions`     | Yes      | array (min 1)            | Conditional transitions                    |
| `timeout_seconds` | No       | int (5-600, default 120) | LLM response timeout                       |
| `retry`           | No       | object                   | Retry config: `max_attempts`, `backoff_ms` |
| `max_visits`      | No       | int (1-100)              | v2.0: cycle budget                         |

**Schema field types:** `string`, `number`, `boolean`, `string[]`, `number[]`

**Example:**

```yaml
assess_intent:
  type: llm_decision
  instruction: >
    Analyze the user's request. Determine the project name
    and whether file edits are required.
  required_schema:
    project_name: string
    requires_edits: boolean
  transitions:
    - condition: 'payload.requires_edits == true'
      target: create_issue
      priority: 0
    - condition: 'true'
      target: exit_info
      priority: 99
```

### `llm_task` — LLM-Powered Task Execution

Use when the agent needs to **perform open-ended work** (write code, review diffs, draft documentation) and report completion.

**Fields:**

| Field               | Required | Type                       | Description                         |
| ------------------- | -------- | -------------------------- | ----------------------------------- |
| `type`              | Yes      | `'llm_task'`               | Node type identifier                |
| `instruction`       | Yes      | string (1-5000 chars)      | Task instructions                   |
| `completion_schema` | Yes      | map of field→type          | Fields for completion report        |
| `transitions`       | Yes      | array (min 1)              | Conditional transitions             |
| `timeout_seconds`   | No       | int (10-1800, default 300) | Task timeout                        |
| `context_keys`      | No       | string[]                   | Payload keys to inject into context |
| `max_visits`        | No       | int (1-100)                | v2.0: cycle budget                  |

**Completion field types:** `string`, `number`, `boolean`

**Example:**

```yaml
implement_code:
  type: llm_task
  instruction: >
    Implement the code changes for {{payload.project_name}}.
    Issue: {{payload.description}}
  completion_schema:
    status: string
    files_changed: string
  context_keys:
    - project_name
    - description
  transitions:
    - condition: 'true'
      target: run_tests
```

### `system_action` — Automated Command Execution

Use when the engine should **execute a command natively** (bash or Node.js) without LLM intervention. System actions auto-advance — the engine evaluates transitions and chains to the next node automatically.

**Fields:**

| Field             | Required | Type                    | Description                               |
| ----------------- | -------- | ----------------------- | ----------------------------------------- |
| `type`            | Yes      | `'system_action'`       | Node type identifier                      |
| `runtime`         | Yes      | `'bash'` or `'node'`    | Execution environment                     |
| `command`         | Yes      | string                  | Command with `{{handlebars}}` support     |
| `transitions`     | Yes      | array (min 1)           | Conditional transitions                   |
| `timeout_seconds` | No       | int (1-300, default 30) | Command timeout                           |
| `env`             | No       | map                     | Additional environment variables          |
| `working_dir`     | No       | string                  | Working directory                         |
| `max_visits`      | No       | int (1-100)             | v2.0: cycle budget                        |
| `extract_json`    | No       | string                  | v2.0: path to structured JSON output file |

**Key behaviors:**

- Payload values in `{{payload.x}}` are **auto-shell-escaped**. Use `{{{raw_payload.x}}}` for unescaped access.
- The `action_result` object is available in transition conditions: `action_result.exit_code`, `action_result.stdout`, `action_result.stderr`.
- Commands are validated against security patterns before execution.

**Example:**

```yaml
run_tests:
  type: system_action
  runtime: bash
  command: 'bash workflows/scripts/run-project-tests.sh /tmp/dawe/test.json'
  timeout_seconds: 120
  max_visits: 3 # v2.0: allow 3 cycle iterations
  extract_json: '/tmp/dawe/test.json' # v2.0: parse structured output
  transitions:
    - condition: 'action_result.exit_code == 0'
      target: create_pr
      priority: 0
    - condition: 'action_result.exit_code != 0'
      target: fix_tests
      priority: 1
```

### `terminal` — End State

A terminal node marks the end of a workflow instance. Every workflow must have at least one terminal node.

**Fields:**

| Field     | Required | Type         | Description                                    |
| --------- | -------- | ------------ | ---------------------------------------------- |
| `type`    | Yes      | `'terminal'` | Node type identifier                           |
| `status`  | Yes      | enum         | `success`, `failure`, `cancelled`, `suspended` |
| `message` | No       | string       | Template-able summary message                  |

**The `suspended` status (v2.0):** Indicates the workflow needs human intervention. The engine transitions here when cycle budgets are exhausted or stall detection fires.

**Example:**

```yaml
workflow_complete:
  type: terminal
  status: success
  message: 'Done for {{payload.project_name}}: {{payload.description}}'

human_intervention:
  type: terminal
  status: suspended
  message: 'Tests failed after {{$metadata.visits.run_tests}} attempts. Human review needed.'
```

---

## Transitions

Transitions define how the engine moves between nodes. Each non-terminal node has an array of transitions evaluated sequentially (first-match wins).

### Expression Syntax Reference

Transitions use [jexl](https://github.com/TomFrost/jexl) expression syntax:

| Operator             | Example                                    | Description                |
| -------------------- | ------------------------------------------ | -------------------------- |
| `==`                 | `payload.x == 'yes'`                       | Equality                   |
| `!=`                 | `payload.x != 0`                           | Inequality                 |
| `>`, `>=`, `<`, `<=` | `payload.count > 5`                        | Comparison                 |
| `&&`                 | `payload.a == true && payload.b > 0`       | Logical AND                |
| `\|\|`               | `payload.a == true \|\| payload.b == true` | Logical OR                 |
| `!`                  | `!(payload.done)`                          | Logical NOT                |
| `in`                 | `'admin' in payload.roles`                 | Array membership           |
| `\|lower`            | `payload.name\|lower == 'test'`            | Transform: lowercase       |
| `\|upper`            | `payload.name\|upper`                      | Transform: uppercase       |
| `\|length`           | `payload.items\|length > 0`                | Transform: length          |
| `\|trim`             | `payload.input\|trim != ''`                | Transform: trim whitespace |

**Special conditions:**

- `'true'` or `'default'` — Always evaluates to true. Use as a catch-all fallback.

**Available context variables:**

- `payload.*` — Current workflow payload
- `action_result.*` — System action output (after `system_action` nodes)
- `metadata.*` — Workflow-level metadata
- `$metadata.visits.*` — v2.0: visit counts per node

### Priority Ordering

Transitions are sorted by `priority` (ascending, lower = first). Use priority to control evaluation order:

```yaml
transitions:
  - condition: 'action_result.exit_code == 0'
    target: success_node
    priority: 0 # Evaluated first
  - condition: 'action_result.exit_code != 0 && $metadata.visits.run_tests >= 3'
    target: human_intervention
    priority: 1 # Evaluated second
  - condition: 'true'
    target: retry_node
    priority: 99 # Catch-all fallback
```

### Default/Fallback Transitions

Always include a fallback transition with `condition: 'true'` and a high priority number. If no transition matches, the engine produces an `R-001` error.

### Common Patterns

**If/else:**

```yaml
transitions:
  - condition: 'payload.approved == true'
    target: proceed
    priority: 0
  - condition: 'true'
    target: rejected
    priority: 1
```

**Switch/case:**

```yaml
transitions:
  - condition: "payload.issue_type == 'bug'"
    target: bug_flow
    priority: 0
  - condition: "payload.issue_type == 'feature'"
    target: feature_flow
    priority: 1
  - condition: 'true'
    target: default_flow
    priority: 99
```

**Error routing:**

```yaml
transitions:
  - condition: 'action_result.exit_code == 0'
    target: next_step
    priority: 0
  - condition: 'true'
    target: error_terminal
    priority: 1
```

---

## Bounded Cycles (v2.0)

### When to Use Cycles

Cycles are needed when the workflow must iterate: test-fix loops, retry patterns, or iterative refinement. Examples:

- **Test-fix cycle:** `run_tests → fix_tests → run_tests` — Retry failing tests up to N times
- **Review cycle:** `submit_review → address_feedback → submit_review` — Iterate on code review
- **Validation loop:** `validate → fix_errors → validate` — Re-validate after corrections

### `max_visits` — Per-Node Budget

The `max_visits` field (integer, 1-100) caps how many times a node can be entered in a single workflow instance. It is **required** on any node targeted by a back-edge in a v2.0 workflow.

```yaml
run_tests:
  type: system_action
  runtime: bash
  command: 'npm test'
  max_visits: 3 # Agent gets 3 attempts
  transitions:
    - condition: 'action_result.exit_code == 0'
      target: create_pr
    - condition: 'true'
      target: fix_tests
```

**How to choose a budget:** Start conservative (3). Increase based on workflow complexity. Most test-fix cycles resolve in 1-2 iterations; 3 provides a safety margin.

### `extract_json` — Structured Output for Cycle Iterations

System action nodes can specify `extract_json` with a file path. The engine reads this file after command execution and merges the parsed JSON into `payload.extracted_json`.

```yaml
run_tests:
  type: system_action
  runtime: bash
  command: 'npm test -- --reporter=json > /tmp/dawe/test.json 2>&1; exit ${PIPESTATUS[0]}'
  extract_json: '/tmp/dawe/test.json'
```

On failure (file not found, invalid JSON, empty file), the engine sets `payload.extracted_json` to `null` and falls back to `payload.log_pointer_path`.

### File Pointers — `payload.log_pointer_path`

For v2.0 workflows, the engine writes full stdout/stderr to a log file after every system action execution:

```
/tmp/dawe-runs/<instanceId>-<nodeId>-<visitCount>.log
```

The path is stored in `payload.log_pointer_path`. Use this in instructions to give the agent access to raw output:

```yaml
fix_tests:
  type: llm_task
  instruction: >
    Test output log: {{payload.log_pointer_path}}
    Structured results: {{json payload.extracted_json}}
    Please analyze and fix the failures.
```

### `$metadata.visits.*` — Visit-Count-Aware Transitions and Instructions

The `$metadata` object tracks per-node visit counts. Reference it in transitions and instructions:

**In transitions:**

```yaml
- condition: 'action_result.exit_code != 0 && $metadata.visits.run_tests >= 3'
  target: human_intervention
  priority: 1
```

**In instructions:**

```yaml
instruction: >
  This is attempt {{$metadata.visits.run_tests}} of 3.
  Remaining attempts: calculate from the max budget.
```

### `human_intervention` Terminal — The Suspension Safety Net

Always include a `suspended` terminal in workflows with cycles. This is the fallback when the cycle budget is exhausted or stall detection fires:

```yaml
human_intervention:
  type: terminal
  status: suspended
  message: >
    Tests failed after maximum retry attempts.
    Human intervention is required.
```

### Stall Detection

Before traversing a cycle back-edge, the engine computes a SHA-256 hash of the workspace state (git diff + action output). If this hash matches any previous iteration, the agent has made **zero functional progress** and the instance is immediately suspended.

**How to avoid false positives:**

- Ensure your system action produces different output on each iteration
- If tests fail the same way, the fix_tests node should make substantive code changes
- Stall detection only fires on v2.0 workflows with `action_result` in the payload

### Complete Annotated Example: Test-Fix Cycle

```yaml
version: '2.0'
workflow_name: test-fix-example
description: Demonstrates the bounded test-fix cycle pattern.
initial_node: implement_code

nodes:
  implement_code:
    type: llm_task
    instruction: 'Write the code changes.'
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: run_tests

  # Cycle entry point — budget of 3 visits
  run_tests:
    type: system_action
    runtime: bash
    command: 'npm test -- --reporter=json > /tmp/test.json 2>&1; exit ${PIPESTATUS[0]}'
    timeout_seconds: 120
    max_visits: 3
    extract_json: '/tmp/test.json'
    transitions:
      # Happy path: tests pass
      - condition: 'action_result.exit_code == 0'
        target: create_pr
        priority: 0
      # Budget exhausted: human intervention
      - condition: 'action_result.exit_code != 0 && $metadata.visits.run_tests >= 3'
        target: human_intervention
        priority: 1
      # Budget remaining: fix and retry
      - condition: 'action_result.exit_code != 0'
        target: fix_tests
        priority: 2

  # Cycle body — agent fixes based on structured output
  fix_tests:
    type: llm_task
    instruction: >
      Attempt {{$metadata.visits.run_tests}} of 3.
      Test log: {{payload.log_pointer_path}}
      Results: {{json payload.extracted_json}}
      Fix the failing tests.
    completion_schema:
      status: string
    context_keys:
      - extracted_json
      - log_pointer_path
    transitions:
      - condition: 'true'
        target: run_tests # ← Back-edge: forms the cycle

  create_pr:
    type: terminal
    status: success
    message: 'All tests pass. Ready for PR.'

  human_intervention:
    type: terminal
    status: suspended
    message: 'Tests failed after 3 attempts. Human review needed.'
```

---

## Payload

### How Data Flows Between Nodes

The engine maintains a mutable JSON object called the **Payload** throughout the lifecycle of a workflow instance. As the graph transitions node-to-node:

1. **LLM nodes** — The agent's response (matching `required_schema` or `completion_schema`) is merged into the payload.
2. **System action nodes** — The `action_result` object (exit_code, stdout, stderr, data) is merged into the payload. For v2.0, `extracted_json` and `log_pointer_path` are also merged.
3. **Merge semantics** — Shallow merge for primitives, deep merge for nested objects, arrays are replaced atomically, `null` sets the key, `undefined` is skipped.

### How to Reference Payload in Instructions/Commands

Use Handlebars syntax in `instruction`, `command`, and `message` fields:

```yaml
instruction: 'Implement changes for {{payload.project_name}}: {{payload.description}}'
command: 'gh issue create --repo {{payload.project_name}} --title "{{payload.title}}"'
message: 'Completed: {{payload.project_name}}'
```

### Handlebars Syntax Cheat Sheet

| Syntax                                    | Description               | Example                                  |
| ----------------------------------------- | ------------------------- | ---------------------------------------- |
| `{{payload.x}}`                           | Simple reference          | `{{payload.project_name}}`               |
| `{{payload.nested.key}}`                  | Nested reference          | `{{payload.action_result.exit_code}}`    |
| `{{json payload.data}}`                   | JSON-serialize an object  | `{{json payload.extracted_json}}`        |
| `{{default payload.x "fallback"}}`        | Default value             | `{{default payload.issue_number '0'}}`   |
| `{{$metadata.visits.run_tests}}`          | v2.0: visit count         | `Attempt {{$metadata.visits.run_tests}}` |
| `{{payload.extracted_json.failed_tests}}` | v2.0: extracted field     | Structured test data                     |
| `{{{raw_payload.x}}}`                     | Unescaped (commands only) | Bypass shell escaping                    |

### Context Isolation

The LLM does not need to remember step 1 when it reaches step 5. The engine templates accumulated facts into the current node's prompt. Use `context_keys` on `llm_task` nodes to limit which payload keys are injected:

```yaml
implement_code:
  type: llm_task
  instruction: 'Implement for {{payload.project_name}}'
  context_keys:
    - project_name
    - description
    - issue_type
```

Only the listed keys appear in the scoped context, keeping the LLM's context window focused.

### `$metadata` Object (v2.0)

The `$metadata` object is a reserved payload key populated by the engine. It contains:

| Field            | Type                     | Description                         |
| ---------------- | ------------------------ | ----------------------------------- |
| `visits`         | `Record<string, number>` | Per-node visit counts               |
| `state_hashes`   | `string[]`               | SHA-256 hashes from stall detection |
| `instance_id`    | `string`                 | The workflow instance UUID          |
| `started_at`     | `string`                 | ISO 8601 timestamp                  |
| `stall_detected` | `boolean`                | Set to `true` if stall was detected |

The `$metadata` key is **protected** — agent payloads cannot overwrite it. Attempts to include `$metadata` in node_payload are silently stripped.

---

## Bash Scripts

### Script Conventions

System action commands should follow these conventions:

1. **JSON output** — When possible, write structured JSON to stdout or a file for `extract_json`.
2. **Exit codes** — Use `0` for success, non-zero for failure. The engine checks `action_result.exit_code` in transitions.
3. **`--help` flag** — Document what the script does, what arguments it accepts.
4. **Idempotency** — Scripts should be safe to re-run (especially in cycle workflows).

### How to Use Template Variables Safely

In `system_action` commands, `{{payload.x}}` values are auto-shell-escaped:

```yaml
command: 'echo {{payload.user_input}}'
# If payload.user_input = "hello; rm -rf /", the command becomes:
# echo 'hello; rm -rf /'    (safely escaped)
```

Use `{{{raw_payload.x}}}` only when you need unescaped access (e.g., passing to a program that handles its own escaping).

### Testing Scripts Independently

```bash
# Test a script outside the engine
export DAWE_WORKFLOW_NAME=test
export DAWE_NODE_ID=run_tests
bash workflows/scripts/run-project-tests.sh /tmp/test.json
echo "Exit code: $?"
cat /tmp/test.json
```

### JSON Reporter Output (v2.0)

For `extract_json` to work, your scripts must write valid JSON to the specified file:

```bash
#!/bin/bash
# run-project-tests.sh — Runs tests and writes JSON report
OUTPUT_FILE="${1:-/tmp/test-results.json}"
npm test -- --reporter=json > "$OUTPUT_FILE" 2>&1
EXIT_CODE=$?
# Ensure valid JSON even on failure
if [ ! -s "$OUTPUT_FILE" ]; then
  echo '{"error": "No test output", "exit_code": '"$EXIT_CODE"'}' > "$OUTPUT_FILE"
fi
exit $EXIT_CODE
```

---

## Best Practices

1. **Always include failure terminals** — Every workflow should handle error paths with `status: failure` terminals.
2. **Always include a `suspended` terminal for workflows with cycles** — This is the safety net when budget is exhausted or stall detection fires.
3. **Keep instructions under 500 words** — Concise instructions reduce LLM confusion. Template in only the data the agent needs.
4. **Use `context_keys` to limit LLM context** — Don't flood the agent with the entire payload. Scope to relevant keys.
5. **Name nodes descriptively (verb_noun pattern)** — `assess_intent`, `run_tests`, `create_pr` — not `step1`, `node_a`.
6. **Comment your YAML** — Use `#` comments to explain non-obvious transitions, business logic, and cycle patterns.
7. **Set `max_visits` conservatively** — Start with 3. Most issues resolve in 1-2 iterations. Going above 5 is rarely beneficial and wastes LLM tokens.
8. **Always include a catch-all transition** — Use `condition: 'true'` with high priority as the last transition to avoid `R-001` errors.
9. **Test workflows with unit tests** — Load your YAML in a test, validate it, and assert the graph structure.

---

## Troubleshooting: Error Code Reference

The following error codes are produced by the DAWE engine. The source of truth is `src/utils/error-codes.ts`.

### Schema Errors (S-xxx)

| Code    | Message                              | Recoverable | Fix                                                |
| ------- | ------------------------------------ | ----------- | -------------------------------------------------- |
| `S-001` | Invalid YAML syntax                  | No          | Check YAML formatting — run through a YAML linter  |
| `S-002` | Missing required field               | No          | Add the required field to your workflow YAML       |
| `S-003` | Invalid field type                   | No          | Check the field value matches the expected type    |
| `S-004` | Invalid node reference               | No          | Check spelling of the target node ID               |
| `S-005` | Missing terminal node                | No          | Add at least one terminal node to the workflow     |
| `S-006` | Initial node is terminal             | No          | Set `initial_node` to a non-terminal node          |
| `S-007` | Terminal node has transitions        | No          | Remove transitions from the terminal node          |
| `S-008` | Non-terminal node has no transitions | No          | Add at least one transition                        |
| `S-009` | Invalid workflow name                | No          | Use kebab-case, 3-64 chars, starting with a letter |
| `S-010` | Duplicate workflow name              | No          | Choose a unique workflow name                      |
| `S-011` | Invalid expression syntax            | No          | Check the condition expression syntax              |

### Graph Errors (G-xxx)

| Code    | Message                                                 | Recoverable | Fix                                                 |
| ------- | ------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `G-001` | Cycle detected (v1.0 DAG violation)                     | No          | Remove the back-edge or upgrade to `version: '2.0'` |
| `G-002` | Unreachable node                                        | No          | Ensure all nodes are reachable from `initial_node`  |
| `G-003` | No path to terminal                                     | No          | Add a transition path leading to a terminal node    |
| `G-004` | Unbounded cycle — back-edge target missing `max_visits` | No          | Add `max_visits` to the target node                 |
| `G-005` | Orphaned node                                           | No          | Connect the node or remove it                       |
| `G-006` | Maximum graph depth exceeded                            | No          | Simplify the workflow or increase max depth         |

### Runtime Errors (R-xxx)

| Code    | Message                   | Recoverable | Agent Hint                                                            |
| ------- | ------------------------- | ----------- | --------------------------------------------------------------------- |
| `R-001` | No matching transition    | Yes         | Check your payload values against the transition conditions           |
| `R-002` | Node mismatch             | Yes         | You submitted data for the wrong node. Check `current_node_id`        |
| `R-003` | Payload validation failed | Yes         | Your payload is missing required fields. Review the required schema   |
| `R-004` | Instance not active       | No          | —                                                                     |
| `R-005` | Budget exhausted          | No          | The cycle has exhausted its retry budget. Human intervention required |
| `R-006` | Workflow not found        | No          | —                                                                     |
| `R-007` | Instance not found        | No          | —                                                                     |

### Execution Errors (X-xxx)

| Code    | Message                            | Recoverable | Agent Hint                                                              |
| ------- | ---------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `X-001` | System action timed out            | Yes         | Consider a longer timeout or simpler command                            |
| `X-003` | Command blocked by security policy | No          | Modify command to avoid blocked patterns                                |
| `X-004` | JSON extraction failed             | Yes         | Check the command outputs valid JSON; engine falls back to file pointer |

### Cycle Safety Errors (C-xxx)

| Code    | Message        | Recoverable | Agent Hint                                                                          |
| ------- | -------------- | ----------- | ----------------------------------------------------------------------------------- |
| `C-001` | Stall detected | No          | You applied the same fix as a previous attempt. Workflow suspended for human review |

---

_See also: [Architecture](./architecture.md) · [API Reference](./api-reference.md) · [Expression Reference](./expression-reference.md) · [Error Code Reference](./error-code-reference.md)_

---

## Appendix: Workflow Validation Checklist

Before deploying a workflow, verify the following:

### Structure

- [ ] `version` is set to `'1.0'` or `'2.0'`
- [ ] `workflow_name` is kebab-case, 3-64 characters, starts with a letter
- [ ] `description` is 1-500 characters
- [ ] `initial_node` references an existing non-terminal node
- [ ] At least one terminal node exists

### Nodes

- [ ] Every non-terminal node has at least one transition
- [ ] Every transition target references an existing node
- [ ] All `required_schema` and `completion_schema` fields use valid types
- [ ] Instructions are under 2000 characters (llm_decision) or 5000 characters (llm_task)
- [ ] Timeout values are within allowed ranges

### Transitions

- [ ] Every node has a catch-all transition (`condition: 'true'`) or guaranteed coverage
- [ ] Priority values create a deterministic evaluation order
- [ ] Expression syntax is valid jexl

### Cycles (v2.0 only)

- [ ] Workflow version is `'2.0'`
- [ ] Every back-edge target node has `max_visits` defined
- [ ] A `suspended` terminal exists for budget exhaustion
- [ ] `extract_json` paths are valid and scripts produce valid JSON
- [ ] Instructions reference `$metadata.visits.*` for cycle awareness

### Security

- [ ] System action commands don't contain dangerous patterns
- [ ] Template variables use `{{payload.x}}` (auto-escaped) not `{{{raw_payload.x}}}` unless necessary
- [ ] Environment variables don't expose secrets

---

## Appendix: Complete Field Reference

### Top-Level Fields

| Field           | Type             | Required | v1.0 | v2.0 | Description                  |
| --------------- | ---------------- | -------- | ---- | ---- | ---------------------------- |
| `version`       | `'1.0' \| '2.0'` | Yes      | ✓    | ✓    | Schema version               |
| `workflow_name` | string           | Yes      | ✓    | ✓    | Unique kebab-case identifier |
| `description`   | string           | Yes      | ✓    | ✓    | Human-readable summary       |
| `initial_node`  | string           | Yes      | ✓    | ✓    | Starting node                |
| `nodes`         | map              | Yes      | ✓    | ✓    | Node definitions             |
| `metadata`      | map              | No       | ✓    | ✓    | Arbitrary metadata           |

### Node Type Fields Summary

| Field               | `llm_decision`  |   `llm_task`    | `system_action` | `terminal` |
| ------------------- | :-------------: | :-------------: | :-------------: | :--------: |
| `instruction`       |    Required     |    Required     |        —        |     —      |
| `required_schema`   |    Required     |        —        |        —        |     —      |
| `completion_schema` |        —        |    Required     |        —        |     —      |
| `transitions`       |    Required     |    Required     |    Required     |     —      |
| `timeout_seconds`   |    Optional     |    Optional     |    Optional     |     —      |
| `context_keys`      |        —        |    Optional     |        —        |     —      |
| `runtime`           |        —        |        —        |    Required     |     —      |
| `command`           |        —        |        —        |    Required     |     —      |
| `env`               |        —        |        —        |    Optional     |     —      |
| `working_dir`       |        —        |        —        |    Optional     |     —      |
| `extract_json`      |        —        |        —        | Optional (v2.0) |     —      |
| `max_visits`        | Optional (v2.0) | Optional (v2.0) | Optional (v2.0) |     —      |
| `retry`             |    Optional     |        —        |        —        |     —      |
| `status`            |        —        |        —        |        —        |  Required  |
| `message`           |        —        |        —        |        —        |  Optional  |

### Transition Fields

| Field       | Type   | Required | Description                                 |
| ----------- | ------ | -------- | ------------------------------------------- |
| `condition` | string | Yes      | jexl expression or `'true'`/`'default'`     |
| `target`    | string | Yes      | Target node ID                              |
| `priority`  | int    | No       | Evaluation order (lower = first, default 0) |
