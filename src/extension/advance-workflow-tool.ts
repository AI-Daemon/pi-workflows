/**
 * advance_workflow Tool — The agent-facing interface to the DAWE engine.
 *
 * This is a thin adapter: validate inputs, delegate to WorkflowRuntime,
 * format output. No business logic in the tool handler itself.
 *
 * Actions:
 * - list:    Show available workflows
 * - start:   Begin a new workflow instance
 * - advance: Submit agent data for the current node
 * - status:  Show current instance state
 * - cancel:  Abort an instance
 */

import type { WorkflowRuntime } from '../engine/workflow-runtime.js';
import type { WorkflowRegistry } from './workflow-registry.js';
import type { AdvanceResult } from '../engine/advance-result.js';

import {
  formatListResponse,
  formatAdvanceResponse,
  formatCompletedResponse,
  formatStatusResponse,
  formatCancelResponse,
  formatErrorResponse,
  formatActiveInstanceWarning,
} from './response-formatter.js';

import {
  formatMissingParameterError,
  formatWorkflowNotFoundError,
  formatRuntimeError,
} from './error-formatter.js';

import { stringify as yamlStringify } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for the advance_workflow tool. */
export interface AdvanceWorkflowInput {
  action: 'list' | 'start' | 'advance' | 'status' | 'cancel';
  workflow_name?: string | undefined;
  instance_id?: string | undefined;
  current_node_id?: string | undefined;
  node_payload?: Record<string, unknown> | undefined;
  confirm?: boolean | undefined;
}

/** Output from the tool handler. */
export interface AdvanceWorkflowOutput {
  text: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// AdvanceWorkflowHandler
// ---------------------------------------------------------------------------

export class AdvanceWorkflowHandler {
  private readonly runtime: WorkflowRuntime;
  private readonly registry: WorkflowRegistry;

  /** Tracks active instance IDs — maps instance_id to workflow_name */
  private readonly activeInstances = new Map<string, string>();

  constructor(runtime: WorkflowRuntime, registry: WorkflowRegistry) {
    this.runtime = runtime;
    this.registry = registry;
  }

  /**
   * Handle a tool call. Dispatches to the appropriate action handler.
   */
  async handle(input: AdvanceWorkflowInput): Promise<AdvanceWorkflowOutput> {
    // P1: Auto-resume — no arguments and exactly one active instance
    if (!input.action) {
      return this.handleAutoResume();
    }

    switch (input.action) {
      case 'list':
        return this.handleList();
      case 'start':
        return this.handleStart(input);
      case 'advance':
        return this.handleAdvance(input);
      case 'status':
        return this.handleStatus(input);
      case 'cancel':
        return this.handleCancel(input);
      default:
        return {
          text: `> **ERROR:** Unknown action "${String(input.action)}". Valid actions: list, start, advance, status, cancel.`,
          isError: true,
        };
    }
  }

  // -----------------------------------------------------------------------
  // Action: list
  // -----------------------------------------------------------------------

  private handleList(): AdvanceWorkflowOutput {
    const workflows = this.registry.list();
    return { text: formatListResponse(workflows) };
  }

  // -----------------------------------------------------------------------
  // Action: start
  // -----------------------------------------------------------------------

  private async handleStart(input: AdvanceWorkflowInput): Promise<AdvanceWorkflowOutput> {
    if (!input.workflow_name) {
      return {
        text: formatMissingParameterError('start', ['workflow_name']),
        isError: true,
      };
    }

    // P1: Active instance warning
    if (!input.confirm && this.activeInstances.size > 0) {
      const [activeId, _] = [...this.activeInstances.entries()][0]!;
      const instance = await this.runtime.getInstance(activeId);
      if (instance && (instance.status === 'active' || instance.status === 'waiting_for_agent')) {
        return {
          text: formatActiveInstanceWarning(activeId, instance.currentNodeId),
        };
      }
    }

    // Look up workflow definition
    const definition = this.registry.get(input.workflow_name);
    if (!definition) {
      const availableNames = this.registry.list().map((w) => w.name);
      return {
        text: formatWorkflowNotFoundError(input.workflow_name, availableNames),
        isError: true,
      };
    }

    // Load the workflow into the runtime
    const yamlContent = this.buildMinimalYaml(definition);
    const loadResult = this.runtime.loadWorkflow(yamlContent);
    if (!loadResult.ok) {
      return {
        text: `> **ERROR:** Failed to load workflow "${input.workflow_name}": ${JSON.stringify(loadResult.errors)}`,
        isError: true,
      };
    }

    const workflowId = loadResult.data;

    // Start the instance
    const startResult = await this.runtime.startInstance(workflowId, input.node_payload ?? {});
    if (!startResult.ok) {
      return {
        text: formatRuntimeError(startResult.errors),
        isError: true,
      };
    }

    const result = startResult.data;

    // Track the instance
    this.activeInstances.set(result.instanceId, input.workflow_name);

    // Format response based on status
    return this.formatResult(result, input.workflow_name);
  }

  // -----------------------------------------------------------------------
  // Action: advance
  // -----------------------------------------------------------------------

  private async handleAdvance(input: AdvanceWorkflowInput): Promise<AdvanceWorkflowOutput> {
    const missing: string[] = [];
    if (!input.instance_id) missing.push('instance_id');
    if (!input.current_node_id) missing.push('current_node_id');
    if (!input.node_payload) missing.push('node_payload');

    if (missing.length > 0) {
      return {
        text: formatMissingParameterError('advance', missing),
        isError: true,
      };
    }

    const advanceResult = await this.runtime.advance(
      input.instance_id!,
      input.current_node_id!,
      input.node_payload!,
    );

    if (!advanceResult.ok) {
      return {
        text: formatErrorResponse(advanceResult.errors),
        isError: true,
      };
    }

    const result = advanceResult.data;
    const workflowName = this.activeInstances.get(input.instance_id!) ?? 'unknown';

    // Clean up completed instances from tracking
    if (result.status === 'completed' || result.status === 'failed') {
      this.activeInstances.delete(input.instance_id!);
    }

    return this.formatResult(result, workflowName);
  }

  // -----------------------------------------------------------------------
  // Action: status
  // -----------------------------------------------------------------------

  private async handleStatus(input: AdvanceWorkflowInput): Promise<AdvanceWorkflowOutput> {
    if (!input.instance_id) {
      return {
        text: formatMissingParameterError('status', ['instance_id']),
        isError: true,
      };
    }

    const instance = await this.runtime.getInstance(input.instance_id);
    if (!instance) {
      return {
        text: `> **ERROR:** INSTANCE_NOT_FOUND\n\nInstance "${input.instance_id}" not found.`,
        isError: true,
      };
    }

    return { text: formatStatusResponse(instance) };
  }

  // -----------------------------------------------------------------------
  // Action: cancel
  // -----------------------------------------------------------------------

  private async handleCancel(input: AdvanceWorkflowInput): Promise<AdvanceWorkflowOutput> {
    if (!input.instance_id) {
      return {
        text: formatMissingParameterError('cancel', ['instance_id']),
        isError: true,
      };
    }

    const cancelResult = await this.runtime.cancelInstance(input.instance_id);
    if (!cancelResult.ok) {
      return {
        text: formatErrorResponse(cancelResult.errors),
        isError: true,
      };
    }

    const workflowName = this.activeInstances.get(input.instance_id) ?? 'unknown';
    this.activeInstances.delete(input.instance_id);

    return { text: formatCancelResponse(input.instance_id, workflowName) };
  }

  // -----------------------------------------------------------------------
  // P1: Auto-resume
  // -----------------------------------------------------------------------

  private async handleAutoResume(): Promise<AdvanceWorkflowOutput> {
    // Find active instances
    const activeEntries = [...this.activeInstances.entries()];
    if (activeEntries.length === 0) {
      return this.handleList();
    }

    if (activeEntries.length === 1) {
      const [instanceId] = activeEntries[0]!;
      const instance = await this.runtime.getInstance(instanceId);
      if (instance && (instance.status === 'active' || instance.status === 'waiting_for_agent')) {
        return { text: formatStatusResponse(instance) };
      }
    }

    // Multiple active — list them
    return this.handleList();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Format an AdvanceResult into the appropriate output based on status.
   */
  private async formatResult(result: AdvanceResult, workflowName: string): Promise<AdvanceWorkflowOutput> {
    if (result.status === 'waiting_for_agent') {
      return { text: formatAdvanceResponse(result, workflowName) };
    }

    if (result.status === 'completed' || result.status === 'failed') {
      const instance = await this.runtime.getInstance(result.instanceId);
      if (instance) {
        return { text: formatCompletedResponse(result, workflowName, instance) };
      }
      // Fallback
      return { text: formatAdvanceResponse(result, workflowName) };
    }

    // Fallback for unexpected status
    return { text: result.agentMessage ?? `Status: ${result.status}` };
  }

  /**
   * Re-serialize a WorkflowDefinition to YAML for loading into the runtime.
   * The runtime's loadWorkflow() parses YAML, so we serialize the definition.
   */
  private buildMinimalYaml(definition: import('../schemas/workflow.schema.js').WorkflowDefinition): string {
    return yamlStringify(definition);
  }
}
