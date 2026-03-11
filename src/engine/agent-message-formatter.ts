/**
 * Agent Message Formatter — formats structured AdvanceResult data
 * into the markdown message format defined in the DAWE PRD.
 *
 * The format is a key part of the contract with the Pi agent:
 *
 * ```
 * > WORKFLOW: issue-first-development (instance abc-123)
 * > STATUS: [system action result or transition summary]
 * > CURRENT NODE: llm_implement_code
 * > NODE TYPE: llm_task
 * > INSTRUCTIONS: You are currently on branch bug/issue-198...
 * > REQUIRED ACTION: When coding is complete, call advance_workflow with ...
 * ```
 */

import type { AdvanceResult, SystemActionChainEntry } from './advance-result.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Cycle transition info for agent message formatting. */
export interface CycleTransitionInfo {
  /** Source node ID. */
  fromNodeId: string;
  /** Target node ID (the back-edge target). */
  toNodeId: string;
  /** Current visit count for the target node (after this transition). */
  currentVisit: number;
  /** Maximum visits allowed for the target node. */
  maxVisits: number;
}

/** Stall detection info for agent message formatting. */
export interface StallDetectionInfo {
  /** The instance ID. */
  instanceId: string;
  /** The source node (where the back-edge originates). */
  sourceNodeId: string;
  /** The target node (the back-edge target that was stalled). */
  targetNodeId: string;
  /** Current visit count for the source node. */
  visitCount: number;
  /** Maximum visits allowed for the target node. */
  maxVisits: number;
  /** The SHA-256 hash of the stalled state. */
  stateHash: string;
  /** Which iteration matched the current hash. */
  matchedIteration: number;
}

/**
 * Format an AdvanceResult into the agent-facing markdown message.
 *
 * @param result - The AdvanceResult to format.
 * @param workflowName - The workflow name for the header.
 * @param cycleInfo - Optional cycle transition info for bounded cycle messages.
 * @returns Formatted markdown string.
 */
export function formatAgentMessage(
  result: Omit<AdvanceResult, 'agentMessage'>,
  workflowName: string,
  cycleInfo?: CycleTransitionInfo,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`> WORKFLOW: ${workflowName} (instance ${result.instanceId})`);

  // Status line — summarize system action chain results if any
  if (result.systemActionResults && result.systemActionResults.length > 0) {
    const summary = formatSystemActionSummary(result.systemActionResults);
    lines.push(`> STATUS: ${summary}`);
  } else if (result.status === 'completed') {
    lines.push(`> STATUS: Workflow completed with status: ${result.terminalStatus ?? 'unknown'}`);
  } else {
    lines.push(`> STATUS: Transitioned to node`);
  }

  // Cycle transition info (P1)
  if (cycleInfo) {
    lines.push(
      `> CYCLE: ${cycleInfo.fromNodeId} → ${cycleInfo.toNodeId} (attempt ${cycleInfo.currentVisit} of ${cycleInfo.maxVisits})`,
    );
  }

  if (result.status === 'waiting_for_agent') {
    // Current node info
    lines.push(`> CURRENT NODE: ${result.currentNodeId ?? 'unknown'}`);
    lines.push(`> NODE TYPE: ${result.currentNodeType ?? 'unknown'}`);

    // Instructions
    if (result.instruction) {
      lines.push(`> INSTRUCTIONS: ${result.instruction}`);
    }

    // Context payload
    if (result.contextPayload && Object.keys(result.contextPayload).length > 0) {
      lines.push(`> CONTEXT: ${JSON.stringify(result.contextPayload)}`);
    }

    // Required action hint
    if (result.currentNodeType === 'llm_decision') {
      const schemaHint = result.requiredSchema ? JSON.stringify(result.requiredSchema) : '{}';
      lines.push(
        `> REQUIRED ACTION: Respond by calling advance_workflow with current_node_id: "${result.currentNodeId}" and node_payload matching schema: ${schemaHint}`,
      );
    } else if (result.currentNodeType === 'llm_task') {
      const schemaHint = result.completionSchema ? JSON.stringify(result.completionSchema) : '{}';
      lines.push(
        `> REQUIRED ACTION: When complete, call advance_workflow with current_node_id: "${result.currentNodeId}" and node_payload matching schema: ${schemaHint}`,
      );
    }
  } else if (result.status === 'completed') {
    // Terminal info
    lines.push(`> TERMINAL STATUS: ${result.terminalStatus ?? 'unknown'}`);
    if (result.terminalMessage) {
      lines.push(`> MESSAGE: ${result.terminalMessage}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a stall detection message for the agent.
 *
 * @param info - Stall detection details.
 * @param workflowName - The workflow name for the header.
 * @returns Formatted markdown string.
 */
export function formatStallMessage(info: StallDetectionInfo, workflowName: string): string {
  const lines: string[] = [];

  lines.push(`> WORKFLOW: ${workflowName} (instance ${info.instanceId})`);
  lines.push(`> STALL DETECTED. The workspace state is identical to a previous iteration.`);
  lines.push(`> The agent has made zero functional progress in the ${info.sourceNodeId} → ${info.targetNodeId} cycle.`);
  lines.push(`> WORKFLOW SUSPENDED for human review.`);
  lines.push(`> Instance ID: ${info.instanceId}`);
  lines.push(`> Stalled at: ${info.sourceNodeId} (visit ${info.visitCount} of ${info.maxVisits})`);
  lines.push(`> State hash: sha256:${info.stateHash}`);
  lines.push(`> Previous match: iteration ${info.matchedIteration}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Summarize system action chain results into a single status line.
 */
function formatSystemActionSummary(entries: SystemActionChainEntry[]): string {
  const parts = entries.map((entry) => {
    const exitCode = entry.actionResult.exit_code;
    const timedOut = entry.actionResult.timed_out;
    if (timedOut) {
      return `${entry.nodeId}: timed out`;
    }
    return `${entry.nodeId}: exit ${exitCode}`;
  });
  return `System actions executed: ${parts.join(', ')}`;
}
