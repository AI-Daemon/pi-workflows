/**
 * WorkflowRuntime — The brain of the DAWE engine.
 *
 * Orchestrates the full lifecycle of a workflow instance:
 * 1. Load and validate workflow definitions from YAML
 * 2. Instantiate workflow instances with initial payload
 * 3. Track current node, delegate to correct handler by node type
 * 4. Evaluate transitions after each node completion
 * 5. Chain system_action nodes automatically (auto-advance)
 * 6. Persist state via pluggable InstanceStore
 *
 * Node type handling:
 * - `llm_decision` / `llm_task`: STOP, return instructions to agent
 * - `system_action`: execute immediately, chain forward
 * - `terminal`: finalize the instance
 */

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'node:events';

import type {
  WorkflowDefinition,
  NodeDefinition,
  LlmDecisionNode,
  LlmTaskNode,
  SystemActionNode,
  TerminalNode,
} from '../schemas/workflow.schema.js';
import type { Result } from '../utils/result.js';
import type { ValidationError } from '../schemas/errors.js';
import type { ExpressionContext, ActionResult } from './expression-context.js';
import type { ExecutorActionResult, ExecutorOptions } from './action-result.js';
import type { WorkflowInstance, AdvanceResult, SystemActionChainEntry } from './advance-result.js';
import type { InstanceStore } from './instance-store.js';
import type { RuntimeError } from './runtime-errors.js';

import { RuntimeErrorCode } from './runtime-errors.js';
import { InMemoryInstanceStore } from './instance-store.js';
import { validateWorkflowFull } from './composite-validation.js';
import { ExpressionEvaluator } from './expression-evaluator.js';
import { PayloadManager } from './payload-manager.js';
import { SystemActionExecutor } from './system-action-executor.js';
import { resolveTemplate } from './template-engine.js';
import { formatAgentMessage } from './agent-message-formatter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration options for the WorkflowRuntime. */
export interface RuntimeOptions {
  /** Options passed to SystemActionExecutor. */
  executorOptions?: Partial<ExecutorOptions>;
  /** Maximum consecutive system_action nodes before forcing a pause (default 20). */
  maxChainLength?: number;
  /** Pluggable persistence backend (default: InMemoryInstanceStore). */
  instanceStore?: InstanceStore;
}

/** Internal representation of a loaded workflow. */
interface LoadedWorkflow {
  id: string;
  definition: WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// Runtime events
// ---------------------------------------------------------------------------

export interface RuntimeEvents {
  'node:entered': (instanceId: string, nodeId: string) => void;
  'node:completed': (instanceId: string, nodeId: string, result?: unknown) => void;
  'instance:completed': (instanceId: string, terminalStatus: string) => void;
  'system_action:executed': (instanceId: string, nodeId: string, actionResult: ExecutorActionResult) => void;
  error: (instanceId: string, error: RuntimeError) => void;
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime extends EventEmitter {
  private readonly workflows = new Map<string, LoadedWorkflow>();
  private readonly store: InstanceStore;
  private readonly executor: SystemActionExecutor;
  private readonly evaluator: ExpressionEvaluator;
  private readonly maxChainLength: number;

  constructor(options?: RuntimeOptions) {
    super();
    this.store = options?.instanceStore ?? new InMemoryInstanceStore();
    this.executor = new SystemActionExecutor(options?.executorOptions);
    this.evaluator = new ExpressionEvaluator();
    this.maxChainLength = options?.maxChainLength ?? 20;
  }

  // -----------------------------------------------------------------------
  // Workflow loading
  // -----------------------------------------------------------------------

  /**
   * Load and validate a workflow definition from YAML.
   *
   * @param yamlString - Raw YAML workflow definition.
   * @returns The workflow ID on success, or validation errors on failure.
   */
  loadWorkflow(yamlString: string): Result<string, ValidationError[]> {
    const validationResult = validateWorkflowFull(yamlString);
    if (!validationResult.ok) {
      return { ok: false, errors: validationResult.errors as ValidationError[] };
    }

    const definition = validationResult.data.definition;
    const workflowId = uuidv4();

    this.workflows.set(workflowId, {
      id: workflowId,
      definition,
    });

    return { ok: true, data: workflowId };
  }

  // -----------------------------------------------------------------------
  // Instance lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a new instance of a loaded workflow.
   *
   * If the initial node is a system_action, it auto-executes and chains forward.
   * If the initial node is an llm_* node, it returns an AdvanceResult with instructions.
   *
   * @param workflowId - The ID of a previously loaded workflow.
   * @param initialPayload - Optional initial payload data.
   * @returns The AdvanceResult describing the initial state.
   */
  async startInstance(
    workflowId: string,
    initialPayload?: Record<string, unknown>,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.WORKFLOW_NOT_FOUND,
          message: `Workflow "${workflowId}" not found`,
        },
      };
    }

    const instanceId = uuidv4();
    const now = Date.now();
    const definition = workflow.definition;
    const initialNodeId = definition.initial_node;
    const initialNode = definition.nodes[initialNodeId]!;

    const instance: WorkflowInstance = {
      instanceId,
      workflowId,
      workflowName: definition.workflow_name,
      status: 'active',
      currentNodeId: initialNodeId,
      currentNodeType: initialNode.type,
      payload: initialPayload ? structuredClone(initialPayload) : {},
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    // Add initial history entry
    instance.history.push({
      nodeId: initialNodeId,
      nodeType: initialNode.type,
      enteredAt: now,
      payloadSnapshot: structuredClone(instance.payload),
    });

    await this.store.save(instance);
    this.emit('node:entered', instanceId, initialNodeId);

    // Process the initial node
    return this.processCurrentNode(instance, definition);
  }

  /**
   * Advance an instance — called when the agent submits node_payload.
   *
   * @param instanceId - The instance to advance.
   * @param nodeId - The current node ID (must match the instance's current node).
   * @param nodePayload - The agent's response data.
   * @returns The AdvanceResult describing the next state.
   */
  async advance(
    instanceId: string,
    nodeId: string,
    nodePayload: Record<string, unknown>,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const instance = await this.store.load(instanceId);
    if (!instance) {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.INSTANCE_NOT_FOUND,
          message: `Instance "${instanceId}" not found`,
          instanceId,
        },
      };
    }

    // Check instance is active/waiting
    if (instance.status !== 'active' && instance.status !== 'waiting_for_agent') {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.INSTANCE_NOT_ACTIVE,
          message: `Instance "${instanceId}" is not active (status: ${instance.status})`,
          instanceId,
        },
      };
    }

    // Check node ID matches
    if (instance.currentNodeId !== nodeId) {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.NODE_MISMATCH,
          message: `Expected node "${instance.currentNodeId}", but received "${nodeId}"`,
          instanceId,
          nodeId,
        },
      };
    }

    // Get workflow definition
    const workflow = this.workflows.get(instance.workflowId);
    if (!workflow) {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.WORKFLOW_NOT_FOUND,
          message: `Workflow "${instance.workflowId}" not found (was it unloaded?)`,
          instanceId,
        },
      };
    }

    const definition = workflow.definition;
    const currentNode = definition.nodes[nodeId]!;

    // Validate payload against node schema
    const validationError = this.validateNodePayload(currentNode, nodePayload);
    if (validationError) {
      return {
        ok: false,
        errors: {
          ...validationError,
          instanceId,
          nodeId,
        },
      };
    }

    // Merge agent payload into instance
    const payloadManager = new PayloadManager(instance.payload);
    payloadManager.merge(nodeId, nodePayload);
    instance.payload = payloadManager.getPayload() as Record<string, unknown>;

    // Mark current node as completed in history
    const currentHistoryEntry = instance.history[instance.history.length - 1];
    if (currentHistoryEntry && currentHistoryEntry.nodeId === nodeId) {
      currentHistoryEntry.completedAt = Date.now();
    }

    this.emit('node:completed', instanceId, nodeId, nodePayload);

    // Build expression context for transition evaluation
    const context: ExpressionContext = {
      payload: instance.payload,
      ...(definition.metadata ? { metadata: definition.metadata } : {}),
    };

    // Evaluate transitions
    const transitionResult = await this.evaluator.evaluateTransitions(
      currentNode.type !== 'terminal' ? currentNode.transitions : [],
      context,
    );

    if (!transitionResult.ok) {
      const error: RuntimeError = {
        code: RuntimeErrorCode.EXPRESSION_ERROR,
        message: `Expression evaluation failed: ${transitionResult.errors.message}`,
        instanceId,
        nodeId,
      };
      this.emit('error', instanceId, error);
      return { ok: false, errors: error };
    }

    const targetNodeId = transitionResult.data;
    if (!targetNodeId) {
      const error: RuntimeError = {
        code: RuntimeErrorCode.NO_MATCHING_TRANSITION,
        message: `No transition matched for node "${nodeId}"`,
        instanceId,
        nodeId,
      };
      this.emit('error', instanceId, error);
      return { ok: false, errors: error };
    }

    // Transition to next node
    return this.transitionTo(instance, definition, targetNodeId);
  }

  /**
   * Get the current state of an instance.
   */
  async getInstance(instanceId: string): Promise<WorkflowInstance | null> {
    return this.store.load(instanceId);
  }

  /**
   * List all stored instances.
   */
  async listInstances(): Promise<WorkflowInstance[]> {
    return this.store.list();
  }

  /**
   * Cancel/abort an instance.
   */
  async cancelInstance(instanceId: string): Promise<Result<void, RuntimeError>> {
    const instance = await this.store.load(instanceId);
    if (!instance) {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.INSTANCE_NOT_FOUND,
          message: `Instance "${instanceId}" not found`,
          instanceId,
        },
      };
    }

    if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'cancelled') {
      return {
        ok: false,
        errors: {
          code: RuntimeErrorCode.INSTANCE_NOT_ACTIVE,
          message: `Instance "${instanceId}" is not active (status: ${instance.status})`,
          instanceId,
        },
      };
    }

    instance.status = 'cancelled';
    instance.terminalStatus = 'cancelled';
    instance.completedAt = Date.now();
    instance.updatedAt = Date.now();

    await this.store.save(instance);
    this.emit('instance:completed', instanceId, 'cancelled');

    return { ok: true, data: undefined };
  }

  // -----------------------------------------------------------------------
  // Internal: Node processing
  // -----------------------------------------------------------------------

  /**
   * Process the current node of an instance.
   * This is the entry point after initial node setup or after transitioning.
   *
   * Handles the main loop:
   * - system_action: execute, chain forward
   * - llm_*: stop, return instructions
   * - terminal: finalize
   */
  private async processCurrentNode(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    systemActionResults?: SystemActionChainEntry[],
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const chainResults: SystemActionChainEntry[] = systemActionResults ?? [];
    let chainCount = chainResults.length;

    // Loop for system_action chaining
    while (true) {
      const nodeId = instance.currentNodeId;
      const node = definition.nodes[nodeId]!;

      if (node.type === 'system_action') {
        // Safety: check chain limit
        if (chainCount >= this.maxChainLength) {
          const error: RuntimeError = {
            code: RuntimeErrorCode.SYSTEM_ACTION_CHAIN_LIMIT,
            message: `System action chain exceeded maximum length of ${this.maxChainLength}`,
            instanceId: instance.instanceId,
            nodeId,
          };
          this.emit('error', instance.instanceId, error);
          return { ok: false, errors: error };
        }

        // Execute the system action
        const execResult = await this.executeSystemAction(instance, definition, node, nodeId);
        if (!execResult.ok) {
          return execResult;
        }

        chainResults.push({
          nodeId,
          actionResult: execResult.data,
        });
        chainCount++;

        this.emit('system_action:executed', instance.instanceId, nodeId, execResult.data);

        // Mark node completed in history
        const historyEntry = instance.history[instance.history.length - 1];
        if (historyEntry && historyEntry.nodeId === nodeId) {
          historyEntry.completedAt = Date.now();
        }

        this.emit('node:completed', instance.instanceId, nodeId, execResult.data);

        // Build context with action_result for transition evaluation
        const actionResult: ActionResult = {
          exit_code: execResult.data.exit_code,
          stdout: execResult.data.stdout,
          stderr: execResult.data.stderr,
          ...(execResult.data.data !== undefined ? { data: execResult.data.data } : {}),
        };

        const context: ExpressionContext = {
          payload: instance.payload,
          action_result: actionResult,
          ...(definition.metadata ? { metadata: definition.metadata } : {}),
        };

        // Evaluate transitions
        const transitionResult = await this.evaluator.evaluateTransitions(node.transitions, context);

        if (!transitionResult.ok) {
          const error: RuntimeError = {
            code: RuntimeErrorCode.EXPRESSION_ERROR,
            message: `Expression evaluation failed: ${transitionResult.errors.message}`,
            instanceId: instance.instanceId,
            nodeId,
          };
          this.emit('error', instance.instanceId, error);
          return { ok: false, errors: error };
        }

        const targetNodeId = transitionResult.data;
        if (!targetNodeId) {
          const error: RuntimeError = {
            code: RuntimeErrorCode.NO_MATCHING_TRANSITION,
            message: `No transition matched for system_action node "${nodeId}"`,
            instanceId: instance.instanceId,
            nodeId,
          };
          this.emit('error', instance.instanceId, error);
          return { ok: false, errors: error };
        }

        // Transition to the next node (update instance state)
        const targetNode = definition.nodes[targetNodeId]!;
        instance.currentNodeId = targetNodeId;
        instance.currentNodeType = targetNode.type;
        instance.updatedAt = Date.now();

        // Add history entry for new node
        instance.history.push({
          nodeId: targetNodeId,
          nodeType: targetNode.type,
          enteredAt: Date.now(),
          payloadSnapshot: structuredClone(instance.payload),
        });

        this.emit('node:entered', instance.instanceId, targetNodeId);

        // Continue the loop — if next node is also system_action, auto-advance
        continue;
      }

      if (node.type === 'llm_decision' || node.type === 'llm_task') {
        return this.buildLlmAdvanceResult(instance, definition, node, chainResults);
      }

      if (node.type === 'terminal') {
        return this.buildTerminalAdvanceResult(instance, definition, node, chainResults);
      }

      // Should never reach here
      break;
    }

    // Unreachable, but TypeScript needs this
    return {
      ok: false,
      errors: {
        code: RuntimeErrorCode.EXPRESSION_ERROR,
        message: 'Unexpected state in processCurrentNode',
        instanceId: instance.instanceId,
      },
    };
  }

  /**
   * Transition from the current node to a target node, then process.
   */
  private async transitionTo(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    targetNodeId: string,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const targetNode = definition.nodes[targetNodeId]!;

    // Update instance
    instance.currentNodeId = targetNodeId;
    instance.currentNodeType = targetNode.type;
    instance.updatedAt = Date.now();

    // Add history entry
    instance.history.push({
      nodeId: targetNodeId,
      nodeType: targetNode.type,
      enteredAt: Date.now(),
      payloadSnapshot: structuredClone(instance.payload),
    });

    this.emit('node:entered', instance.instanceId, targetNodeId);

    // Process the new current node
    return this.processCurrentNode(instance, definition);
  }

  // -----------------------------------------------------------------------
  // Internal: System action execution
  // -----------------------------------------------------------------------

  /**
   * Execute a system_action node and merge its result into the payload.
   */
  private async executeSystemAction(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    node: SystemActionNode,
    nodeId: string,
  ): Promise<Result<ExecutorActionResult, RuntimeError>> {
    const context: ExpressionContext = {
      payload: instance.payload,
      metadata: {
        ...(definition.metadata ?? {}),
        workflow_name: definition.workflow_name,
        node_id: nodeId,
        instance_id: instance.instanceId,
      },
    };

    const result = await this.executor.execute(node, context);

    if (!result.ok) {
      const error: RuntimeError = {
        code: RuntimeErrorCode.SYSTEM_ACTION_FAILED,
        message: `System action failed: ${result.errors.message}`,
        instanceId: instance.instanceId,
        nodeId,
      };
      this.emit('error', instance.instanceId, error);
      return { ok: false, errors: error };
    }

    // Merge action_result into payload
    const payloadManager = new PayloadManager(instance.payload);
    const actionResultPayload: Record<string, unknown> = {
      action_result: {
        exit_code: result.data.exit_code,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        timed_out: result.data.timed_out,
        data: result.data.data,
      },
    };
    payloadManager.merge(nodeId, actionResultPayload);
    instance.payload = payloadManager.getPayload() as Record<string, unknown>;

    return { ok: true, data: result.data };
  }

  // -----------------------------------------------------------------------
  // Internal: Result builders
  // -----------------------------------------------------------------------

  /**
   * Build an AdvanceResult for an llm_decision or llm_task node.
   * Sets status to 'waiting_for_agent' and returns instructions.
   */
  private async buildLlmAdvanceResult(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    node: LlmDecisionNode | LlmTaskNode,
    chainResults: SystemActionChainEntry[],
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    instance.status = 'waiting_for_agent';
    instance.updatedAt = Date.now();

    // Resolve instruction template
    const templateResult = resolveTemplate(node.instruction, {
      payload: instance.payload,
      metadata: definition.metadata ?? {},
    });

    const resolvedInstruction = templateResult.ok ? templateResult.data : node.instruction;

    const partialResult: Omit<AdvanceResult, 'agentMessage'> = {
      instanceId: instance.instanceId,
      status: 'waiting_for_agent',
      currentNodeId: instance.currentNodeId,
      currentNodeType: node.type,
      instruction: resolvedInstruction,
    };

    if (node.type === 'llm_decision') {
      (partialResult as AdvanceResult).requiredSchema = node.required_schema;
    } else {
      (partialResult as AdvanceResult).completionSchema = node.completion_schema;

      // Scope payload for context_keys
      if (node.context_keys && node.context_keys.length > 0) {
        const payloadManager = new PayloadManager(instance.payload);
        (partialResult as AdvanceResult).contextPayload = payloadManager.getScoped(node.context_keys);
      }
    }

    if (chainResults.length > 0) {
      (partialResult as AdvanceResult).systemActionResults = chainResults;
    }

    const agentMessage = formatAgentMessage(partialResult, instance.workflowName);

    const advanceResult: AdvanceResult = {
      ...partialResult,
      agentMessage,
    };

    await this.store.save(instance);

    return { ok: true, data: advanceResult };
  }

  /**
   * Build an AdvanceResult for a terminal node.
   * Sets status to 'completed' and records terminal info.
   */
  private async buildTerminalAdvanceResult(
    instance: WorkflowInstance,
    _definition: WorkflowDefinition,
    node: TerminalNode,
    chainResults: SystemActionChainEntry[],
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const now = Date.now();
    instance.status = 'completed';
    instance.terminalStatus = node.status;
    instance.completedAt = now;
    instance.updatedAt = now;

    // Mark terminal node completed in history
    const historyEntry = instance.history[instance.history.length - 1];
    if (historyEntry && historyEntry.nodeId === instance.currentNodeId) {
      historyEntry.completedAt = now;
    }

    // Resolve terminal message template
    let resolvedMessage: string | undefined;
    if (node.message) {
      const templateResult = resolveTemplate(node.message, {
        payload: instance.payload,
      });
      resolvedMessage = templateResult.ok ? templateResult.data : node.message;
    }

    if (resolvedMessage !== undefined) {
      instance.terminalMessage = resolvedMessage;
    }

    const partialResult: Omit<AdvanceResult, 'agentMessage'> = {
      instanceId: instance.instanceId,
      status: 'completed',
      terminalStatus: node.status,
      ...(resolvedMessage !== undefined ? { terminalMessage: resolvedMessage } : {}),
    };

    if (chainResults.length > 0) {
      (partialResult as AdvanceResult).systemActionResults = chainResults;
    }

    const agentMessage = formatAgentMessage(partialResult, instance.workflowName);

    const advanceResult: AdvanceResult = {
      ...partialResult,
      agentMessage,
    };

    await this.store.save(instance);
    this.emit('instance:completed', instance.instanceId, node.status);

    return { ok: true, data: advanceResult };
  }

  // -----------------------------------------------------------------------
  // Internal: Payload validation
  // -----------------------------------------------------------------------

  /**
   * Validate the agent's nodePayload against the node's required/completion schema.
   *
   * For llm_decision: validates all keys in required_schema with correct types.
   * For llm_task: validates all keys in completion_schema.
   */
  private validateNodePayload(node: NodeDefinition, nodePayload: Record<string, unknown>): RuntimeError | null {
    if (node.type === 'llm_decision') {
      return this.validateAgainstSchema(node.required_schema, nodePayload, 'required_schema');
    }

    if (node.type === 'llm_task') {
      return this.validateAgainstSchema(node.completion_schema, nodePayload, 'completion_schema');
    }

    // system_action and terminal don't need payload validation
    return null;
  }

  /**
   * Validate a payload against a Record<string, string> schema map.
   * Schema maps like { "intent": "string", "confidence": "number" }.
   */
  private validateAgainstSchema(
    schema: Record<string, string>,
    payload: Record<string, unknown>,
    schemaName: string,
  ): RuntimeError | null {
    const missingKeys: string[] = [];
    const typeErrors: string[] = [];

    for (const [key, expectedType] of Object.entries(schema)) {
      const value = payload[key];

      if (value === undefined || value === null) {
        missingKeys.push(key);
        continue;
      }

      if (!this.checkType(value, expectedType)) {
        typeErrors.push(`"${key}" expected ${expectedType}, got ${typeof value}`);
      }
    }

    if (missingKeys.length > 0 || typeErrors.length > 0) {
      const parts: string[] = [];
      if (missingKeys.length > 0) {
        parts.push(`Missing keys: ${missingKeys.join(', ')}`);
      }
      if (typeErrors.length > 0) {
        parts.push(`Type errors: ${typeErrors.join('; ')}`);
      }

      return {
        code: RuntimeErrorCode.PAYLOAD_VALIDATION_FAILED,
        message: `Payload validation failed against ${schemaName}: ${parts.join('. ')}`,
      };
    }

    return null;
  }

  /**
   * Check if a value matches an expected type string.
   * Supports: string, number, boolean, string[], number[]
   */
  private checkType(value: unknown, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'string[]':
        return Array.isArray(value) && value.every((v) => typeof v === 'string');
      case 'number[]':
        return Array.isArray(value) && value.every((v) => typeof v === 'number');
      default:
        return true; // Unknown type — allow
    }
  }
}
