# pi-workflows — Declarative Agent Workflow Engine (DAWE)

A state-machine-based workflow engine for Pi agents. Replaces text-based skill routing with deterministic YAML/JSON DAG workflows.

## Problem

Pi agents currently rely on a progressive disclosure mechanism using Markdown files (`~/.pi/agent/skills/`) to execute complex, multi-step development pipelines. This architecture fails because it relies on the LLM to autonomously chain multi-hop text file reads, retain massive procedural context (400+ lines), and self-route. LLMs are non-deterministic and frequently experience choice paralysis or skip steps entirely when presented with procedural SOPs.

## Solution

Deprecate the text-based routing files and implement a **Declarative State Machine** represented as a **Directed Acyclic Graph (DAG)**. Workflows are defined in strict YAML/JSON configurations. The Pi agent interacts with a single, universal Extension Tool (`advance_workflow`). The engine spoon-feeds the agent its exact current state, required actions, and strict boundaries — completely removing the LLM's burden of orchestration while providing a highly extensible, "low-code" architecture for the engineering team.

## Architecture

The DAWE architecture consists of three distinct layers:

1. **Definition Layer (YAML/JSON)** — Declarative configuration files that define nodes, transitions, and state requirements. The "no-code" interface for adding/removing workflow steps.
2. **Execution Engine (TypeScript/Node.js)** — The runtime that parses YAML files, manages state payload, evaluates conditional transitions, and executes system-level scripts natively (bypassing the LLM).
3. **Agent Interface (Pi Extension Tool)** — The boundary layer. A single tool exposed to the Pi agent that acts as a pager, sending LLM outputs to the engine and returning the next node's strict instructions.

## Node Types

| Type | Description |
|------|-------------|
| `llm_decision` | Prompts the agent to extract specific JSON variables from user text |
| `llm_task` | Hands control to the agent for open-ended work with strict completion criteria |
| `system_action` | Executes purely in the engine (API calls, bash, Docker) without LLM intervention |

## Workflow Schema Example

```yaml
version: "1.0"
workflow_name: "issue-first-development"
description: "Enforces GitHub issue creation before code implementation."
initial_node: "assess_intent"

nodes:
  assess_intent:
    type: "llm_decision"
    instruction: "Analyze the user request. Identify the target repository and whether file edits are required."
    required_schema:
      project_name: "string"
      requires_edits: "boolean"
    transitions:
      - condition: "payload.requires_edits == false"
        target: "exit_informational"
      - condition: "payload.requires_edits == true"
        target: "system_check_issue"

  system_check_issue:
    type: "system_action"
    runtime: "bash"
    command: "./scripts/check-gh-issue.sh {{payload.project_name}}"
    transitions:
      - condition: "action_result.exit_code == 0"
        target: "llm_implement_code"
      - condition: "action_result.exit_code != 0"
        target: "system_create_issue"
```

## State Management (Context Payload)

The engine maintains a mutable JSON object called the **Payload** throughout the lifecycle of a workflow instance.

- **Hydration** — As the graph transitions node-to-node, outputs from `llm_decision` and `system_action` nodes are merged into the payload.
- **Templating** — Node instructions and system commands dynamically inject variables using Handlebars syntax (`{{payload.project_name}}`).
- **Context Isolation** — The LLM does not need to remember step 1 when it reaches step 5. The engine templates accumulated facts into the current node's prompt.

## Agent Interface — `advance_workflow` Tool

```json
{
  "name": "advance_workflow",
  "description": "REQUIRED tool to progress through development workflows.",
  "parameters": {
    "type": "object",
    "properties": {
      "workflow_instance_id": { "type": "string" },
      "current_node_id": { "type": "string" },
      "node_payload": { "type": "object" }
    },
    "required": ["current_node_id", "node_payload"]
  }
}
```

## Implementation Roadmap

- **Phase 1:** Engine Core & Schema Validation — JSON Schema for YAML files, TypeScript DAG parser, loop/orphan detection
- **Phase 2:** State Context & Expression Evaluation — Payload manager, safe JS expression evaluator (jexl/expr-eval), Handlebars templating
- **Phase 3:** Pi Extension Boundary — `advance_workflow` tool wrapper, system_action executor, global prompt integration

## Tech Stack

- TypeScript / Node.js
- YAML workflow definitions with JSON Schema validation
- Handlebars for template interpolation
- jexl or expr-eval for safe conditional expression evaluation
- Pi Extension SDK for tool registration

## License

MIT
