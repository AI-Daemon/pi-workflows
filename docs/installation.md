# Installation Guide

This guide covers everything you need to install, configure, verify, and troubleshoot **pi-workflows** — the Declarative Agent Workflow Engine (DAWE) for Pi agents.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Verification](#verification)
- [Your First Workflow](#your-first-workflow)
- [Bundled Example Workflows](#bundled-example-workflows)
- [User Workflow Directory](#user-workflow-directory)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Development Setup](#development-setup)

---

## Prerequisites

Before installing pi-workflows, ensure your environment meets these requirements:

- **Pi** version **0.56.1 or later** — pi-workflows uses the Pi Extension SDK (`ExtensionAPI`, `registerTool`, `on('session_start')`) and depends on packages bundled inside `@mariozechner/pi-coding-agent`.
- **Node.js** version **20.0.0 or later** — The engine uses modern ESM features (`import.meta.url`, top-level `await` in tests, `node:` protocol imports) that require Node.js 20+.
- **Docker context (typical)** — Pi runs inside Docker containers by default. The installation flow is fully Docker-compatible. No host-level changes are needed. The CWD inside the container is typically `/root` or a mounted project directory — pi-workflows resolves all paths relative to its installation location, not the CWD.

### Optional Prerequisites

Some bundled example workflows use external tools that must be available on `$PATH`:

- **`gh` CLI** — Required by `code-review`, `issue-first-development`, and `pr-creation` workflows for GitHub API operations (creating issues, PRs, searching). Install with `apt install gh` or see [cli.github.com](https://cli.github.com/).
- **`git`** — Required by workflows that create branches and push commits.

These are only needed if you plan to run the bundled workflows that interact with GitHub. The core engine and the `simple-task` example have no external dependencies.

---

## Installation

Install pi-workflows with a single command:

```bash
pi install https://github.com/AI-Daemon/pi-workflows
```

That's it. Here's what happens behind the scenes:

1. **Clone** — Pi clones the repository to `~/.pi/agent/git/github.com/AI-Daemon/pi-workflows/`.
2. **Install dependencies** — Pi runs `npm install`, which installs the runtime dependencies (`handlebars`, `jexl`, `uuid`, `yaml`, `zod`). Peer dependencies (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@sinclair/typebox`) are already available in the Pi runtime — they are not downloaded.
3. **Post-install hook** — Pi runs `install.sh`, which creates `~/.pi/workflows/` (the user workflow authoring directory) and prints a getting-started message.
4. **Extension registration** — Pi reads `package.json` → `pi.extensions` → registers `./src/extension/index.ts` as a Pi extension. Pi loads `.ts` extensions natively via tsx — no build step is required.
5. **Settings update** — The package URL is added to `~/.pi/agent/settings.json` → `packages[]`, so Pi loads it on every subsequent session.

For more details on how Pi packages work, see the [Pi packages documentation](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/packages.md).

### Pinning a Version

To install a specific version (tag or branch):

```bash
pi install https://github.com/AI-Daemon/pi-workflows@v1.0.0
```

---

## Verification

After installing, **restart Pi** to load the new extension. Then verify the installation step by step:

### Step 1: Check the Tool Is Registered

The `advance_workflow` tool should appear in Pi's available tools. You can ask Pi:

> "What tools do you have?"

Or call the tool directly:

```
advance_workflow({ action: 'list' })
```

**Expected result:** A list of 4 bundled workflows:

| Workflow                  | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `simple-task`             | A minimal hello-world workflow for testing              |
| `code-review`             | Automated PR code review workflow                       |
| `issue-first-development` | Full development lifecycle with bounded test-fix cycles |
| `pr-creation`             | Standalone pull request creation workflow               |

### Step 2: Start a Workflow

Start the simplest bundled workflow:

```
advance_workflow({ action: 'start', workflow_name: 'simple-task' })
```

**Expected result:** The engine creates a workflow instance and returns the first node's instructions, asking you to describe a task. You'll receive an `instance_id` and `current_node_id` to use in subsequent `advance` calls.

### Step 3: Verify User Workflow Directory

Check that the user authoring directory was created:

```bash
ls ~/.pi/workflows/
```

This directory should exist (created by `install.sh`). It will be empty initially — this is where you place your own `.yml` workflow files.

---

## Your First Workflow

Let's create a minimal custom workflow to verify end-to-end functionality.

### Step 1: Create the Workflow File

Create a file at `~/.pi/workflows/my-first-workflow.yml`:

```yaml
version: '1.0'
workflow_name: my-first-workflow
description: A simple custom workflow to verify installation.
initial_node: ask_name

nodes:
  ask_name:
    type: llm_decision
    instruction: |
      Ask the user for their name.
      Extract the name from their response.
    required_schema:
      name: string
    transitions:
      - condition: 'true'
        target: greet

  greet:
    type: terminal
    status: success
    message: 'Hello, {{payload.name}}! Your workflow is working.'
```

### Step 2: Reload and Verify

Restart Pi (or use `/reload` if available), then list workflows:

```
advance_workflow({ action: 'list' })
```

You should see `my-first-workflow` alongside the 4 bundled examples.

### Step 3: Run It

```
advance_workflow({ action: 'start', workflow_name: 'my-first-workflow' })
```

The agent will ask for your name, then advance to the terminal node with a personalized greeting.

### Anatomy of a Workflow File

Every workflow YAML file has these required fields:

- **`version`** — Schema version (`'1.0'` or `'2.0'`). Use `'2.0'` for bounded cycles, `extract_json`, and `$metadata.visits`.
- **`workflow_name`** — Unique identifier. Must be unique across all discovered workflows.
- **`description`** — Human-readable description shown in `list` output.
- **`initial_node`** — The name of the first node to execute when the workflow starts.
- **`nodes`** — A map of node definitions. Each node has a `type` and type-specific fields.

For the complete authoring reference, see the [Workflow Authoring Guide](./workflow-authoring-guide.md).

---

## Bundled Example Workflows

pi-workflows ships with 4 example workflows in `workflows/examples/`. These are automatically discovered and available after installation — you do not need to copy them anywhere.

### `simple-task` — Minimal Hello World

The simplest possible workflow. Asks the agent to describe a task, then acknowledges it. Use this for:

- Verifying the installation works
- Understanding the basic workflow structure
- As a template for new workflows

**Prerequisites:** None.

### `code-review` — Automated PR Review

A structured code review workflow that guides the agent through reviewing a pull request. The agent examines the diff, checks for issues, and produces a structured review.

**Prerequisites:** `gh` CLI authenticated with repository access.

### `issue-first-development` — Full Development Lifecycle

The most comprehensive bundled workflow. Replicates a full issue-first development cycle:

1. Agent assesses the user's development intent
2. Agent resolves the local project directory
3. System checks for existing GitHub issues (or creates one)
4. Agent sets up a feature branch
5. Agent implements code changes
6. System runs the test suite with **bounded cycles** (up to 3 attempts)
7. Agent fixes failing tests (cycles back to test runner)
8. System creates a pull request

This workflow demonstrates every v2.0 feature:

- **`max_visits: 3`** — Bounded test-fix cycle prevents infinite loops
- **`extract_json`** — Structured test output parsed from a JSON file
- **`$metadata.visits`** — Cycle-aware agent instructions ("attempt 2 of 3")
- **`suspended` terminal** — Human intervention fallback when budget exhausts
- **Stall detection** — SHA-256 workspace hashing prevents idempotent fix loops

**Prerequisites:** `gh` CLI, `git`, a project with a test suite.

### `pr-creation` — Standalone PR Creation

A focused workflow for creating pull requests after manual coding. Assumes code changes are already committed to a feature branch:

1. Agent gathers PR details (title, description, base branch)
2. Agent provides the local project directory
3. System verifies commits ahead of base
4. System runs lint and test checks
5. System pushes the branch
6. System creates the PR via `gh`

**Prerequisites:** `gh` CLI, `git`, an existing branch with commits.

---

## User Workflow Directory

### Location

All user-authored workflows go in:

```
~/.pi/workflows/
```

This directory is created automatically by the `install.sh` post-install script. If it doesn't exist, create it manually:

```bash
mkdir -p ~/.pi/workflows/
```

### How Auto-Discovery Works

When Pi starts a session, the pi-workflows extension scans three directories for `.yml` and `.yaml` files:

1. **Bundled examples** — `<package-root>/workflows/examples/` (always available)
2. **User workflows** — `~/.pi/workflows/` (your custom workflows)
3. **Project-local workflows** — `./workflows/` relative to CWD (development convenience)

Each YAML file is parsed, validated against the workflow schema, and cached in the `WorkflowRegistry`. Invalid files produce warnings but do not prevent other workflows from loading.

### Name Conflicts

If two workflow files in different directories share the same `workflow_name`, the **last loaded wins**. Since directories are scanned in the order listed above:

- A user workflow in `~/.pi/workflows/` overrides a bundled example with the same name.
- A project-local workflow in `./workflows/` overrides both.

The registry logs a warning when a duplicate name is detected.

### Reloading After Changes

After adding, editing, or removing workflow files in `~/.pi/workflows/`:

- **Restart Pi** — The extension rescans all directories on session start.
- **`/reload`** — If your Pi version supports extension reloading, this triggers a rescan.

Workflows are loaded into memory at session start. Changes to YAML files are not hot-reloaded during a session.

---

## Configuration

### Environment Variables

The DAWE engine respects the following environment variables:

| Variable            | Description                                                          | Default  |
| ------------------- | -------------------------------------------------------------------- | -------- |
| `DAWE_LOG_LEVEL`    | Log level: `debug`, `info`, `warn`, `error`                          | `warn`   |
| `DAWE_LOG_FORMAT`   | Log format: `json`, `pretty`                                         | `json`   |
| `DAWE_SCRIPTS_DIR`  | Absolute path to global bundled scripts directory (auto-injected)    | _(auto)_ |
| `DAWE_PACKAGE_ROOT` | Absolute path to package root directory (auto-injected)              | _(auto)_ |
| `DAWE_WORKFLOW_SCRIPTS_DIR` | Absolute path to the current workflow's own `scripts/` directory, if it exists (auto-injected) | _(auto)_ |

**`DAWE_SCRIPTS_DIR`, `DAWE_WORKFLOW_SCRIPTS_DIR`, and `DAWE_PACKAGE_ROOT`** are automatically injected into the environment of every `system_action` command by the extension. You do not need to set them manually. They are available in your workflow scripts as `$DAWE_SCRIPTS_DIR`, `$DAWE_WORKFLOW_SCRIPTS_DIR`, and `$DAWE_PACKAGE_ROOT`.

- **`DAWE_SCRIPTS_DIR`** points to the global `workflows/_scripts/` directory for shared scripts.
- **`DAWE_WORKFLOW_SCRIPTS_DIR`** points to a workflow's own `scripts/` subdirectory (e.g., `workflows/my-workflow/scripts/`). This is only set when the workflow has its own scripts directory; otherwise it is unset.

The following variables are also auto-injected into every `system_action` execution:

| Variable             | Description                              |
| -------------------- | ---------------------------------------- |
| `DAWE_WORKFLOW_NAME` | Name of the currently executing workflow |
| `DAWE_NODE_ID`       | ID of the currently executing node       |
| `DAWE_INSTANCE_ID`   | ID of the current workflow instance      |

### Logging

To enable debug logging for troubleshooting:

```bash
export DAWE_LOG_LEVEL=debug
export DAWE_LOG_FORMAT=pretty
```

Then restart Pi. The engine will log detailed information about workflow loading, node execution, transition evaluation, and system action results.

---

## Troubleshooting

### "advance_workflow tool not found"

**Cause:** Pi has not loaded the extension yet.

**Fix:** Restart Pi after running `pi install`. The extension is registered on the next session start. Verify the package is in your settings:

```bash
cat ~/.pi/agent/settings.json | grep pi-workflows
```

If the URL is not listed, re-run:

```bash
pi install https://github.com/AI-Daemon/pi-workflows
```

### "No workflows available" (empty list)

**Cause:** The workflow directories are empty or inaccessible.

**Fix:**

1. Check that `~/.pi/workflows/` exists: `ls ~/.pi/workflows/`
2. Verify the package was cloned correctly: `ls ~/.pi/agent/git/github.com/AI-Daemon/pi-workflows/workflows/examples/`
3. Check that your YAML files are valid — try pasting one into `advance_workflow({ action: 'start', workflow_name: '...' })` to see validation errors.

### "Workflow validation failed"

**Cause:** The YAML file has schema errors.

**Fix:** Common issues:

- Missing `version`, `workflow_name`, `description`, or `initial_node` fields
- `initial_node` references a node name that doesn't exist in the `nodes` map
- Node type-specific fields are missing (e.g., `llm_task` requires `instruction` and `completion_schema`)
- Transition `target` references a nonexistent node
- Version `'2.0'` features used with `version: '1.0'`

See the [Error Code Reference](./error-code-reference.md) for specific error codes and recovery hints.

### "System action failed"

**Cause:** A `system_action` node's command failed to execute.

**Fix:**

- **Missing `gh` CLI** — Install with `apt install gh` and authenticate with `gh auth login`
- **Permission errors** — Ensure scripts are executable: `chmod +x ~/.pi/agent/git/github.com/AI-Daemon/pi-workflows/workflows/_scripts/*.sh`
- **Script not found** — If you see "No such file or directory", check that `$DAWE_SCRIPTS_DIR` is being injected. Restart Pi to ensure the extension loads. For per-workflow scripts, verify the workflow has a `scripts/` subdirectory and that `$DAWE_WORKFLOW_SCRIPTS_DIR` is set.

### "Tests fail in workflow"

**Cause:** The bounded test-fix cycle reached its `max_visits` limit.

**Fix:** This is expected behavior. When `run_tests` has been visited `max_visits` times and tests still fail, the workflow transitions to a `suspended` terminal node. This signals that human intervention is required. The agent cannot break out of this limit — it is a safety mechanism. Review the test output in the file pointer log at `/tmp/dawe-runs/`.

### Checking Pi Logs for DAWE Errors

DAWE errors are logged via `DAWELogger`. To see them, set the log level:

```bash
export DAWE_LOG_LEVEL=debug
```

Log entries include structured metadata: error codes, node IDs, instance IDs, and stack traces. Look for entries with `component: 'executor'`, `component: 'evaluator'`, or `component: 'stall-detector'`.

---

## Updating

To update to the latest version:

```bash
pi install https://github.com/AI-Daemon/pi-workflows
```

Pi will pull the latest changes, re-run `npm install`, and re-run `install.sh`. Your user workflows in `~/.pi/workflows/` are not affected — only the package itself is updated.

To pin to a specific version:

```bash
pi install https://github.com/AI-Daemon/pi-workflows@v1.0.0
```

After updating, restart Pi to load the new version.

---

## Uninstalling

To remove pi-workflows:

```bash
pi remove https://github.com/AI-Daemon/pi-workflows
```

This removes the package from `~/.pi/agent/settings.json` and deletes the cloned repository from `~/.pi/agent/git/`.

**Note:** Your user-authored workflows in `~/.pi/workflows/` are **not deleted**. This directory is yours — the uninstaller does not touch it. If you want to remove it manually:

```bash
rm -rf ~/.pi/workflows/
```

---

## Development Setup

This section is for contributors who want to work on the DAWE engine itself. If you just want to **use** pi-workflows, the `pi install` command above is all you need.

### Clone and Build

```bash
git clone https://github.com/AI-Daemon/pi-workflows.git
cd pi-workflows
npm install
npm run build
```

### Run Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests only
npm run test:e2e
```

### Lint

```bash
npm run lint
npm run lint:fix  # auto-fix
```

### Development vs. Installation

| Aspect             | `pi install` (user)                           | `git clone` (developer)                |
| ------------------ | --------------------------------------------- | -------------------------------------- |
| Location           | `~/.pi/agent/git/.../pi-workflows/`           | Anywhere you clone                     |
| Dependencies       | Only `dependencies` installed                 | `dependencies` + `devDependencies`     |
| Extension loading  | Automatic via `pi.extensions` in package.json | Manual (import the module directly)    |
| Build required     | No (Pi loads `.ts` via tsx)                   | Yes (`npm run build` for dist/)        |
| Workflow discovery | Bundled + `~/.pi/workflows/` + CWD            | CWD `./workflows/` (default for tests) |

When developing, the `resolve('./workflows')` path in the default `WorkflowRegistry` constructor points to the repo's `workflows/` directory (since CWD is the repo root). This is how tests discover fixtures and examples without any special configuration.

For more on contributing, see the [Contributing Guide](./contributing.md).
