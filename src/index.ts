// Public API barrel export for @ai-daemon/pi-workflows

// Schema definitions, types, and validation
export {
  // Zod schemas
  WorkflowDefinitionSchema,
  NodeDefinitionSchema,
  TransitionSchema,
  LlmDecisionNodeSchema,
  LlmTaskNodeSchema,
  SystemActionNodeSchema,
  TerminalNodeSchema,
  // Validation functions
  validateWorkflow,
  loadWorkflow,
  // Error types & codes
  SchemaErrorCode,
} from './schemas/index.js';

export type {
  // Inferred types
  WorkflowDefinition,
  NodeDefinition,
  Transition,
  LlmDecisionNode,
  LlmTaskNode,
  SystemActionNode,
  TerminalNode,
  // Error types
  ValidationError,
} from './schemas/index.js';

// Engine — DAG parser, graph types, validators, visualization, expression evaluator
export {
  // DAG Parser
  DAGParser,
  // Graph error/warning codes
  GraphErrorCode,
  GraphWarningCode,
  // Graph validator functions
  detectCycles,
  detectUnreachableNodes,
  detectDeadEnds,
  detectOrphanedNodes,
  detectDuplicateTransitionTargets,
  checkMaxDepth,
  computeMaxDepth,
  computeGraphStats,
  // Visualization
  toMermaid,
  toDot,
  toAdjacencyListJSON,
  formatValidationReport,
  // Expression evaluator
  ExpressionEvaluator,
  ExpressionErrorCode,
  // Composite validation
  validateWorkflowFull,
  // Payload Manager
  PayloadManager,
  // Template Engine
  resolveTemplate,
} from './engine/index.js';

export type {
  // Graph types
  DAGGraph,
  GraphNode,
  GraphEdge,
  GraphValidationResult,
  GraphValidationError,
  GraphValidationWarning,
  GraphStats,
  DAGParserOptions,
  // Expression evaluator types
  ExpressionContext,
  ActionResult,
  ExpressionError,
  // Composite validation types
  ValidatedWorkflow,
  CompositeValidationError,
  // Payload Manager types
  PayloadValidationError,
  PayloadHistoryEntry,
  TemplateError,
} from './engine/index.js';

// Result utility type
export type { Result } from './utils/index.js';
