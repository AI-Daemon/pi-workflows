# Architecture & Product Requirements Document (v2.0)

**System:** Declarative Agent Workflow Engine (DAWE)
**Author:** Solution Architect
**Target Audience:** Agent Engineering Team
**Revision:** v2.0 — FSM Architecture with Bounded Cycles, Stall Detection & Context Optimization

---

## 1. Executive Summary & Problem Statement

**The Problem:** Our current Pi agents rely on autonomous, multi-hop text file reading (Markdown skills at `~/.pi/agent/skills/`) to execute complex development pipelines (e.g., issue-first development, PR creation). This architecture fails because it relies on the LLM to autonomously chain multi-hop text file reads, retain massive procedural context (400+ lines), and self-route. LLMs are non-deterministic and frequently experience choice paralysis or skip steps entirely when presented with procedural Standard Operating Procedures (SOPs). Furthermore, standard Directed Acyclic Graphs (DAGs) fail to model real-world coding, which is inherently cyclical (e.g., code → test → fix → test). However, allowing cycles introduces the risk of infinite loops and "token snowballs" — where accumulating error logs exhaust the LLM's context window, leading to hallucinations.

**The Solution:** We will implement DAWE as a **Finite State Machine (FSM)** defined by declarative YAML/JSON configurations. DAWE will safely support **bounded cycles**, strictly spoon-feed instructions to the LLM via a single Pi Extension tool (`advance_workflow`), and prevent context exhaustion using a dual strategy of **Structured Error Extraction** and **File Pointers**. To prevent infinite token burn without arbitrarily capping advanced workflows, DAWE will utilize **Cryptographic Stall Detection (Idempotency Traps)**. The engine will completely remove the LLM's burden of orchestration while providing a highly extensible, "low-code" architecture for the engineering team.

---

## 2. System Architecture: The FSM Engine

The DAWE architecture abandons the strict DAG constraint to allow **controlled back-edges (cycles)**. The architecture consists of three distinct layers:

- **The Definition Layer (YAML/JSON):** Declarative configuration files that define nodes (`llm_decision`, `llm_task`, `system_action`), conditional transitions, per-node budgets, and extraction directives. This is the "no-code" interface for adding/removing workflow steps.
- **The Execution Engine (TypeScript/Node.js):** The runtime environment that parses the FSM definition, evaluates transition logic using an expression engine, manages state payloads with visit counters (`$metadata.visits`), and enforces loop safety via per-node budgets and cryptographic stall detection.
- **The Agent Interface (Pi Extension Tool):** The `advance_workflow` tool, acting as the sole boundary between the non-deterministic LLM and the deterministic FSM engine. It sends LLM outputs to the engine and returns the next node's strict instructions.

---

## 3. Core Components & Data Models

### 3.1 Workflow Schema Definition (v2.0)

Workflows are defined as an FSM graph of **Nodes** connected by conditional **Transitions**. Unlike v1.0, the schema now supports **back-edges** (cycles), **per-node visit budgets**, **structured output extraction**, and **file pointers**.

**Supported Node Types:**

- **`llm_decision`:** Prompts the agent to extract specific JSON variables from user text (e.g., project name, bug vs. feature).
- **`llm_task`:** Hands control back to the agent to perform an open-ended task (e.g., writing code) with strict completion criteria.
- **`system_action`:** Executes purely in the engine (API calls, Bash scripts, Docker commands) without LLM intervention. Returns the output to the state payload. Now supports `extract_json` for structured output parsing and automatic file pointer generation.

**YAML Example Blueprint (v2.0):**

```yaml
version: '2.0'
workflow_name: 'issue-first-development'
description: 'Enforces GitHub issue creation before code implementation.'
initial_node: 'assess_intent'

nodes:
  assess_intent:
    type: 'llm_decision'
    instruction: 'Analyze the user request. Identify the target repository and whether file edits are required.'
    required_schema:
      project_name: 'string'
      requires_edits: 'boolean'
    transitions:
      - condition: 'payload.requires_edits == false'
        target: 'exit_informational'
      - condition: 'payload.requires_edits == true'
        target: 'system_check_issue'

  system_check_issue:
    type: 'system_action'
    runtime: 'bash'
    command: './scripts/check-gh-issue.sh {{payload.project_name}}'
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: 'llm_implement_code'
      - condition: 'action_result.exit_code != 0'
        target: 'system_create_issue'

  # ... linear nodes omitted for brevity ...

  run_tests:
    type: 'system_action'
    command: 'npm run test -- --reporter=json > /tmp/dawe/latest-test.json'
    max_visits: 3
    extract_json: '/tmp/dawe/latest-test.json'
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: 'create_pr'
      - condition: 'action_result.exit_code != 0 && $metadata.visits.run_tests < 3'
        target: 'fix_tests'
      - condition: 'action_result.exit_code != 0 && $metadata.visits.run_tests >= 3'
        target: 'human_intervention'

  fix_tests:
    type: 'llm_task'
    instruction: |
      Test run failed. This is attempt {{$metadata.visits.run_tests}} of 3.

      Primary Failures:
      {{payload.extracted_json.failed_tests}}

      If you need the full trace, read the raw log at: {{payload.log_pointer_path}}

      Review the failures and implement a fix. Do not repeat previous mistakes.
    transitions:
      - condition: 'always'
        target: 'run_tests'

  human_intervention:
    type: 'terminal'
    status: 'suspended'
    message: 'Maximum test fix attempts exhausted. Workflow suspended for human review.'
```

### 3.2 State Management (The Context Payload)

The engine maintains a mutable JSON object called the **Payload** throughout the lifecycle of a workflow instance, now augmented with execution metadata.

- **Hydration:** As the graph transitions from node to node, outputs from `llm_decision` and `system_action` nodes are merged into the payload.
- **Templating:** Node instructions and system commands can dynamically inject variables using Handlebars syntax (e.g., `{{payload.project_name}}`, `{{$metadata.visits.run_tests}}`).
- **Context Isolation:** The LLM does not need to remember step 1 when it reaches step 5. The engine templates the accumulated necessary facts into the prompt for the current node.
- **Execution Metadata (`$metadata`):** The engine automatically maintains a `$metadata` object in the payload containing:
  - `$metadata.visits.<node_id>` — Integer counter incremented each time a node is entered.
  - `$metadata.state_hashes` — Array of workspace hashes from previous cycle iterations (used by stall detection).
  - `$metadata.instance_id` — The workflow instance identifier.
  - `$metadata.started_at` — ISO 8601 timestamp of workflow instantiation.

---

## 3.3 Loop Safety: Stall Detection & Circuit Breakers

We explicitly reject global step limits (e.g., `max_steps: 15`), as they arbitrarily break advanced, long-running workflows. Instead, the engine protects against infinite loops using two complementary mechanisms.

#### 3.3.1 Per-Node Budgets (`max_visits`)

The engine maintains a `$metadata.visits` counter. Cyclical nodes (like `run_tests`) **must** define a `max_visits` integer in the YAML. Once exceeded, the engine forces a transition to a terminal or human-intervention node.

- Nodes without `max_visits` that are targets of back-edges will fail schema validation.
- The `max_visits` budget is per-instance, not global — each workflow run gets its own counters.
- Transition conditions can reference `$metadata.visits.<node_id>` to implement graduated strategies (e.g., try a different fix approach on the second attempt).

#### 3.3.2 Idempotency Traps (Cryptographic Stall Detection)

To prevent the agent from burning loops by applying the same broken fix repeatedly, the engine implements a **State-Hash Stall Detector**.

- **Mechanism:** Before transitioning back into a cycle (e.g., `fix_tests` → `run_tests`), the engine hashes the current workspace state — a combined SHA-256 hash of `git diff` output and the current `action_result.stdout`.
- **Evaluation:** If the hash exactly matches a previous loop iteration's hash, the agent has made **zero functional progress**.
- **Action:** The engine immediately throws a `STALL_DETECTED` error, halting the loop and transitioning the workflow to a `SUSPENDED` state for human review, regardless of remaining `max_visits` budget.

This approach is superior to global step limits because it detects the _cause_ of infinite loops (no progress) rather than using an arbitrary counter that penalizes legitimately complex workflows.

---

## 3.4 Context Optimization (Anti-Hallucination)

LLMs hallucinate line numbers and file names when fed raw, un-truncated logs. To provide 100% signal and 0% noise, DAWE handles `system_action` outputs via a two-pronged strategy.

#### 3.4.1 Structured Error Extraction

`system_action` commands can be configured to output JSON (e.g., `npm run test -- --reporter=json`). The DAWE engine parses this JSON via the `extract_json` directive, extracts only the failing assertions, and templates this highly concentrated data into the agent's payload.

- The `extract_json` field on a `system_action` node specifies the file path to the structured output.
- The engine parses the file and merges the result into `payload.extracted_json`.
- If parsing fails (malformed JSON), the engine falls back to the file pointer strategy (§3.4.2) and logs a warning.

#### 3.4.2 File Pointers (The Safety Net)

For massive outputs (e.g., Docker build logs, verbose test suites, or when `extract_json` parsing fails), the engine streams the full, raw output to a temporary file (e.g., `/tmp/dawe-runs/<instance>-<node>-<visit>.log`). The engine passes only the file path to the LLM via `payload.log_pointer_path`.

- The agent can use its standard `read` tool to investigate the full log if the extracted JSON is insufficient.
- File pointers are automatically cleaned up when the workflow instance reaches a terminal state.
- This prevents context window exhaustion from multi-kilobyte test outputs or build logs.

---

## 4. The Agent Interface (Pi Extension)

To prevent the agent from ignoring the workflow, we expose a single deterministic tool. The agent's global system prompt enforces the use of this tool for all development tasks.

### Tool Signature: `advance_workflow`

```json
{
  "name": "advance_workflow",
  "description": "REQUIRED tool to progress through development workflows. Submits your current task data and receives the exact next step.",
  "parameters": {
    "type": "object",
    "properties": {
      "workflow_instance_id": {
        "type": "string",
        "description": "The ID of the active workflow. Leave blank to start a new one."
      },
      "current_node_id": {
        "type": "string",
        "description": "The node you are currently completing."
      },
      "node_payload": {
        "type": "object",
        "description": "The JSON data required by the current node's schema."
      }
    },
    "required": ["current_node_id", "node_payload"]
  }
}
```

### Engine Response Format

When the tool is called, the engine processes the graph and returns a strict markdown string to realign the agent. The response now includes cycle metadata when applicable.

**Standard progression:**

```
> SYSTEM ACTION SUCCESSFUL. Issue #198 created on repository pi-daemon.
> NEXT NODE: llm_implement_code
> INSTRUCTIONS: You are currently on branch bug/issue-198. Implement the fix requested by the user.
> REQUIRED ACTION: When coding is complete, call advance_workflow with current_node_id: llm_implement_code and node_payload: { "status": "complete" }.
```

**Cycle iteration (test failure with retry budget):**

```
> SYSTEM ACTION FAILED. Test suite returned 3 failures (exit code 1).
> CYCLE: run_tests → fix_tests (attempt 2 of 3)
> NEXT NODE: fix_tests
> INSTRUCTIONS: Test run failed. This is attempt 2 of 3. Review the extracted failures below and implement a fix.
> EXTRACTED DATA: [structured JSON failures]
> RAW LOG: /tmp/dawe-runs/abc123-run_tests-2.log
> REQUIRED ACTION: Implement the fix, then call advance_workflow with current_node_id: fix_tests and node_payload: { "status": "complete" }.
```

**Stall detected (workflow suspended):**

```
> STALL DETECTED. The workspace state is identical to the previous iteration.
> The agent has made zero functional progress in the run_tests → fix_tests cycle.
> WORKFLOW SUSPENDED for human review.
> Instance ID: abc-123-def
> Stalled at: run_tests (visit 2 of 3)
> State hash: sha256:a1b2c3...
```

---

## 5. Execution Trace Examples

### 5.1 Linear Flow (Happy Path)

1. **Trigger:** User says, "Fix the CSS bug in pi-daemon."
2. **Agent Action:** Agent recognizes a dev task. Calls `advance_workflow` with empty instance ID to start `issue-first-development`.
3. **Engine Logic:** Instantiates workflow. Initializes `$metadata.visits = {}`. Returns `assess_intent` node instructions.
4. **Agent Action:** Analyzes user text. Calls `advance_workflow` passing `{ project_name: "pi-daemon", requires_edits: true }`.
5. **Engine Logic:**
   - Validates payload.
   - Evaluates transitions: `requires_edits == true` routes to `system_check_issue`.
   - Executes bash script natively. Script returns exit code 1 (no issue found).
   - Evaluates transitions: routes to `system_create_issue`.
   - Executes GitHub CLI natively. Returns Issue #12.
   - Evaluates transitions: routes to `llm_implement_code`.
   - Returns formatted context and new instructions to the agent.
6. **Agent Action:** Agent writes code, then calls `advance_workflow` to progress to `run_tests`.

### 5.2 Cyclical Flow (Test → Fix → Retry)

7. **Engine Logic:** Executes `run_tests` (`$metadata.visits.run_tests` → 1). Tests fail with 3 assertions.
   - Writes raw output to `/tmp/dawe-runs/abc123-run_tests-1.log`.
   - Parses `extract_json` file → extracts 3 failing test names and messages into `payload.extracted_json`.
   - Evaluates transition: `exit_code != 0 && visits < 3` → routes to `fix_tests`.
   - Returns cycle-aware instructions with extracted failures and file pointer.
8. **Agent Action:** Agent reads extracted failures, implements fix, calls `advance_workflow`.
9. **Engine Logic:** Transitions back to `run_tests` (`$metadata.visits.run_tests` → 2).
   - **Stall check:** Hashes `git diff` + `action_result.stdout`. Hash differs from visit 1 → progress detected, continue.
   - Tests pass (exit code 0) → routes to `create_pr`.

### 5.3 Stall Detection (No Progress)

7. **Engine Logic:** Executes `run_tests` (visit 1). Tests fail. Routes to `fix_tests`.
8. **Agent Action:** Agent attempts fix but makes no meaningful change.
9. **Engine Logic:** Transitions back to `run_tests` (visit 2).
   - **Stall check:** Hashes `git diff` + `action_result.stdout`. Hash **matches** visit 1.
   - Engine throws `STALL_DETECTED`. Workflow transitions to `SUSPENDED` state.
   - Returns suspension notice with instance ID and state hash for human review.

---

## 6. Implementation Roadmap

> **Note:** Phases 1–3 below reflect the original v1.0 roadmap, much of which is already implemented. Phases 4–6 introduce the v2.0 FSM architecture enhancements. **Phases 4–6 must be completed before new feature workflows (e.g., marketplace, dependency pipelines) are built**, as those workflows depend on cycle support and context optimization.

### Phase 1: Engine Core & Schema Validation ✅ (v1.0 — Complete)

- Define the exact JSON Schema for the YAML workflow files.
- Build the TypeScript DAG parser that can load a workflow and validate it for infinite loops or orphaned nodes.

### Phase 2: State Context & Expression Evaluation ✅ (v1.0 — Complete)

- Implement the Payload object manager.
- Integrate a safe JS expression evaluator (e.g., jexl or expr-eval) to handle the conditional logic in the transitions arrays.

### Phase 3: Pi Extension Boundary ✅ (v1.0 — Complete)

- Create the `advance_workflow` Pi Extension wrapper.
- Implement the routing for `system_action` nodes to safely execute local bash/API commands within the agent's Docker environment.
- Rewrite the agent's global system prompt to deprecate the old Markdown skills and strictly route to the new DAWE extension.

### Phase 4: Engine Refactor — DAG to FSM (v2.0)

- Remove strict cycle-detection algorithms from the workflow parser; replace with bounded-cycle validation.
- Update the YAML schema (v2.0) to support `max_visits` on nodes and `extract_json` on `system_action` nodes.
- Implement the `$metadata.visits` tracking in the state payload.
- Implement the `max_visits` transition evaluation logic — engine must force-transition to a terminal/suspension node when budget is exhausted.
- Update the graph validator to require `max_visits` on any node that is the target of a back-edge.
- Add the `SUSPENDED` workflow instance state alongside existing `ACTIVE`, `COMPLETED`, and `CANCELLED` states.

### Phase 5: Context Management (v2.0)

- Build the `system_action` wrapper that automatically pipes `stdout`/`stderr` to `/tmp/dawe-runs/<instance>-<node>-<visit>.log` files.
- Implement the `extract_json` parsing utility to map structured test/linter outputs into the `payload.extracted_json` object.
- Implement graceful fallback: if `extract_json` parsing fails, fall back to file pointer only and log a warning.
- Update the template engine to support `$metadata.*` variables in Handlebars expressions.
- Implement automatic cleanup of file pointer temp files when a workflow instance reaches a terminal state.

### Phase 6: Stall Detection & Safety (v2.0)

- Implement the Cryptographic Stall Detector: SHA-256 hashing of `git diff` + `action_result.stdout` before cycle back-edges.
- Store state hashes in `$metadata.state_hashes` for comparison across loop iterations.
- On hash match (stall detected): throw `STALL_DETECTED` error, transition workflow to `SUSPENDED` state.
- Ensure `SUSPENDED` state gracefully halts execution for human intervention without locking the agent's session.
- Add `STALL_DETECTED` to the unified error taxonomy (see issue #12).
- Integration test: verify stall detection halts a workflow where the agent applies an identical no-op fix across iterations.

---

## 7. Migration & Compatibility Notes

### 7.1 Schema Versioning

- v1.0 workflow YAML files remain valid and will be executed as strict DAGs (no cycles permitted).
- v2.0 workflow YAML files must declare `version: '2.0'` to unlock cycle support, `max_visits`, and `extract_json`.
- The engine will auto-detect the schema version and apply the appropriate validation rules.

### 7.2 Backward Compatibility

- All existing v1.0 workflows, tests, and integrations will continue to work without modification.
- The `dag-parser.ts` and `graph-validator.ts` modules will be refactored to support both DAG (v1.0) and FSM (v2.0) validation modes.
- New v2.0 features (`max_visits`, `extract_json`, `$metadata`) are opt-in and have no effect on v1.0 workflows.

### 7.3 Breaking Changes

- None. v2.0 is a strict superset of v1.0.
