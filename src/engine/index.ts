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
export type { ExpressionContext, ActionResult } from './expression-context.js';
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
export type { ExecutorActionResult, ExecutorOptions, StreamingCallbacks, RetryConfig } from './action-result.js';
export { SecurityValidator, DEFAULT_BLOCKED_PATTERNS } from './security-validator.js';
export type { SecurityError, SecurityErrorCode } from './security-validator.js';
export { shellEscape } from './shell-escape.js';
