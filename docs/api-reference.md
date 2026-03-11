# API Reference

> **Who is this for?** Engine developers who extend, maintain, or integrate with the DAWE TypeScript codebase.
>
> **What you'll learn:** Every public type, function, and class in the engine, with signatures, parameters, return types, and runnable examples.

## Table of Contents

- [Schema Module](#schema-module)
- [Engine Module](#engine-module)
- [Utils Module](#utils-module)
- [Extension Module](#extension-module)
- [Persistence Module](#persistence-module)
- [Types Index](#types-index)

---

## Schema Module

**Location:** `src/schemas/`

### `validateWorkflow(raw: unknown): Result<WorkflowDefinition, ValidationError[]>`

Validates a raw (already-parsed) JavaScript object against the Zod workflow schema. Returns all errors found (structural + cross-field) in a single pass.

```typescript
import { validateWorkflow } from '@ai-daemon/pi-workflows';

const raw = {
  version: '1.0',
  workflow_name: 'my-workflow',
  description: 'Example',
  initial_node: 'start',
  nodes: {
    start: {
      type: 'llm_decision',
      instruction: 'What do you need?',
      required_schema: { intent: 'string' },
      transitions: [{ condition: 'true', target: 'done' }],
    },
    done: { type: 'terminal', status: 'success' },
  },
};

const result = validateWorkflow(raw);
if (result.ok) {
  console.log('Valid:', result.data.workflow_name);
} else {
  console.error('Errors:', result.errors);
}
```

### `loadWorkflow(yamlString: string, existingNames?: Set<string>): Result<WorkflowDefinition, ValidationError[]>`

Parses a YAML string and validates the result. Optionally checks for duplicate workflow names.

```typescript
import { loadWorkflow } from '@ai-daemon/pi-workflows';
import { readFileSync } from 'fs';

const yaml = readFileSync('workflows/examples/simple-task.yml', 'utf-8');
const result = loadWorkflow(yaml);
if (result.ok) {
  console.log(`Loaded: ${result.data.workflow_name} (${result.data.version})`);
}
```

### Exported Zod Types

| Type                 | Description                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `WorkflowDefinition` | Top-level workflow object                                                                 |
| `NodeDefinition`     | Discriminated union: `LlmDecisionNode \| LlmTaskNode \| SystemActionNode \| TerminalNode` |
| `Transition`         | `{ condition: string, target: string, priority?: number }`                                |
| `LlmDecisionNode`    | Node with `required_schema`, `retry`                                                      |
| `LlmTaskNode`        | Node with `completion_schema`, `context_keys`                                             |
| `SystemActionNode`   | Node with `runtime`, `command`, `env`, `extract_json` (v2.0), `max_visits` (v2.0)         |
| `TerminalNode`       | Node with `status`: `'success' \| 'failure' \| 'cancelled' \| 'suspended'`                |

### `SchemaErrorCode` Enum

All schema validation error codes:

| Code                          | Description                      |
| ----------------------------- | -------------------------------- |
| `INVALID_YAML`                | YAML parse failure               |
| `MISSING_REQUIRED_FIELD`      | Required field absent            |
| `INVALID_FIELD_TYPE`          | Wrong type or value              |
| `INVALID_NODE_REFERENCE`      | Nonexistent target node          |
| `MISSING_TERMINAL_NODE`       | No terminal node                 |
| `INITIAL_NODE_IS_TERMINAL`    | initial_node is terminal         |
| `TERMINAL_HAS_TRANSITIONS`    | Terminal with transitions        |
| `NON_TERMINAL_NO_TRANSITIONS` | Non-terminal without transitions |
| `INVALID_WORKFLOW_NAME`       | Name format violation            |
| `DUPLICATE_WORKFLOW_NAME`     | Name collision                   |
| `INVALID_EXPRESSION_SYNTAX`   | Bad condition syntax             |

### `ValidationError` Interface

```typescript
interface ValidationError {
  path: string; // e.g., "nodes.assess_intent.transitions[0].target"
  message: string; // Human-readable description
  code: string; // SchemaErrorCode value
}
```

---

## Engine Module

**Location:** `src/engine/`

### `DAGParser`

Builds and validates the graph representation of a workflow. Stateless after construction.

**Constructor:** `new DAGParser(workflow: WorkflowDefinition, options?: DAGParserOptions)`

| Option     | Type       | Default    | Description                 |
| ---------- | ---------- | ---------- | --------------------------- |
| `maxDepth` | number     | 50         | Maximum allowed graph depth |
| `logger`   | DAWELogger | warn-level | Structured logger           |

**Methods:**

#### `parse(): DAGGraph`

Builds the adjacency-list representation from the workflow definition.

```typescript
const parser = new DAGParser(workflowDef);
const graph = parser.parse();
console.log(`Nodes: ${graph.nodes.size}, Initial: ${graph.initialNodeId}`);
```

#### `validate(): GraphValidationResult`

Runs all structural validations. Version-aware:

- v1.0: `detectCycles()` rejects all cycles
- v2.0: `validateBoundedCycles()` — cycles with `max_visits` allowed, unbounded rejected

```typescript
const result = parser.validate();
if (result.valid) {
  console.log(`Graph OK: ${result.stats.totalNodes} nodes, depth ${result.stats.maxDepth}`);
} else {
  for (const err of result.errors) {
    console.error(`[${err.code}] ${err.message} — nodes: ${err.nodeIds.join(', ')}`);
  }
}
```

#### `validateWithCollector(): { result: GraphValidationResult; collector: ErrorCollector }`

Returns graph validation errors wrapped in `DAWEError` instances via an `ErrorCollector`.

### `ExpressionEvaluator`

Sandboxed jexl expression evaluator for workflow transitions.

**Constructor:** `new ExpressionEvaluator(options?: { timeoutMs?: number; logger?: DAWELogger })`

| Option      | Type       | Default    | Description              |
| ----------- | ---------- | ---------- | ------------------------ |
| `timeoutMs` | number     | 100        | Evaluation timeout in ms |
| `logger`    | DAWELogger | warn-level | Structured logger        |

**Built-in transforms:** `lower`, `upper`, `length`, `trim`

#### `validateSyntax(expression: string): Result<void, ExpressionError>`

Checks expression syntax without evaluating. No context needed.

#### `evaluate(expression: string, context: ExpressionContext): Promise<Result<boolean, ExpressionError>>`

Evaluates an expression against a context. Must return boolean. `null`/`undefined` → `false`.

```typescript
const evaluator = new ExpressionEvaluator();
const result = await evaluator.evaluate('payload.count > 5', {
  payload: { count: 10 },
});
// result = { ok: true, data: true }
```

#### `evaluateTransitions(transitions: Transition[], context: ExpressionContext): Promise<Result<string | null, ExpressionError>>`

Evaluates all transitions sorted by priority. Returns the first matching target node ID, or `null` if none match.

#### `explainEvaluation(expression: string, context: ExpressionContext): Promise<string>`

Returns a human-readable trace showing expression, context, and result. Useful for debugging.

### `PayloadManager`

Structured, immutable-by-default state container for workflow context.

**Constructor:** `new PayloadManager(initialPayload?: Record<string, unknown>, options?: { logger?: DAWELogger })`

#### Core Methods

| Method                       | Returns                                  | Description                               |
| ---------------------------- | ---------------------------------------- | ----------------------------------------- |
| `getPayload()`               | `Readonly<Record<string, unknown>>`      | Deep clone of current payload             |
| `merge(nodeId, data)`        | `void`                                   | Deep merge data into payload with history |
| `getScoped(keys)`            | `Record<string, unknown>`                | Scoped view by dot-path keys              |
| `resolveTemplate(template)`  | `Result<string, TemplateError>`          | Resolve Handlebars against payload        |
| `getHistory()`               | `PayloadHistoryEntry[]`                  | Full merge history                        |
| `serialize()`                | `string`                                 | JSON serialization                        |
| `deserialize(json)` (static) | `PayloadManager`                         | Restore from JSON                         |
| `reset()`                    | `void`                                   | Clear payload and history                 |
| `validatePayload(schema)`    | `Result<void, PayloadValidationError[]>` | Validate against Zod schema               |
| `diffFromLastMerge()`        | `Record<string, { before, after }>`      | Diff of last merge                        |
| `isWithinSizeLimit()`        | `boolean`                                | Check serialized size < 1MB               |

```typescript
const pm = new PayloadManager({ project: 'myapp' });
pm.merge('assess_intent', { requires_edits: true, description: 'Fix bug' });
console.log(pm.getPayload());
// { project: 'myapp', requires_edits: true, description: 'Fix bug' }

const scoped = pm.getScoped(['project', 'description']);
// { project: 'myapp', description: 'Fix bug' }
```

**Protected keys:** `$metadata` is reserved. Attempts to merge `$metadata` are silently dropped with a debug log.

### `SystemActionExecutor`

Secure, sandboxed executor for `system_action` nodes.

**Constructor:** `new SystemActionExecutor(options?: Partial<ExecutorOptions> & { logger?: DAWELogger })`

| Option            | Type       | Default         | Description                 |
| ----------------- | ---------- | --------------- | --------------------------- |
| `defaultTimeout`  | number     | 30000           | Default timeout in ms       |
| `maxTimeout`      | number     | 300000          | Maximum timeout in ms       |
| `workingDir`      | string     | `process.cwd()` | Default working directory   |
| `shell`           | string     | `/bin/bash`     | Shell path                  |
| `blockedCommands` | string[]   | (built-in)      | Additional blocked patterns |
| `env`             | Record     | —               | Base environment variables  |
| `logger`          | DAWELogger | warn-level      | Structured logger           |

#### `execute(node, context, callbacks?): Promise<Result<ExecutorActionResult, SecurityError>>`

Executes a system action: resolves templates, validates security, spawns process.

#### `validateCommand(command: string): Result<void, SecurityError>`

Validates a command against blocked patterns before execution.

#### `dryRun(node, context): Result<ExecutorActionResult, SecurityError>`

Resolves the command template without executing. Returns a mock result with exit_code 0.

#### `executeWithRetry(node, context, retry, callbacks?): Promise<Result<ExecutorActionResult, SecurityError>>`

Executes with exponential backoff retry logic on non-zero exit codes.

#### `writeFilePointerLog(instanceId, nodeId, visitCount, command, result): string | null`

Writes full stdout/stderr to `/tmp/dawe-runs/<instanceId>-<nodeId>-<visitCount>.log`. Returns the file path or null on failure.

#### `cleanupFilePointerLogs(instanceId): number`

Removes all log files for a given instance. Called on terminal state.

### `WorkflowRuntime`

The orchestrator. Manages workflow instance lifecycle.

**Constructor:** `new WorkflowRuntime(options?: RuntimeOptions)`

| Option                 | Type                     | Default               | Description                                 |
| ---------------------- | ------------------------ | --------------------- | ------------------------------------------- |
| `executorOptions`      | Partial<ExecutorOptions> | —                     | Passed to SystemActionExecutor              |
| `maxChainLength`       | number                   | 20                    | Max consecutive system_action auto-advances |
| `instanceStore`        | InstanceStore            | InMemoryInstanceStore | Persistence backend                         |
| `stallDetectorOptions` | StallDetectorOptions     | —                     | Passed to StallDetector                     |
| `logger`               | DAWELogger               | warn-level            | Structured logger                           |

#### `loadWorkflow(yamlString: string): Result<string, ValidationError[]>`

Loads and validates a workflow from YAML. Returns the internal workflow ID (UUID).

#### `startInstance(workflowId, initialPayload?): Promise<Result<AdvanceResult, RuntimeError>>`

Starts a new workflow instance. Auto-advances through system_action nodes.

#### `advance(instanceId, nodeId, nodePayload): Promise<Result<AdvanceResult, RuntimeError>>`

Advances an instance with agent-submitted payload. Validates schema, merges payload, evaluates transitions, enforces cycle budgets, runs stall detection.

#### `getInstance(instanceId): Promise<WorkflowInstance | null>`

Returns the current state of an instance.

#### `listInstances(): Promise<WorkflowInstance[]>`

Lists all stored instances.

#### `cancelInstance(instanceId): Promise<Result<void, RuntimeError>>`

Cancels an active instance.

#### Events

| Event                    | Signature                                    | Description               |
| ------------------------ | -------------------------------------------- | ------------------------- |
| `node:entered`           | `(instanceId, nodeId) => void`               | Node processing started   |
| `node:completed`         | `(instanceId, nodeId, result?) => void`      | Node processing completed |
| `instance:completed`     | `(instanceId, terminalStatus) => void`       | Instance reached terminal |
| `system_action:executed` | `(instanceId, nodeId, actionResult) => void` | System action completed   |
| `error`                  | `(instanceId, error: RuntimeError) => void`  | Runtime error occurred    |

### `StallDetector`

SHA-256 workspace state hashing for bounded cycle safety.

**Constructor:** `new StallDetector(options?: StallDetectorOptions)`

| Option           | Type       | Default         | Description                  |
| ---------------- | ---------- | --------------- | ---------------------------- |
| `workingDir`     | string     | `process.cwd()` | Directory for git operations |
| `includeGitDiff` | boolean    | true            | Include git diff in hash     |
| `logger`         | DAWELogger | warn-level      | Structured logger            |

#### `check(previousHashes: string[], actionOutput: string): Promise<StallCheckResult>`

Computes a hash and compares against previous hashes. Returns `{ stalled, currentHash, matchedPreviousHash?, iterationNumber }`.

```typescript
const detector = new StallDetector({ includeGitDiff: false });
const result = await detector.check([], 'test output');
console.log(result.stalled); // false
console.log(result.currentHash); // "a1b2c3..."

const result2 = await detector.check([result.currentHash], 'test output');
console.log(result2.stalled); // true — same output!
```

#### `computeHash(actionOutput: string): Promise<string>`

Computes the SHA-256 hash of `gitDiffOutput + SEPARATOR + actionOutput`.

### `JsonExtractor`

#### `extractJson(filePath: string): Promise<JsonExtractionResult>`

Reads and parses a JSON file. Never throws.

```typescript
import { extractJson } from '@ai-daemon/pi-workflows';

const result = await extractJson('/tmp/test-results.json');
if (result.success) {
  console.log(result.data); // Parsed JSON object
} else {
  console.log(result.error); // Error description
  console.log(result.fallbackToPointer); // true
}
```

---

## Utils Module

**Location:** `src/utils/`

### `DAWEError` — Base Error Class

Every error in the engine is (or wraps) a `DAWEError`. It carries a code, category, severity, recovery hint, and arbitrary context.

**Constructor:**

```typescript
new DAWEError(code: string, message: string, options?: {
  category?: ErrorCategory;
  severity?: ErrorSeverity;
  recoverable?: boolean;
  agentHint?: string;
  context?: Record<string, unknown>;
  cause?: Error;
})
```

Fields are auto-filled from the error code registry when available, then overridden by explicit options.

**Methods:**

#### `toJSON(): SerializedError`

Machine-readable JSON serialization.

```typescript
const error = new DAWEError('R-001', 'No matching transition', {
  context: { nodeId: 'assess_intent', instanceId: 'abc-123' },
});

console.log(JSON.stringify(error.toJSON(), null, 2));
// {
//   "code": "R-001",
//   "message": "No matching transition",
//   "category": "runtime",
//   "severity": "error",
//   "recoverable": true,
//   "agentHint": "Check your payload values against the transition conditions.",
//   "context": { "nodeId": "assess_intent", "instanceId": "abc-123" }
// }
```

#### `toAgentMessage(): string`

Formatted English text for the Pi agent, including recovery hint.

```typescript
console.log(error.toAgentMessage());
// ERROR (R-001): No matching transition
//
// nodeId: assess_intent
// instanceId: abc-123
//
// RECOVERY: Check your payload values against the transition conditions.
```

### Error Subclasses

Each subclass auto-sets its `category`:

| Class                       | Category     | When to Use                                         |
| --------------------------- | ------------ | --------------------------------------------------- |
| `SchemaValidationError`     | `schema`     | YAML parsing and schema validation failures         |
| `GraphValidationError`      | `graph`      | Structural graph issues (cycles, unreachable nodes) |
| `ExpressionEvaluationError` | `expression` | jexl evaluation failures                            |
| `PayloadError`              | `payload`    | Merge failures, protected key violations            |
| `SystemActionError`         | `execution`  | Command execution failures                          |
| `RuntimeError`              | `runtime`    | Lifecycle errors (instance not found, etc.)         |
| `SecurityViolationError`    | `security`   | Blocked command patterns                            |
| `CycleSafetyError`          | `cycle`      | Stall detection, budget exhaustion                  |

```typescript
import { CycleSafetyError } from '@ai-daemon/pi-workflows';

const error = new CycleSafetyError('C-001', 'Stall detected', {
  context: { nodeId: 'run_tests', hash: 'abc123' },
});
console.log(error.category); // 'cycle'
```

### Error Code Registry

**`ERROR_CODES`** — The single source of truth for all error codes.

```typescript
import { ERROR_CODES, getErrorCodeEntry } from '@ai-daemon/pi-workflows';

// Look up an entry
const entry = getErrorCodeEntry('R-001');
console.log(entry);
// {
//   message: 'No matching transition',
//   category: 'runtime',
//   recoverable: true,
//   agentHint: 'Check your payload values against the transition conditions.'
// }

// Construct an error from a code
const error = new DAWEError('R-001', entry.message);
// category, severity, recoverable, agentHint auto-filled from registry
```

**`ErrorCode` type** — Union of all valid error code strings (`'S-001' | 'S-002' | ... | 'P-007'`).

### `ErrorCollector`

Accumulates multiple `DAWEError` instances for validation pipelines.

```typescript
import { ErrorCollector, SchemaValidationError } from '@ai-daemon/pi-workflows';

const collector = new ErrorCollector();
collector.add(new SchemaValidationError('S-002', 'Missing version field'));
collector.add(new SchemaValidationError('S-004', 'Invalid target: "nonexistent"'));

console.log(collector.hasErrors()); // true
console.log(collector.hasFatal()); // false

const schemaErrors = collector.getByCategory('schema');
console.log(schemaErrors.length); // 2

console.log(collector.toSummary());
// 2 error(s):
//   [S-002] (error) Missing version field
//   [S-004] (error) Invalid target: "nonexistent"

// Convert to Result
const result = collector.toResult();
// { ok: false, errors: [SchemaValidationError, SchemaValidationError] }
```

### `DAWELogger`

Structured logger with JSON or pretty output.

**Constructor:**

```typescript
new DAWELogger(options?: {
  level?: 'debug' | 'info' | 'warn' | 'error';
  format?: 'json' | 'pretty';
  context?: Record<string, unknown>;
  output?: (line: string) => void;
})
```

**Environment variables:**

- `DAWE_LOG_LEVEL` — Override minimum log level
- `DAWE_LOG_FORMAT` — Override output format

**Methods:** `debug(message, context?)`, `info(message, context?)`, `warn(message, context?)`, `error(message, error?, context?)`

#### `child(context: Record<string, unknown>): DAWELogger`

Creates a child logger with persistent context fields.

```typescript
const logger = new DAWELogger({ level: 'debug', format: 'json' });
const childLogger = logger.child({ component: 'executor', instanceId: 'abc-123' });

childLogger.info('Command started', { command: 'npm test' });
// {"timestamp":"...","level":"info","message":"Command started","component":"executor","instanceId":"abc-123","command":"npm test"}
```

#### Testing with Injectable Output

```typescript
const logs: string[] = [];
const logger = new DAWELogger({
  level: 'debug',
  format: 'json',
  output: (line) => logs.push(line),
});

logger.info('Test message', { key: 'value' });
expect(logs.some((l) => l.includes('"message":"Test message"'))).toBe(true);
```

### `Result<T, E>` Type

Discriminated union for typed success/error handling:

```typescript
type Result<T, E> = { ok: true; data: T } | { ok: false; errors: E };
```

Used throughout the codebase. Check `result.ok` before accessing `result.data` or `result.errors`.

---

## Extension Module

**Location:** `src/extension/`

### `advance_workflow` Tool

The agent-facing interface. Supports five actions:

| Action    | Required Params                                  | Description              |
| --------- | ------------------------------------------------ | ------------------------ |
| `list`    | —                                                | Show available workflows |
| `start`   | `workflow_name`                                  | Begin a new instance     |
| `advance` | `instance_id`, `current_node_id`, `node_payload` | Submit agent data        |
| `status`  | `instance_id`                                    | Show instance state      |
| `cancel`  | `instance_id`                                    | Abort an instance        |

#### `AdvanceWorkflowHandler`

```typescript
const handler = new AdvanceWorkflowHandler(runtime, registry);
const output = await handler.handle({
  action: 'start',
  workflow_name: 'issue-first-development',
});
console.log(output.text); // Formatted markdown
console.log(output.isError); // undefined (success)
```

### `WorkflowRegistry`

Scans directories for YAML workflow definitions, validates, and caches.

**Constructor:** `new WorkflowRegistry(workflowDirs?: string[], options?: { logger?: DAWELogger })`

Default scan paths: `./workflows/`, `~/.pi/workflows/`

| Method          | Returns                           | Description                  |
| --------------- | --------------------------------- | ---------------------------- |
| `loadAll()`     | `Promise<void>`                   | Scan and cache all workflows |
| `get(name)`     | `WorkflowDefinition \| undefined` | Get by name                  |
| `list()`        | `WorkflowSummary[]`               | List all available           |
| `reload(name)`  | `Promise<void>`                   | Reload a specific workflow   |
| `getWarnings()` | `string[]`                        | Warnings from loading        |

### Error Formatting

#### `formatRuntimeError(error: RuntimeError | DAWEError): string`

Formats any error into actionable markdown. Uses `DAWEError.toAgentMessage()` when available for recovery-hint-aware formatting. Falls back to plain `RuntimeError` interface for backward compatibility.

#### `formatPayloadValidationError(nodeId, instanceId, fieldErrors, schema): string`

Detailed field-level payload validation error with corrective example.

#### `formatMissingParameterError(action, missingParams): string`

Missing required parameter error.

#### `formatWorkflowNotFoundError(workflowName, availableWorkflows): string`

Workflow not found with list of available alternatives.

---

## Persistence Module

**Location:** `src/engine/`

### `InstanceStore` Interface

Pluggable persistence backend for workflow instances.

```typescript
interface InstanceStore {
  save(instance: WorkflowInstance): Promise<void>;
  load(instanceId: string): Promise<WorkflowInstance | null>;
  list(): Promise<WorkflowInstance[]>;
  delete(instanceId: string): Promise<void>;
}
```

### `InMemoryInstanceStore`

Default in-memory implementation. Suitable for testing and development.

### `FileInstanceStore`

Durable file-based persistence with atomic writes and debouncing.

**Constructor:** `new FileInstanceStore(options?: FileStoreOptions)`

| Option            | Type       | Default                      | Description                  |
| ----------------- | ---------- | ---------------------------- | ---------------------------- |
| `directory`       | string     | `~/.pi/workflows/instances/` | Storage directory            |
| `retentionMs`     | number     | 7 days                       | Completed instance retention |
| `writeDebounceMs` | number     | 500                          | Write debounce interval      |
| `pretty`          | boolean    | false                        | Pretty-print JSON            |
| `logger`          | DAWELogger | warn-level                   | Structured logger            |

**File format:**

```json
{
  "version": "1.0",
  "instance": { "instanceId": "...", "status": "active", ... },
  "payload": { ... },
  "payloadHistory": [ ... ],
  "savedAt": "2026-03-11T05:00:00.000Z"
}
```

**Atomic writes:** Writes to a temp file first, then renames. Prevents corruption on crash.

**Debouncing:** Rapid saves are coalesced. Terminal states (completion, cancellation, suspension) flush immediately.

#### `recoverInstances(): Promise<RecoveryResult>`

Scans the instance directory and recovers active/waiting instances from disk. Classifies instances as recovered, stale (workflow not found), corrupted (invalid JSON), suspended, or with lost file pointers.

```typescript
const store = new FileInstanceStore({ directory: '/tmp/dawe-instances' });
const recovery = await store.recoverInstances();
console.log(`Recovered: ${recovery.recovered.length}`);
console.log(`Stale: ${recovery.stale.length}`);
console.log(`Corrupted: ${recovery.corrupted.length}`);
```

---

## Types Index

### Core Types

| Type                 | Location                         | Description                   |
| -------------------- | -------------------------------- | ----------------------------- |
| `WorkflowDefinition` | `src/schemas/workflow.schema.ts` | Top-level workflow            |
| `NodeDefinition`     | `src/schemas/workflow.schema.ts` | Union of node types           |
| `Transition`         | `src/schemas/workflow.schema.ts` | Condition + target + priority |
| `ValidationError`    | `src/schemas/errors.ts`          | Schema validation error       |
| `Result<T, E>`       | `src/utils/result.ts`            | Discriminated union           |

### Engine Types

| Type                    | Location                            | Description             |
| ----------------------- | ----------------------------------- | ----------------------- |
| `DAGGraph`              | `src/engine/dag-graph.ts`           | Adjacency-list graph    |
| `GraphNode`             | `src/engine/dag-graph.ts`           | Node with degree info   |
| `GraphEdge`             | `src/engine/dag-graph.ts`           | Directed edge           |
| `GraphValidationResult` | `src/engine/dag-graph.ts`           | Validation outcome      |
| `ExpressionContext`     | `src/engine/expression-context.ts`  | Eval context            |
| `ExecutorActionResult`  | `src/engine/action-result.ts`       | Command output          |
| `WorkflowInstance`      | `src/engine/advance-result.ts`      | Instance state          |
| `AdvanceResult`         | `src/engine/advance-result.ts`      | Advance response        |
| `InstanceStatus`        | `src/engine/advance-result.ts`      | Status enum             |
| `RuntimeError`          | `src/engine/runtime-errors.ts`      | Runtime error interface |
| `StallCheckResult`      | `src/engine/stall-detector.ts`      | Stall check outcome     |
| `JsonExtractionResult`  | `src/engine/json-extractor.ts`      | JSON extraction outcome |
| `InstanceStore`         | `src/engine/instance-store.ts`      | Persistence interface   |
| `PersistedInstance`     | `src/engine/instance-store-file.ts` | File format             |
| `RecoveryResult`        | `src/engine/instance-store-file.ts` | Recovery outcome        |

### Utils Types

| Type              | Location                       | Description         |
| ----------------- | ------------------------------ | ------------------- |
| `DAWEError`       | `src/utils/errors.ts`          | Base error class    |
| `ErrorCategory`   | `src/utils/errors.ts`          | Category union type |
| `ErrorSeverity`   | `src/utils/errors.ts`          | Severity union type |
| `SerializedError` | `src/utils/errors.ts`          | JSON error shape    |
| `ErrorCodeEntry`  | `src/utils/error-codes.ts`     | Registry entry      |
| `ErrorCode`       | `src/utils/error-codes.ts`     | Valid code union    |
| `DAWELogger`      | `src/utils/logger.ts`          | Structured logger   |
| `LogLevel`        | `src/utils/logger.ts`          | Level type          |
| `LogFormat`       | `src/utils/logger.ts`          | Format type         |
| `ErrorCollector`  | `src/utils/error-collector.ts` | Error accumulator   |

---

_See also: [Architecture](./architecture.md) · [Workflow Authoring Guide](./workflow-authoring-guide.md) · [Contributing](./contributing.md)_

---

## Appendix: Common Integration Patterns

### Pattern 1: Load, Validate, and Start a Workflow

```typescript
import { WorkflowRuntime } from '@ai-daemon/pi-workflows';
import { DAWELogger } from '@ai-daemon/pi-workflows';
import { readFileSync } from 'fs';

const logger = new DAWELogger({ level: 'info', format: 'pretty' });
const runtime = new WorkflowRuntime({ logger });

// Load from YAML file
const yaml = readFileSync('workflows/examples/simple-task.yml', 'utf-8');
const loadResult = runtime.loadWorkflow(yaml);
if (!loadResult.ok) {
  console.error('Validation errors:', loadResult.errors);
  process.exit(1);
}

// Start an instance
const startResult = await runtime.startInstance(loadResult.data, {
  user_request: 'Fix the login bug',
});
if (!startResult.ok) {
  console.error('Start failed:', startResult.errors);
  process.exit(1);
}

console.log(startResult.data.agentMessage);
console.log(`Instance: ${startResult.data.instanceId}`);
console.log(`Status: ${startResult.data.status}`);
```

### Pattern 2: Advance Through an LLM Node

```typescript
// After the agent processes the instruction and produces structured output:
const advanceResult = await runtime.advance(startResult.data.instanceId, startResult.data.currentNodeId!, {
  project_name: 'AI-Daemon/pi-workflows',
  requires_edits: true,
  issue_type: 'bug',
  description: 'Fix login timeout',
});

if (!advanceResult.ok) {
  console.error('Advance failed:', advanceResult.errors.message);
} else if (advanceResult.data.status === 'waiting_for_agent') {
  console.log('Next instruction:', advanceResult.data.instruction);
} else if (advanceResult.data.status === 'completed') {
  console.log('Workflow complete:', advanceResult.data.terminalMessage);
} else if (advanceResult.data.status === 'suspended') {
  console.log('Workflow suspended — human review needed');
}
```

### Pattern 3: Listen to Runtime Events

```typescript
const runtime = new WorkflowRuntime({ logger });

runtime.on('node:entered', (instanceId, nodeId) => {
  console.log(`[${instanceId}] Entered node: ${nodeId}`);
});

runtime.on('system_action:executed', (instanceId, nodeId, result) => {
  console.log(`[${instanceId}] ${nodeId} completed: exit=${result.exit_code} (${result.duration_ms}ms)`);
});

runtime.on('error', (instanceId, error) => {
  console.error(`[${instanceId}] Error: [${error.code}] ${error.message}`);
});

runtime.on('instance:completed', (instanceId, terminalStatus) => {
  console.log(`[${instanceId}] Workflow finished: ${terminalStatus}`);
});
```

### Pattern 4: Structured Error Handling in a Validation Pipeline

```typescript
import { ErrorCollector, SchemaValidationError, GraphValidationError } from '@ai-daemon/pi-workflows';

function validateEverything(yamlContent: string): Result<void, DAWEError[]> {
  const collector = new ErrorCollector();

  // Phase 1: Schema validation
  const schemaResult = validateWorkflow(parseYaml(yamlContent));
  if (!schemaResult.ok) {
    for (const err of schemaResult.errors) {
      collector.add(
        new SchemaValidationError(err.code, err.message, {
          context: { path: err.path },
        }),
      );
    }
  }

  // Phase 2: Graph validation (only if schema passed)
  if (schemaResult.ok) {
    const parser = new DAGParser(schemaResult.data);
    const graphResult = parser.validate();
    for (const err of graphResult.errors) {
      collector.add(
        new GraphValidationError(err.code, err.message, {
          context: { nodeIds: err.nodeIds },
        }),
      );
    }
  }

  return collector.toResult();
}

const result = validateEverything(yamlContent);
if (!result.ok) {
  for (const error of result.errors) {
    console.log(error.toAgentMessage());
  }
}
```

### Pattern 5: File Persistence with Recovery

```typescript
import { FileInstanceStore } from '@ai-daemon/pi-workflows';

const store = new FileInstanceStore({
  directory: '/data/dawe-instances',
  retentionMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  pretty: true,
});

// Use with runtime
const runtime = new WorkflowRuntime({ instanceStore: store, logger });

// On startup: recover interrupted instances
const recovery = await store.recoverInstances();
console.log(`Recovered ${recovery.recovered.length} instances`);
console.log(`Found ${recovery.stale.length} stale instances`);
console.log(`Found ${recovery.corrupted.length} corrupted files`);
console.log(`Found ${recovery.suspended.length} suspended instances`);

// Clean up old completed instances
await store.cleanup();
```

### Pattern 6: Custom Logger for Production

```typescript
import { DAWELogger } from '@ai-daemon/pi-workflows';

// JSON logger for production (pipe to log aggregator)
const productionLogger = new DAWELogger({
  level: 'info',
  format: 'json',
  context: { service: 'dawe-engine', environment: 'production' },
});

// Pretty logger for development
const devLogger = new DAWELogger({
  level: 'debug',
  format: 'pretty',
});

// Test logger (capture output)
const captured: string[] = [];
const testLogger = new DAWELogger({
  level: 'debug',
  format: 'json',
  output: (line) => captured.push(line),
});

// Child logger with component context
const executorLogger = productionLogger.child({ component: 'system-action-executor' });
executorLogger.info('Command started', { command: 'npm test', nodeId: 'run_tests' });
// Outputs: {"timestamp":"...","level":"info","message":"Command started","service":"dawe-engine","environment":"production","component":"system-action-executor","command":"npm test","nodeId":"run_tests"}
```
