# Migration Guide: Markdown Skills → DAWE Workflows

> **Who is this for?** Agent engineers migrating existing Markdown-based Pi skills to DAWE workflow definitions.
>
> **What you'll learn:** How to convert skill files to YAML workflows, step-by-step migration checklist, and FAQ.

## Side-by-Side Comparison

### Old: Markdown Skill File

```markdown
# Development Orchestrator

## Activation

This skill activates when the user mentions development activities.

## Step 1: Project Identification

Ask yourself: "Is this related to any known project?"

- YES → Continue to Step 2
- NO → Continue to Step 4

## Step 2: Development Type Classification

Ask yourself: "What type of development activity is this?"

- Bug → Route to bug reporter skill
- Feature → Route to feature reporter skill

## Step 3: File Edit Assessment

Will this require editing any files?

- YES → Proceed with issue-first workflow
- NO → Route to guidance skills
```

### New: DAWE Workflow YAML

```yaml
version: '1.0'
workflow_name: development-orchestrator
description: Routes development requests to appropriate handlers.
initial_node: assess_intent

nodes:
  assess_intent:
    type: llm_decision
    instruction: >
      Analyze the user's request. Determine the project,
      whether edits are required, and the issue type.
    required_schema:
      project_name: string
      requires_edits: boolean
      issue_type: string
    transitions:
      - condition: 'payload.requires_edits == true'
        target: create_issue
      - condition: 'true'
        target: exit_info

  create_issue:
    type: system_action
    runtime: bash
    command: 'gh issue create --repo {{payload.project_name}} --title "{{payload.issue_type}}"'
    transitions:
      - condition: 'action_result.exit_code == 0'
        target: implement
      - condition: 'true'
        target: issue_failed

  implement:
    type: llm_task
    instruction: 'Implement the changes for {{payload.project_name}}.'
    completion_schema:
      status: string
    transitions:
      - condition: 'true'
        target: done

  done:
    type: terminal
    status: success
    message: 'Development workflow complete.'

  exit_info:
    type: terminal
    status: success
    message: 'No file edits required.'

  issue_failed:
    type: terminal
    status: failure
    message: 'Failed to create issue.'
```

## Key Differences

| Aspect         | Markdown Skills            | DAWE Workflows                                 |
| -------------- | -------------------------- | ---------------------------------------------- |
| Routing        | LLM reads and self-routes  | Engine evaluates transitions deterministically |
| State          | LLM must remember context  | Engine manages payload automatically           |
| System actions | LLM must call tools itself | Engine executes commands natively              |
| Error handling | LLM may skip or improvise  | Engine enforces transitions and fallbacks      |
| Cycles         | LLM may loop or give up    | Engine enforces `max_visits` budgets           |
| Observability  | None                       | Structured logging, error codes, events        |

## Migration Checklist

1. **Identify the workflow steps** — List all steps in the Markdown skill.
2. **Classify each step as a node type:**
   - Decision points → `llm_decision`
   - Open-ended work → `llm_task`
   - Automated commands → `system_action`
   - End states → `terminal`
3. **Define the transitions** — Map the "if X then go to Y" logic to `condition` expressions.
4. **Extract payload fields** — Identify what data flows between steps and define `required_schema` / `completion_schema`.
5. **Add error terminals** — Every failure path needs a `terminal` with `status: failure`.
6. **Test the workflow** — Load the YAML, validate it, and run through the engine.
7. **Add v2.0 features if needed** — Cycles, `extract_json`, stall detection.

## FAQ

### What happens to my existing skills?

Existing Markdown skills continue to work. DAWE workflows are additive — they don't replace the skill system, they provide an alternative for complex, multi-step pipelines where deterministic orchestration is needed.

### Can I mix skills and workflows?

Yes. A workflow can use `llm_task` nodes that reference skill knowledge. The workflow handles orchestration; the LLM uses its training and skills for the actual work within each task node.

### Do I need v2.0 for simple workflows?

No. Use `version: '1.0'` for linear workflows without cycles. It's simpler to validate and reason about.

### How do I handle conditional branching that was implicit in the Markdown?

In Markdown skills, the LLM implicitly decided which branch to take. In DAWE, you make this explicit:

1. Use an `llm_decision` node to extract the decision criteria into structured payload fields.
2. Write transition conditions that route based on those fields.

---

_See also: [Workflow Authoring Guide](./workflow-authoring-guide.md) · [Architecture](./architecture.md)_
