/**
 * Response Formatter — Converts AdvanceResult, instance status, and errors
 * into clear, directive markdown that the LLM agent can follow.
 *
 * This is the critical boundary layer: the LLM reads this output to
 * determine what to do next. Format must be unambiguous.
 */

import type { AdvanceResult, WorkflowInstance, SystemActionChainEntry } from '../engine/advance-result.js';
import type { RuntimeError } from '../engine/runtime-errors.js';
import type { WorkflowSummary } from './workflow-registry.js';

// ---------------------------------------------------------------------------
// List response
// ---------------------------------------------------------------------------

/**
 * Format the list of available workflows as a markdown table.
 */
export function formatListResponse(workflows: WorkflowSummary[]): string {
  if (workflows.length === 0) {
    return [
      '## Available Workflows',
      '',
      'No workflows are currently available.',
      '',
      'Ensure workflow YAML files are placed in `./workflows/` or `~/.pi/workflows/`.',
    ].join('\n');
  }

  const lines: string[] = [
    '## Available Workflows',
    '',
    '| # | Workflow | Description |',
    '|---|---------|-------------|',
  ];

  for (let i = 0; i < workflows.length; i++) {
    const w = workflows[i]!;
    lines.push(`| ${i + 1} | ${w.name} | ${w.description} |`);
  }

  lines.push('');
  lines.push('To start a workflow, call advance_workflow with action: "start" and workflow_name: "<name>".');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Advance / Start response (waiting_for_agent)
// ---------------------------------------------------------------------------

/**
 * Format an AdvanceResult for an llm_decision or llm_task node.
 */
export function formatAdvanceResponse(result: AdvanceResult, workflowName: string): string {
  const lines: string[] = [];

  // Header block
  lines.push(`> **WORKFLOW:** ${workflowName}`);
  lines.push(`> **INSTANCE:** ${result.instanceId}`);

  if (result.status === 'waiting_for_agent') {
    if (result.systemActionResults && result.systemActionResults.length > 0) {
      lines.push(`> **STATUS:** System action completed successfully.`);
    } else {
      lines.push(`> **STATUS:** Awaiting agent input.`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // Current node
  lines.push(`## Current Node: \`${result.currentNodeId}\``);
  lines.push(`**Type:** ${result.currentNodeType}`);
  lines.push('');

  // Instructions
  if (result.instruction) {
    lines.push('### Instructions');
    lines.push(result.instruction);
    lines.push('');
  }

  // Context payload
  if (result.contextPayload && Object.keys(result.contextPayload).length > 0) {
    lines.push('### Context');
    for (const [key, value] of Object.entries(result.contextPayload)) {
      lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    }
    lines.push('');
  }

  // Required action
  lines.push('### Required Action');
  const schema: Record<string, string> = result.requiredSchema ?? result.completionSchema ?? {};
  const payloadExample: Record<string, string> = {};
  for (const [key, type] of Object.entries(schema)) {
    payloadExample[key] = `<${type}>`;
  }

  lines.push('When ready, call `advance_workflow` with:');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        action: 'advance',
        instance_id: result.instanceId,
        current_node_id: result.currentNodeId,
        node_payload: payloadExample,
      },
      null,
      2,
    ),
  );
  lines.push('```');

  // System action results
  if (result.systemActionResults && result.systemActionResults.length > 0) {
    lines.push('');
    lines.push('### System Actions Executed');
    for (const entry of result.systemActionResults) {
      const icon = entry.actionResult.exit_code === 0 ? '✅' : '❌';
      const exitInfo = entry.actionResult.timed_out
        ? 'timed out'
        : `exit code ${entry.actionResult.exit_code}`;
      lines.push(`- ${icon} \`${entry.nodeId}\`: ${exitInfo}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Completed response
// ---------------------------------------------------------------------------

/**
 * Format an AdvanceResult for a terminal node (workflow completed).
 */
export function formatCompletedResponse(result: AdvanceResult, workflowName: string, instance: WorkflowInstance): string {
  const lines: string[] = [];

  // Header
  lines.push(`> **WORKFLOW:** ${workflowName}`);
  lines.push(`> **INSTANCE:** ${result.instanceId}`);
  lines.push(`> **STATUS:** ✅ Workflow completed successfully.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary
  lines.push('## Summary');
  if (result.terminalMessage) {
    lines.push(result.terminalMessage);
  } else {
    lines.push(`The ${workflowName} workflow has completed with status: ${result.terminalStatus ?? 'unknown'}.`);
  }
  lines.push('');

  // Workflow history
  lines.push('### Workflow History');
  for (let i = 0; i < instance.history.length; i++) {
    const entry = instance.history[i]!;
    const icon = entry.completedAt ? '✅' : '⏳';
    lines.push(`${i + 1}. ${icon} ${entry.nodeId} (${entry.nodeType})`);
  }

  // System action results from this final advance
  if (result.systemActionResults && result.systemActionResults.length > 0) {
    lines.push('');
    lines.push('### System Actions Executed');
    for (const entry of result.systemActionResults) {
      const icon = entry.actionResult.exit_code === 0 ? '✅' : '❌';
      const exitInfo = entry.actionResult.timed_out
        ? 'timed out'
        : `exit code ${entry.actionResult.exit_code}`;
      lines.push(`- ${icon} \`${entry.nodeId}\`: ${exitInfo}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Status response
// ---------------------------------------------------------------------------

/**
 * Format the status of a workflow instance.
 */
export function formatStatusResponse(instance: WorkflowInstance): string {
  const lines: string[] = [];

  lines.push(`> **WORKFLOW:** ${instance.workflowName}`);
  lines.push(`> **INSTANCE:** ${instance.instanceId}`);
  lines.push(`> **STATUS:** ${instance.status}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push(`## Instance Status`);
  lines.push('');
  lines.push(`- **Current Node:** ${instance.currentNodeId}`);
  lines.push(`- **Node Type:** ${instance.currentNodeType}`);
  lines.push(`- **Status:** ${instance.status}`);

  if (instance.terminalStatus) {
    lines.push(`- **Terminal Status:** ${instance.terminalStatus}`);
  }
  if (instance.terminalMessage) {
    lines.push(`- **Message:** ${instance.terminalMessage}`);
  }

  lines.push('');
  lines.push('### Visited Nodes');
  for (let i = 0; i < instance.history.length; i++) {
    const entry = instance.history[i]!;
    const icon = entry.completedAt ? '✅' : '⏳';
    lines.push(`${i + 1}. ${icon} ${entry.nodeId} (${entry.nodeType})`);
  }

  // Payload summary
  const payloadKeys = Object.keys(instance.payload);
  if (payloadKeys.length > 0) {
    lines.push('');
    lines.push('### Payload Summary');
    lines.push(`Keys: ${payloadKeys.join(', ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cancel response
// ---------------------------------------------------------------------------

/**
 * Format a cancellation confirmation.
 */
export function formatCancelResponse(instanceId: string, workflowName: string): string {
  return [
    `> **WORKFLOW:** ${workflowName}`,
    `> **INSTANCE:** ${instanceId}`,
    `> **STATUS:** ❌ Workflow instance cancelled.`,
    '',
    'The workflow instance has been cancelled and can no longer be advanced.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

/**
 * Format a runtime error into actionable markdown.
 */
export function formatErrorResponse(error: RuntimeError): string {
  const lines: string[] = [];

  lines.push(`> **ERROR:** ${error.code}`);
  lines.push('');
  lines.push(error.message);

  if (error.code === 'PAYLOAD_VALIDATION_FAILED' && error.nodeId) {
    lines.push('');
    lines.push(`Please call \`advance_workflow\` again with the correct payload for node \`${error.nodeId}\`.`);
  }

  if (error.code === 'NODE_MISMATCH' && error.instanceId) {
    lines.push('');
    lines.push(`Please ensure you are using the correct \`current_node_id\` for instance \`${error.instanceId}\`.`);
  }

  return lines.join('\n');
}

/**
 * Format a simple error message.
 */
export function formatSimpleError(message: string): string {
  return `> **ERROR:** ${message}`;
}

// ---------------------------------------------------------------------------
// Warning responses (P1)
// ---------------------------------------------------------------------------

/**
 * Format an active instance warning.
 */
export function formatActiveInstanceWarning(
  activeInstanceId: string,
  activeNodeId: string,
): string {
  return [
    `> **WARNING:** You have an active workflow instance (${activeInstanceId}) on node \`${activeNodeId}\`.`,
    `> Starting a new workflow will NOT cancel the existing one.`,
    `> Do you want to continue? Call advance_workflow with action: "start" and add "confirm": true.`,
  ].join('\n');
}
