/**
 * Engine barrel export.
 *
 * Re-exports the DAG parser, graph types, validators, visualization
 * helpers, and the composite validation function.
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

// Composite validation
export { validateWorkflowFull } from './composite-validation.js';
export type { ValidatedWorkflow, CompositeValidationError } from './composite-validation.js';
