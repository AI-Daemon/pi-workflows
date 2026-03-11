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
import type { ExpressionContext, ActionResult, WorkflowMetadata } from './expression-context.js';
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
import { formatAgentMessage, formatStallMessage } from './agent-message-formatter.js';
import { extractJson } from './json-extractor.js';
import { StallDetector } from './stall-detector.js';
import type { CycleTransitionInfo, StallDetectionInfo } from './agent-message-formatter.js';
import type { StallDetectorOptions } from './stall-detector.js';

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
  /** Options passed to StallDetector. */
  stallDetectorOptions?: StallDetectorOptions;
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
  private readonly stallDetector: StallDetector;

  constructor(options?: RuntimeOptions) {
    super();
    this.store = options?.instanceStore ?? new InMemoryInstanceStore();
    this.executor = new SystemActionExecutor(options?.executorOptions);
    this.evaluator = new ExpressionEvaluator();
    this.maxChainLength = options?.maxChainLength ?? 20;
    this.stallDetector = new StallDetector(options?.stallDetectorOptions);
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

    // Initialize $metadata for visit tracking
    const metadata: WorkflowMetadata = {
      visits: {},
      state_hashes: [],
      instance_id: instanceId,
      started_at: new Date(now).toISOString(),
    };

    const payload: Record<string, unknown> = initialPayload ? structuredClone(initialPayload) : {};
    // Store $metadata in the payload (protected from user overwrites by PayloadManager)
    payload['$metadata'] = metadata;

    const instance: WorkflowInstance = {
      instanceId,
      workflowId,
      workflowName: definition.workflow_name,
      status: 'active',
      currentNodeId: initialNodeId,
      currentNodeType: initialNode.type,
      payload,
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    // Increment visit count for the initial node
    metadata.visits[initialNodeId] = (metadata.visits[initialNodeId] ?? 0) + 1;

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

    // Check instance is active/waiting (also reject suspended instances)
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

    // Merge agent payload into instance (PayloadManager protects $metadata)
    const payloadManager = new PayloadManager(instance.payload);
    payloadManager.merge(nodeId, nodePayload);
    instance.payload = payloadManager.getPayload() as Record<string, unknown>;

    // Mark current node as completed in history
    const currentHistoryEntry = instance.history[instance.history.length - 1];
    if (currentHistoryEntry && currentHistoryEntry.nodeId === nodeId) {
      currentHistoryEntry.completedAt = Date.now();
    }

    this.emit('node:completed', instanceId, nodeId, nodePayload);

    // Build expression context for transition evaluation (with $metadata)
    const $metadata = instance.payload['$metadata'] as WorkflowMetadata | undefined;
    const context: ExpressionContext = {
      payload: instance.payload,
      ...(definition.metadata ? { metadata: definition.metadata } : {}),
      ...($metadata ? { $metadata } : {}),
    };

    // Evaluate transitions with max_visits enforcement and stall detection
    const transitionTarget = await this.evaluateTransitionsWithBudget(
      currentNode.type !== 'terminal' ? currentNode.transitions : [],
      context,
      instance,
      definition,
      nodeId,
    );

    if (!transitionTarget.ok) {
      return transitionTarget;
    }

    // Handle stall detection — suspend the instance immediately
    if (transitionTarget.data.stallInfo) {
      return this.suspendForStall(instance, definition, transitionTarget.data.stallInfo);
    }

    const targetNodeId = transitionTarget.data.targetNodeId;

    // Transition to next node (with cycle info for agent message)
    return this.transitionTo(instance, definition, targetNodeId, transitionTarget.data.cycleInfo);
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

    if (
      instance.status === 'completed' ||
      instance.status === 'failed' ||
      instance.status === 'cancelled' ||
      instance.status === 'suspended'
    ) {
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
    cycleInfo?: CycleTransitionInfo,
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

        // Build context with action_result for transition evaluation (with $metadata)
        const actionResult: ActionResult = {
          exit_code: execResult.data.exit_code,
          stdout: execResult.data.stdout,
          stderr: execResult.data.stderr,
          ...(execResult.data.data !== undefined ? { data: execResult.data.data } : {}),
        };

        const $metadata = instance.payload['$metadata'] as WorkflowMetadata | undefined;
        const context: ExpressionContext = {
          payload: instance.payload,
          action_result: actionResult,
          ...(definition.metadata ? { metadata: definition.metadata } : {}),
          ...($metadata ? { $metadata } : {}),
        };

        // Evaluate transitions with budget enforcement and stall detection
        const transitionTarget = await this.evaluateTransitionsWithBudget(
          node.transitions,
          context,
          instance,
          definition,
          nodeId,
        );

        if (!transitionTarget.ok) {
          return transitionTarget;
        }

        // Handle stall detection — suspend the instance immediately
        if (transitionTarget.data.stallInfo) {
          return this.suspendForStall(instance, definition, transitionTarget.data.stallInfo);
        }

        const targetNodeId = transitionTarget.data.targetNodeId;
        const newCycleInfo = transitionTarget.data.cycleInfo;

        // Transition to the next node (update instance state)
        const targetNode = definition.nodes[targetNodeId]!;
        instance.currentNodeId = targetNodeId;
        instance.currentNodeType = targetNode.type;
        instance.updatedAt = Date.now();

        // Increment visit count in $metadata
        if ($metadata) {
          $metadata.visits[targetNodeId] = ($metadata.visits[targetNodeId] ?? 0) + 1;
        }

        // Add history entry for new node
        instance.history.push({
          nodeId: targetNodeId,
          nodeType: targetNode.type,
          enteredAt: Date.now(),
          payloadSnapshot: structuredClone(instance.payload),
        });

        this.emit('node:entered', instance.instanceId, targetNodeId);

        // Pass cycle info forward for next iteration
        cycleInfo = newCycleInfo;

        // Continue the loop — if next node is also system_action, auto-advance
        continue;
      }

      if (node.type === 'llm_decision' || node.type === 'llm_task') {
        return this.buildLlmAdvanceResult(instance, definition, node, chainResults, cycleInfo);
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
    cycleInfo?: CycleTransitionInfo,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const targetNode = definition.nodes[targetNodeId]!;

    // Update instance
    instance.currentNodeId = targetNodeId;
    instance.currentNodeType = targetNode.type;
    instance.updatedAt = Date.now();

    // Increment visit count in $metadata
    const $metadata = instance.payload['$metadata'] as WorkflowMetadata | undefined;
    if ($metadata) {
      $metadata.visits[targetNodeId] = ($metadata.visits[targetNodeId] ?? 0) + 1;
    }

    // Add history entry
    instance.history.push({
      nodeId: targetNodeId,
      nodeType: targetNode.type,
      enteredAt: Date.now(),
      payloadSnapshot: structuredClone(instance.payload),
    });

    this.emit('node:entered', instance.instanceId, targetNodeId);

    // Process the new current node
    return this.processCurrentNode(instance, definition, undefined, cycleInfo);
  }

  // -----------------------------------------------------------------------
  // Internal: Transition evaluation with max_visits enforcement
  // -----------------------------------------------------------------------

  /**
   * Evaluate transitions with max_visits budget enforcement and stall detection.
   *
   * For each matching transition, checks whether the target node has
   * `max_visits` and whether the budget is exhausted. For cycle back-edges,
   * runs the stall detector to check for idempotent iterations.
   * If all transitions are blocked, looks for a suspended terminal fallback.
   */
  private async evaluateTransitionsWithBudget(
    transitions: Array<{ condition: string; target: string; priority?: number | undefined }>,
    context: ExpressionContext,
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    fromNodeId: string,
  ): Promise<
    Result<{ targetNodeId: string; cycleInfo?: CycleTransitionInfo; stallInfo?: StallDetectionInfo }, RuntimeError>
  > {
    const $metadata = instance.payload['$metadata'] as WorkflowMetadata | undefined;

    // Sort by priority (ascending)
    const sorted = [...transitions].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const transition of sorted) {
      const result = await this.evaluator.evaluate(transition.condition, context);

      if (!result.ok) {
        const error: RuntimeError = {
          code: RuntimeErrorCode.EXPRESSION_ERROR,
          message: `Expression evaluation failed: ${result.errors.message}`,
          instanceId: instance.instanceId,
          nodeId: fromNodeId,
        };
        this.emit('error', instance.instanceId, error);
        return { ok: false, errors: error };
      }

      if (result.data === true) {
        const targetNodeId = transition.target;
        const targetNodeDef = definition.nodes[targetNodeId];

        // Check max_visits budget for the target node
        if (
          targetNodeDef &&
          targetNodeDef.type !== 'terminal' &&
          'max_visits' in targetNodeDef &&
          targetNodeDef.max_visits !== undefined &&
          $metadata
        ) {
          const currentVisits = $metadata.visits[targetNodeId] ?? 0;
          if (currentVisits >= targetNodeDef.max_visits) {
            // Budget exhausted for this target — skip this transition
            continue;
          }

          // This is a cycle back-edge if the target has been visited before
          if (currentVisits >= 1) {
            // Run stall detection for v2.0 workflows when there's action output to hash
            const isV2 = definition.version === '2.0';
            const hasActionResult = instance.payload['action_result'] != null;
            if (isV2 && hasActionResult) {
              const stallResult = await this.performStallCheck(
                instance,
                definition,
                fromNodeId,
                targetNodeId,
                currentVisits,
                targetNodeDef.max_visits,
                $metadata,
              );

              if (stallResult) {
                // Stall detected — return the stall info for the caller to handle
                return {
                  ok: true,
                  data: { targetNodeId, stallInfo: stallResult },
                };
              }
            }
          }

          // Build cycle info for agent messaging
          const cycleInfo: CycleTransitionInfo = {
            fromNodeId,
            toNodeId: targetNodeId,
            currentVisit: currentVisits + 1,
            maxVisits: targetNodeDef.max_visits,
          };

          return {
            ok: true,
            data: { targetNodeId, cycleInfo },
          };
        }

        return {
          ok: true,
          data: { targetNodeId },
        };
      }
    }

    // No transition matched — check if this is due to budget exhaustion
    // Look for a suspended terminal fallback
    for (const [nodeId, nodeDef] of Object.entries(definition.nodes)) {
      if (nodeDef.type === 'terminal' && nodeDef.status === 'suspended') {
        return {
          ok: true,
          data: { targetNodeId: nodeId },
        };
      }
    }

    // Check if any transitions were skipped due to budget — if so, it's a BUDGET_EXHAUSTED error
    // vs. NO_MATCHING_TRANSITION. We check if at least one transition condition was true but skipped.
    if ($metadata) {
      for (const transition of sorted) {
        const result = await this.evaluator.evaluate(transition.condition, context);
        if (result.ok && result.data === true) {
          const targetNodeDef = definition.nodes[transition.target];
          if (
            targetNodeDef &&
            targetNodeDef.type !== 'terminal' &&
            'max_visits' in targetNodeDef &&
            targetNodeDef.max_visits !== undefined
          ) {
            const currentVisits = $metadata.visits[transition.target] ?? 0;
            if (currentVisits >= targetNodeDef.max_visits) {
              const error: RuntimeError = {
                code: RuntimeErrorCode.BUDGET_EXHAUSTED,
                message: `All transitions from node "${fromNodeId}" are blocked because target nodes have exhausted their max_visits budget`,
                instanceId: instance.instanceId,
                nodeId: fromNodeId,
              };
              this.emit('error', instance.instanceId, error);
              return { ok: false, errors: error };
            }
          }
        }
      }
    }

    // No transitions matched at all (not budget related)
    const error: RuntimeError = {
      code: RuntimeErrorCode.NO_MATCHING_TRANSITION,
      message: `No transition matched for node "${fromNodeId}"`,
      instanceId: instance.instanceId,
      nodeId: fromNodeId,
    };
    this.emit('error', instance.instanceId, error);
    return { ok: false, errors: error };
  }

  // -----------------------------------------------------------------------
  // Internal: Stall detection
  // -----------------------------------------------------------------------

  /**
   * Perform a stall check before traversing a cycle back-edge.
   *
   * Extracts the last action output from the payload and runs the stall detector.
   * If no stall is detected, stores the current hash in `$metadata.state_hashes`.
   *
   * @returns StallDetectionInfo if stalled, undefined if not stalled.
   */
  private async performStallCheck(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    fromNodeId: string,
    targetNodeId: string,
    currentVisits: number,
    maxVisits: number,
    $metadata: WorkflowMetadata,
  ): Promise<StallDetectionInfo | undefined> {
    // Get the last action output from payload
    const actionResult = instance.payload['action_result'] as { stdout?: string; stderr?: string } | undefined;
    const actionOutput = actionResult ? `${actionResult.stdout ?? ''}${actionResult.stderr ?? ''}` : '';

    const previousHashes = $metadata.state_hashes ?? [];

    try {
      const stallResult = await this.stallDetector.check(previousHashes, actionOutput);

      if (stallResult.stalled) {
        // Determine which iteration matched
        const matchedIndex = previousHashes.indexOf(stallResult.matchedPreviousHash!);
        const matchedIteration = matchedIndex + 1;

        // Set stall_detected in $metadata
        $metadata.stall_detected = true;

        // Emit informational error event
        const error: RuntimeError = {
          code: RuntimeErrorCode.STALL_DETECTED,
          message: `Stall detected: workspace state hash sha256:${stallResult.currentHash} matches iteration ${matchedIteration}. Zero functional progress in ${fromNodeId} → ${targetNodeId} cycle.`,
          instanceId: instance.instanceId,
          nodeId: fromNodeId,
        };
        this.emit('error', instance.instanceId, error);

        return {
          instanceId: instance.instanceId,
          sourceNodeId: fromNodeId,
          targetNodeId,
          visitCount: currentVisits,
          maxVisits,
          stateHash: stallResult.currentHash,
          matchedIteration,
        };
      }

      // No stall — store the current hash
      $metadata.state_hashes.push(stallResult.currentHash);
      return undefined;
    } catch {
      // Stall detection failure is non-fatal — log warning and continue
      return undefined;
    }
  }

  /**
   * Suspend an instance due to stall detection.
   *
   * Sets the instance status to 'suspended', builds the stall agent message,
   * and persists the instance.
   *
   * @param instance - The workflow instance.
   * @param definition - The workflow definition.
   * @param stallInfo - The stall detection info.
   * @returns An AdvanceResult with suspended status and stall message.
   */
  private async suspendForStall(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    stallInfo: StallDetectionInfo,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    const now = Date.now();

    // Set instance to suspended status
    instance.status = 'suspended';
    instance.terminalStatus = 'suspended';
    instance.completedAt = now;
    instance.updatedAt = now;

    // Mark current node completed in history
    const historyEntry = instance.history[instance.history.length - 1];
    if (historyEntry && historyEntry.nodeId === instance.currentNodeId) {
      historyEntry.completedAt = now;
    }

    // Format the stall agent message
    const agentMessage = formatStallMessage(stallInfo, definition.workflow_name);

    const advanceResult: AdvanceResult = {
      instanceId: instance.instanceId,
      status: 'suspended',
      terminalStatus: 'suspended',
      agentMessage,
    };

    await this.store.save(instance);
    this.emit('instance:completed', instance.instanceId, 'suspended');

    return { ok: true, data: advanceResult };
  }

  // -----------------------------------------------------------------------
  // Internal: System action execution
  // -----------------------------------------------------------------------

  /**
   * Execute a system_action node and merge its result into the payload.
   *
   * After execution:
   * 1. Always writes a file pointer log (v2.0 workflows only).
   * 2. If node has `extract_json`, extracts structured JSON into `payload.extracted_json`.
   * 3. Sets `payload.log_pointer_path` to the file pointer log path.
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

    // --- File pointer and extract_json (v2.0 only) ---
    const isV2 = definition.version === '2.0';
    if (isV2) {
      // 1. Write file pointer log
      const $metadata = instance.payload['$metadata'] as WorkflowMetadata | undefined;
      const visitCount = $metadata?.visits[nodeId] ?? 1;
      const logPath = this.executor.writeFilePointerLog(
        instance.instanceId,
        nodeId,
        visitCount,
        result.data.command_executed,
        result.data,
      );

      if (logPath) {
        payloadManager.merge(nodeId, { log_pointer_path: logPath });
      }

      // 2. Extract JSON if node has extract_json
      if (node.extract_json) {
        // Resolve Handlebars templates in the extract_json path
        const pathContext: Record<string, unknown> = {
          payload: payloadManager.getPayload(),
          metadata: definition.metadata ?? {},
        };
        const pathResult = resolveTemplate(node.extract_json, pathContext);
        const resolvedPath = pathResult.ok ? pathResult.data : node.extract_json;

        const extraction = await extractJson(resolvedPath);
        if (extraction.success && extraction.data) {
          payloadManager.merge(nodeId, { extracted_json: extraction.data });
        } else {
          payloadManager.merge(nodeId, { extracted_json: null });
        }
      }
    }

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
    cycleInfo?: CycleTransitionInfo,
  ): Promise<Result<AdvanceResult, RuntimeError>> {
    instance.status = 'waiting_for_agent';
    instance.updatedAt = Date.now();

    // Resolve instruction template (includes $metadata for visit counts)
    const $meta = instance.payload['$metadata'] as WorkflowMetadata | undefined;
    const templateResult = resolveTemplate(node.instruction, {
      payload: instance.payload,
      metadata: definition.metadata ?? {},
      ...($meta ? { $metadata: $meta } : {}),
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

    const agentMessage = formatAgentMessage(partialResult, instance.workflowName, cycleInfo);

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
    // Map terminal status 'suspended' to InstanceStatus 'suspended', all others to 'completed'
    instance.status = node.status === 'suspended' ? 'suspended' : 'completed';
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
      status: instance.status,
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

    // Clean up file pointer logs for this instance on terminal state
    try {
      const cleaned = this.executor.cleanupFilePointerLogs(instance.instanceId);
      if (cleaned > 0) {
        // Cleanup success — non-critical, just informational
      }
    } catch {
      // Cleanup failure is non-fatal — do not block workflow completion
    }

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
