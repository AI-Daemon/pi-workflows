/**
 * Pi Extension Entry Point — Registers the `advance_workflow` tool.
 *
 * This is the boundary layer between the DAWE engine and the Pi agent.
 * The tool is the ONLY way the agent interacts with workflows.
 *
 * Pi Extension SDK: uses defineExtension pattern from @mariozechner/pi-coding-agent.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { StringEnum } from '@mariozechner/pi-ai';

import { WorkflowRuntime } from '../engine/workflow-runtime.js';
import { WorkflowRegistry, PACKAGE_ROOT, BUNDLED_SCRIPTS_DIR } from './workflow-registry.js';
import { AdvanceWorkflowHandler } from './advance-workflow-tool.js';
import type { AdvanceWorkflowInput } from './advance-workflow-tool.js';

// Re-export all extension modules
export { WorkflowRegistry, PACKAGE_ROOT, BUNDLED_EXAMPLES_DIR, BUNDLED_SCRIPTS_DIR } from './workflow-registry.js';
export type { WorkflowSummary } from './workflow-registry.js';
export { AdvanceWorkflowHandler } from './advance-workflow-tool.js';
export type { AdvanceWorkflowInput, AdvanceWorkflowOutput } from './advance-workflow-tool.js';
export {
  formatListResponse,
  formatAdvanceResponse,
  formatCompletedResponse,
  formatStatusResponse,
  formatCancelResponse,
  formatErrorResponse,
  formatSimpleError,
  formatActiveInstanceWarning,
} from './response-formatter.js';
export {
  formatPayloadValidationError,
  formatMissingParameterError,
  formatWorkflowNotFoundError,
  formatRuntimeError,
} from './error-formatter.js';
export type { PayloadFieldError } from './error-formatter.js';

// ---------------------------------------------------------------------------
// Tool parameter schema (using TypeBox for Pi SDK compatibility)
// ---------------------------------------------------------------------------

const AdvanceWorkflowParams = Type.Object({
  action: StringEnum(['list', 'start', 'advance', 'status', 'cancel'] as const, {
    description:
      "The action to perform. 'list' shows available workflows. 'start' begins a new instance. 'advance' submits data for the current node. 'status' shows current instance state. 'cancel' aborts an instance.",
  }),
  workflow_name: Type.Optional(
    Type.String({
      description: "Name of the workflow to start (for 'start' action).",
    }),
  ),
  instance_id: Type.Optional(
    Type.String({
      description: 'The ID of the active workflow instance (for advance/status/cancel).',
    }),
  ),
  current_node_id: Type.Optional(
    Type.String({
      description: "The node you are currently completing (for 'advance' action).",
    }),
  ),
  node_payload: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "The JSON data required by the current node's schema (for 'advance' action).",
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description: 'Set to true to confirm starting a new workflow when one is already active.',
    }),
  ),
});

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Pi extension entry point. Registers the advance_workflow tool.
 *
 * Configurable via ~/.pi/workflows/config.json:
 * {
 *   "workflow_dirs": ["./workflows", "~/.pi/workflows"],
 *   "default_executor_options": { "workingDir": "/root", "defaultTimeout": 30000 }
 * }
 */
export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  // Create runtime with DAWE_PACKAGE_ROOT and DAWE_SCRIPTS_DIR injected
  // into every system_action child process environment.
  const runtime = new WorkflowRuntime({
    executorOptions: {
      env: {
        DAWE_PACKAGE_ROOT: PACKAGE_ROOT,
        DAWE_SCRIPTS_DIR: BUNDLED_SCRIPTS_DIR,
      },
    },
  });
  const registry = new WorkflowRegistry();
  const handler = new AdvanceWorkflowHandler(runtime, registry);

  // Load workflows on session start
  pi.on('session_start', async () => {
    try {
      await registry.loadAll();
      const workflows = registry.list();
      if (workflows.length > 0) {
        // Silently loaded — workflows are available
      }
    } catch {
      // Non-fatal — tool will report no workflows available
    }
  });

  // Register the advance_workflow tool
  pi.registerTool({
    name: 'advance_workflow',
    label: 'Advance Workflow',
    description:
      'REQUIRED tool to progress through development workflows. Submits your current task data and receives the exact next step. Call with action "list" to see available workflows. Call with action "start" and workflow_name to begin a new workflow.',
    promptSnippet:
      'Progress through declarative development workflows — list, start, advance, check status, or cancel workflow instances.',
    promptGuidelines: [
      'Use advance_workflow with action "list" to discover available development workflows.',
      'When starting a workflow, use action "start" with the workflow_name.',
      'After receiving instructions, complete the task and call advance_workflow with action "advance", the instance_id, current_node_id, and your node_payload.',
    ],
    parameters: AdvanceWorkflowParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const input: AdvanceWorkflowInput = {
        action: params.action,
        workflow_name: params.workflow_name,
        instance_id: params.instance_id,
        current_node_id: params.current_node_id,
        node_payload: params.node_payload as Record<string, unknown> | undefined,
        confirm: params.confirm,
      };

      const result = await handler.handle(input);

      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { isError: result.isError, ux_controls: result.ux_controls },
      };
    },
  });
}
