/**
 * AdvanceResult and related types for the Workflow Runtime Engine.
 *
 * `AdvanceResult` is the structured response returned to the agent
 * after calling `advance()` or `startInstance()`. It communicates:
 * - The current instance status
 * - What the agent should do next (for llm_* nodes)
 * - Terminal status (for completed workflows)
 * - System action chain results (for auto-advanced system_action nodes)
 * - A formatted agent message
 */

import type { ExecutorActionResult } from './action-result.js';

// ---------------------------------------------------------------------------
// Instance types
// ---------------------------------------------------------------------------

/** Status of a workflow instance. */
export type InstanceStatus = 'active' | 'waiting_for_agent' | 'completed' | 'failed' | 'cancelled' | 'suspended';

/** A single entry in the instance's node visit history. */
export interface InstanceHistoryEntry {
  /** The node ID that was visited. */
  nodeId: string;
  /** The type of the node. */
  nodeType: string;
  /** Unix timestamp (ms) when the node was entered. */
  enteredAt: number;
  /** Unix timestamp (ms) when the node was completed. */
  completedAt?: number;
  /** Deep clone of the payload state when entering this node. */
  payloadSnapshot: Record<string, unknown>;
}

/** A running workflow instance. */
export interface WorkflowInstance {
  /** Unique instance identifier (UUID). */
  instanceId: string;
  /** References the loaded workflow definition. */
  workflowId: string;
  /** Human-readable workflow name. */
  workflowName: string;
  /** Current lifecycle status. */
  status: InstanceStatus;
  /** The ID of the current node. */
  currentNodeId: string;
  /** The type of the current node. */
  currentNodeType: string;
  /** Current accumulated payload state. */
  payload: Record<string, unknown>;
  /** Ordered list of visited nodes. */
  history: InstanceHistoryEntry[];
  /** Unix timestamp (ms) when the instance was created. */
  createdAt: number;
  /** Unix timestamp (ms) when the instance was last updated. */
  updatedAt: number;
  /** Unix timestamp (ms) when the instance completed (if applicable). */
  completedAt?: number;
  /** Terminal status (if completed). */
  terminalStatus?: 'success' | 'failure' | 'cancelled' | 'suspended';
  /** Terminal message (if completed). */
  terminalMessage?: string;
}

// ---------------------------------------------------------------------------
// AdvanceResult
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UX Controls
// ---------------------------------------------------------------------------

/**
 * UX controls resolved by the engine for the Pi extension TUI layer.
 *
 * Populated on every `AdvanceResult` with `status === 'waiting_for_agent'`.
 * Provides a clean, structured contract so the extension can drive the TUI
 * without parsing instructions or guessing node intent.
 */
export interface UxControls {
  /** Resolved spinner text for the TUI. Derived from `ui_spinner` override or `LexicalFormatter.toActionPhrase(nodeId)`. */
  base_spinner: string;
  /** When true, suppress native Pi tool JSON output in the TUI. */
  hide_tools: boolean;
  /** When true, show advance_workflow payload in TUI output for debugging. */
  show_output: boolean;
}

// ---------------------------------------------------------------------------
// System action chain entry
// ---------------------------------------------------------------------------

/** Entry for a system action that was auto-executed during advancement. */
export interface SystemActionChainEntry {
  /** The system_action node ID. */
  nodeId: string;
  /** The execution result from the SystemActionExecutor. */
  actionResult: ExecutorActionResult;
}

/** The structured result returned after advancing a workflow instance. */
export interface AdvanceResult {
  /** The instance ID. */
  instanceId: string;
  /** The current instance status after advancement. */
  status: InstanceStatus;

  // -- Fields for 'waiting_for_agent' status --

  /** The current node ID (when waiting for agent). */
  currentNodeId?: string;
  /** The current node type (when waiting for agent). */
  currentNodeType?: 'llm_decision' | 'llm_task';
  /** Resolved instruction with payload variables injected. */
  instruction?: string;
  /** Required schema for llm_decision nodes. */
  requiredSchema?: Record<string, string>;
  /** Completion schema for llm_task nodes. */
  completionSchema?: Record<string, string>;
  /** Scoped payload for context_keys. */
  contextPayload?: Record<string, unknown>;

  // -- UX Controls --

  /** UX controls for the Pi extension TUI layer. Present when status is 'waiting_for_agent'. */
  ux_controls?: UxControls;

  // -- Fields for 'completed' status --

  /** Terminal status (when completed). */
  terminalStatus?: 'success' | 'failure' | 'cancelled' | 'suspended';
  /** Terminal message (when completed). */
  terminalMessage?: string;

  // -- System action chain results --

  /** Results from system_action nodes auto-executed during this advance. */
  systemActionResults?: SystemActionChainEntry[];

  // -- Formatted agent message --

  /** Formatted markdown response for the agent. */
  agentMessage: string;
}
