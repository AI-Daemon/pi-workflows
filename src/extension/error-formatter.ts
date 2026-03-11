/**
 * Error Formatter — Converts various error conditions from the
 * advance_workflow tool handler into clear, actionable markdown.
 *
 * Complements response-formatter.ts by handling the error path.
 */

import type { RuntimeError } from '../engine/runtime-errors.js';

// ---------------------------------------------------------------------------
// Detailed payload validation error
// ---------------------------------------------------------------------------

export interface PayloadFieldError {
  field: string;
  expectedType: string;
  issue: 'missing' | 'wrong_type';
  actualType?: string;
}

/**
 * Format a detailed payload validation error with field-level details.
 */
export function formatPayloadValidationError(
  nodeId: string,
  instanceId: string,
  fieldErrors: PayloadFieldError[],
  schema: Record<string, string>,
): string {
  const lines: string[] = [];

  lines.push(`> **ERROR:** Payload validation failed for node \`${nodeId}\``);
  lines.push('');
  lines.push('The following fields are missing or have incorrect types:');

  for (const err of fieldErrors) {
    if (err.issue === 'missing') {
      lines.push(`- \`${err.field}\` (expected: ${err.expectedType}) — MISSING`);
    } else {
      lines.push(
        `- \`${err.field}\` (expected: ${err.expectedType}) — got ${err.actualType ?? 'unknown'}`,
      );
    }
  }

  lines.push('');
  lines.push('Please call `advance_workflow` again with the correct payload:');
  lines.push('```json');

  const example: Record<string, string> = {};
  for (const [key, type] of Object.entries(schema)) {
    example[key] = `<${type}>`;
  }

  lines.push(
    JSON.stringify(
      {
        action: 'advance',
        instance_id: instanceId,
        current_node_id: nodeId,
        node_payload: example,
      },
      null,
      2,
    ),
  );
  lines.push('```');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Missing parameter errors
// ---------------------------------------------------------------------------

/**
 * Format a missing required parameter error.
 */
export function formatMissingParameterError(
  action: string,
  missingParams: string[],
): string {
  const lines: string[] = [];

  lines.push(`> **ERROR:** Missing required parameter(s) for action \`${action}\``);
  lines.push('');
  lines.push(`The following parameters are required: ${missingParams.map((p) => `\`${p}\``).join(', ')}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Workflow not found error
// ---------------------------------------------------------------------------

/**
 * Format a workflow-not-found error with available workflow list.
 */
export function formatWorkflowNotFoundError(
  workflowName: string,
  availableWorkflows: string[],
): string {
  const lines: string[] = [];

  lines.push(`> **ERROR:** Workflow "${workflowName}" not found.`);
  lines.push('');

  if (availableWorkflows.length > 0) {
    lines.push('Available workflows:');
    for (const name of availableWorkflows) {
      lines.push(`- ${name}`);
    }
    lines.push('');
    lines.push('Call advance_workflow with action: "list" to see full details.');
  } else {
    lines.push('No workflows are currently available.');
    lines.push('Ensure workflow YAML files are placed in `./workflows/` or `~/.pi/workflows/`.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generic runtime error
// ---------------------------------------------------------------------------

/**
 * Format any RuntimeError into actionable markdown.
 */
export function formatRuntimeError(error: RuntimeError): string {
  const lines: string[] = [];

  lines.push(`> **ERROR:** ${error.code}`);
  lines.push('');
  lines.push(error.message);

  if (error.instanceId) {
    lines.push('');
    lines.push(`Instance: \`${error.instanceId}\``);
  }

  if (error.nodeId) {
    lines.push(`Node: \`${error.nodeId}\``);
  }

  return lines.join('\n');
}
