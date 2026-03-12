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
  // System Action Executor
  SystemActionExecutor,
  SecurityValidator,
  DEFAULT_BLOCKED_PATTERNS,
  shellEscape,
  // Workflow Runtime Engine
  WorkflowRuntime,
  RuntimeErrorCode,
  InMemoryInstanceStore,
  formatAgentMessage,
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
  // System Action Executor types
  ExecutorActionResult,
  ExecutorOptions,
  StreamingCallbacks,
  RetryConfig,
  SecurityError,
  SecurityErrorCode,
  // Workflow Runtime types
  RuntimeOptions,
  RuntimeEvents,
  WorkflowInstance,
  AdvanceResult,
  UxControls,
  InstanceStatus,
  InstanceHistoryEntry,
  SystemActionChainEntry,
  RuntimeError,
  InstanceStore,
} from './engine/index.js';

// Result utility type
export type { Result } from './utils/index.js';

// Unified error hierarchy (DAWE-012)
export {
  DAWEError,
  SchemaValidationError as DAWESchemaValidationError,
  GraphValidationError as DAWEGraphValidationError,
  ExpressionEvaluationError,
  PayloadError,
  SystemActionError,
  RuntimeError as DAWERuntimeError,
  SecurityViolationError,
  CycleSafetyError,
  ErrorCollector,
  DAWELogger,
  getDefaultLogger,
  setDefaultLogger,
  ERROR_CODES,
  getErrorCodeEntry,
} from './utils/index.js';
export type {
  ErrorCategory,
  ErrorSeverity,
  SerializedError,
  ErrorCodeEntry,
  ErrorCode,
  LogLevel,
  LogFormat,
  LoggerOptions,
} from './utils/index.js';

// Extension module — Pi extension tool wrapper (advance_workflow)
export { default as piWorkflowsExtension } from './extension/index.js';
export {
  WorkflowRegistry,
  AdvanceWorkflowHandler,
  formatListResponse,
  formatAdvanceResponse,
  formatCompletedResponse,
  formatStatusResponse,
  formatCancelResponse,
  formatErrorResponse,
  formatSimpleError,
  formatActiveInstanceWarning,
  formatPayloadValidationError,
  formatMissingParameterError,
  formatWorkflowNotFoundError,
  formatRuntimeError,
} from './extension/index.js';
export type {
  WorkflowSummary,
  AdvanceWorkflowInput,
  AdvanceWorkflowOutput,
  PayloadFieldError,
} from './extension/index.js';
