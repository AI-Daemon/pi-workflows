# Architecture & Product Requirements Document

**System:** Declarative Agent Workflow Engine (DAWE)
**Author:** Solution Architect
**Target Audience:** Agent Engineering Team

---

## 1. Executive Summary & Problem Statement

**The Problem:** Currently, our Pi agents rely on a progressive disclosure mechanism using Markdown files (`~/.pi/agent/skills/`) to execute complex, multi-step development pipelines (e.g., issue-first development, PR creation). This architecture fails because it relies on the LLM to autonomously chain multi-hop text file reads, retain massive procedural context (400+ lines), and self-route. LLMs are non-deterministic and frequently experience choice paralysis or skip steps entirely when presented with procedural Standard Operating Procedures (SOPs).

**The Solution:** We will deprecate the text-based routing files and implement a **Declarative State Machine** represented as a **Directed Acyclic Graph (DAG)**. Workflows will be defined in strict YAML/JSON configurations. The Pi agent will interact with a single, universal Extension Tool (`advance_workflow`). The engine will spoon-feed the agent its exact current state, required actions, and strict boundaries, completely removing the LLM's burden of orchestration while providing a highly extensible, "low-code" architecture for the engineering team.

---

## 2. System Architecture Overview

The DAWE architecture consists of three distinct layers:

- **The Definition Layer (YAML/JSON):** The declarative configuration files that define nodes, transitions, and state requirements. This is the "no-code" interface for adding/removing workflow steps.
- **The Execution Engine (TypeScript/Node.js):** The runtime environment that parses the active YAML file, manages state payload, evaluates conditional transitions, and executes system-level scripts natively (bypassing the LLM).
- **The Agent Interface (Pi Extension Tool):** The boundary layer. A single tool exposed to the Pi agent that acts as a pager, sending LLM outputs to the engine and returning the next node's strict instructions.

---

## 3. Core Components & Data Models

### 3.1 Workflow Schema Definition

Workflows are defined as a graph of **Nodes** connected by conditional **Transitions**.

**Supported Node Types:**

- **`llm_decision`:** Prompts the agent to extract specific JSON variables from user text (e.g., project name, bug vs. feature).
- **`llm_task`:** Hands control back to the agent to perform an open-ended task (e.g., writing code) with strict completion criteria.
- **`system_action`:** Executes purely in the engine (API calls, Bash scripts, Docker commands) without LLM intervention. Returns the output to the state payload.

**YAML Example Blueprint:**

```yaml
version: '1.0'
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

  # ... additional nodes
```

### 3.2 State Management (The Context Payload)

The engine maintains a mutable JSON object called the **Payload** throughout the lifecycle of a workflow instance.

- **Hydration:** As the graph transitions from node to node, outputs from `llm_decision` and `system_action` nodes are merged into the payload.
- **Templating:** Node instructions and system commands can dynamically inject variables using Handlebars syntax (e.g., `{{payload.project_name}}`).
- **Context Isolation:** The LLM does not need to remember step 1 when it reaches step 5. The engine templates the accumulated necessary facts into the prompt for the current node.

---

## 4. The Agent Interface (Pi Extension)

To prevent the agent from ignoring the workflow, we will expose a single deterministic tool. The agent's global system prompt will enforce the use of this tool for all development tasks.

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

When the tool is called, the engine processes the graph and returns a strict markdown string to realign the agent.

```
> SYSTEM ACTION SUCCESSFUL. Issue #198 created on repository pi-daemon.
> NEXT NODE: llm_implement_code
> INSTRUCTIONS: You are currently on branch bug/issue-198. Implement the fix requested by the user.
> REQUIRED ACTION: When coding is complete, call advance_workflow with current_node_id: llm_implement_code and node_payload: { "status": "complete" }.
```

---

## 5. Execution Trace Example

1. **Trigger:** User says, "Fix the CSS bug in pi-daemon."
2. **Agent Action:** Agent recognizes a dev task. Calls `advance_workflow` with empty instance ID to start `issue-first-development`.
3. **Engine Logic:** Instantiates workflow. Returns `assess_intent` node instructions.
4. **Agent Action:** Analyzes user text. Calls `advance_workflow` passing `{ project_name: "pi-daemon", requires_edits: true }`.
5. **Engine Logic:**
   - Validates payload.
   - Evaluates transitions: `requires_edits == true` routes to `system_check_issue`.
   - Executes bash script natively. Script returns exit code 1 (no issue found).
   - Evaluates transitions: routes to `system_create_issue`.
   - Executes GitHub CLI natively. Returns Issue #12.
   - Evaluates transitions: routes to `llm_implement_code`.
   - Returns formatted context and new instructions to the agent.
6. **Agent Action:** Agent writes code, then calls `advance_workflow` to progress to the PR creation step.

---

## 6. Implementation Roadmap

### Phase 1: Engine Core & Schema Validation

- Define the exact JSON Schema for the YAML workflow files.
- Build the TypeScript DAG parser that can load a workflow and validate it for infinite loops or orphaned nodes.

### Phase 2: State Context & Expression Evaluation

- Implement the Payload object manager.
- Integrate a safe JS expression evaluator (e.g., jexl or expr-eval) to handle the conditional logic in the transitions arrays.

### Phase 3: Pi Extension Boundary

- Create the `advance_workflow` Pi Extension wrapper.
- Implement the routing for `system_action` nodes to safely execute local bash/API commands within the agent's Docker environment.
- Rewrite the agent's global system prompt to deprecate the old Markdown skills and strictly route to the new DAWE extension.
