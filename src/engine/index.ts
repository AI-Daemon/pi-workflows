/**
 * Engine barrel export.
 *
 * Re-exports the DAG parser, graph types, validators, visualization
 * helpers, expression evaluator, composite validation, payload manager,
 * template engine, and system action executor.
 */

// DAG Graph types
export type {
  DAGGraph,
  GraphNode,
  GraphEdge,
  GraphValidationResult,
  GraphValidationError,
  GraphValidationWarning,
  GraphStats,
} from './dag-graph.js';
export { GraphErrorCode, GraphWarningCode } from './dag-graph.js';

// DAG Parser
export { DAGParser } from './dag-parser.js';
export type { DAGParserOptions } from './dag-parser.js';

// Graph validator functions (composable)
export {
  detectCycles,
  validateBoundedCycles,
  detectUnreachableNodes,
  detectDeadEnds,
  detectOrphanedNodes,
  detectDuplicateTransitionTargets,
  checkMaxDepth,
  computeMaxDepth,
  computeGraphStats,
} from './graph-validator.js';

// Visualization helpers
export { toMermaid, toDot, toAdjacencyListJSON, formatValidationReport } from './visualization.js';

// Expression evaluator
export { ExpressionEvaluator } from './expression-evaluator.js';
export type { ExpressionContext, ActionResult, WorkflowMetadata } from './expression-context.js';
export { ExpressionErrorCode } from './expression-errors.js';
export type { ExpressionError } from './expression-errors.js';

// Composite validation
export { validateWorkflowFull } from './composite-validation.js';
export type { ValidatedWorkflow, CompositeValidationError } from './composite-validation.js';

// Payload Manager
export { PayloadManager } from './payload-manager.js';
export type { PayloadValidationError } from './payload-manager.js';

// Payload History
export type { PayloadHistoryEntry } from './payload-history.js';

// Template Engine
export { resolveTemplate } from './template-engine.js';
export type { TemplateError } from './template-engine.js';

// System Action Executor
export { SystemActionExecutor } from './system-action-executor.js';
export { FILE_POINTER_DIR } from './system-action-executor.js';
export type { ExecutorActionResult, ExecutorOptions, StreamingCallbacks, RetryConfig } from './action-result.js';
export { SecurityValidator, DEFAULT_BLOCKED_PATTERNS } from './security-validator.js';
export type { SecurityError, SecurityErrorCode } from './security-validator.js';
export { shellEscape } from './shell-escape.js';

// JSON Extractor
export { extractJson } from './json-extractor.js';
export type { JsonExtractionResult } from './json-extractor.js';

// Workflow Runtime Engine
export { WorkflowRuntime } from './workflow-runtime.js';
export type { RuntimeOptions, RuntimeEvents } from './workflow-runtime.js';

// Advance Result types
export type {
  WorkflowInstance,
  AdvanceResult,
  UxControls,
  InstanceStatus,
  InstanceHistoryEntry,
  SystemActionChainEntry,
} from './advance-result.js';

// Runtime Errors
export { RuntimeErrorCode } from './runtime-errors.js';
export type { RuntimeError } from './runtime-errors.js';

// Instance Store
export { InMemoryInstanceStore } from './instance-store.js';
export type { InstanceStore } from './instance-store.js';

// File Instance Store (Persistence)
export { FileInstanceStore, DebouncedSaver } from './instance-store-file.js';
export type { FileStoreOptions, PersistedInstance, RecoveryResult } from './instance-store-file.js';

// Agent Message Formatter
export { formatAgentMessage, formatStallMessage } from './agent-message-formatter.js';
export type { CycleTransitionInfo, StallDetectionInfo } from './agent-message-formatter.js';

// Stall Detector
export { StallDetector } from './stall-detector.js';
export type { StallDetectorOptions, StallCheckResult } from './stall-detector.js';

// Lexical Formatter
export { LexicalFormatter, IRREGULAR_VERBS } from './utils/LexicalFormatter.js';
