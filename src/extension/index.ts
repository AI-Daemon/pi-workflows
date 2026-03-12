/**
 * Pi Extension Entry Point — Registers the `advance_workflow` tool and
 * manages dynamic UX behavior (tool suppression, spinner concatenation).
 *
 * This is the boundary layer between the DAWE engine and the Pi agent.
 * The tool is the ONLY way the agent interacts with workflows.
 *
 * DAWE-005: Adds UX state caching, onToolCall hook, TUI muting, and
 * dynamic spinner concatenation via the Pi ExtensionAPI lifecycle events.
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
import { UxStateManager } from './ux-state.js';

// Re-export all extension modules
export { WorkflowRegistry, PACKAGE_ROOT, BUNDLED_EXAMPLES_DIR, BUNDLED_SCRIPTS_DIR } from './workflow-registry.js';
export type { WorkflowSummary } from './workflow-registry.js';
export { AdvanceWorkflowHandler } from './advance-workflow-tool.js';
export type { AdvanceWorkflowInput, AdvanceWorkflowOutput } from './advance-workflow-tool.js';
export { UxStateManager } from './ux-state.js';
export type { ActiveUxState } from './ux-state.js';
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
 * Pi extension entry point. Registers the advance_workflow tool and
 * wires up lifecycle hooks for dynamic UX behavior.
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

  // DAWE-005: UX state manager — caches ux_controls across agent turns
  const uxState = new UxStateManager();

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

  // DAWE-005: Clear UX state on session shutdown
  pi.on('session_shutdown', () => {
    uxState.clear();
  });

  // -------------------------------------------------------------------------
  // DAWE-005: tool_call hook — suppress native tool output when hide_tools
  // -------------------------------------------------------------------------
  pi.on('tool_call', (event) => {
    if (!uxState.shouldSuppressTool(event.toolName)) return;

    // Block is not needed — we use tool_result to suppress output.
    // The tool_call hook is used only for early spinner update.
    return undefined;
  });

  // -------------------------------------------------------------------------
  // DAWE-005: tool_execution_start — update spinner with tool action phrase
  // -------------------------------------------------------------------------
  pi.on('tool_execution_start', (event, ctx) => {
    if (!uxState.shouldSuppressTool(event.toolName)) return;

    // Set dynamic spinner: "{base_spinner}... {ActionPhrase}..."
    const spinnerText = uxState.getSpinnerWithTool(event.toolName);
    ctx.ui.setWorkingMessage(spinnerText);
  });

  // -------------------------------------------------------------------------
  // DAWE-005: tool_execution_end — revert spinner to base and suppress output
  // -------------------------------------------------------------------------
  pi.on('tool_execution_end', (event, ctx) => {
    if (!uxState.shouldSuppressTool(event.toolName)) return;

    // Revert spinner to base
    const baseSpinner = uxState.getBaseSpinner();
    ctx.ui.setWorkingMessage(baseSpinner);

    // Record suppression for P2 debug logging
    uxState.recordSuppression();
  });

  // -------------------------------------------------------------------------
  // DAWE-005: tool_result hook — suppress JSON output for hidden tools
  // -------------------------------------------------------------------------
  pi.on('tool_result', (event) => {
    if (!uxState.shouldSuppressTool(event.toolName)) return;

    // Return empty content to suppress the tool result display in the TUI.
    // The result is still sent to the LLM — only the TUI rendering is suppressed.
    return {
      content: [{ type: 'text' as const, text: '' }],
    };
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input: AdvanceWorkflowInput = {
        action: params.action,
        workflow_name: params.workflow_name,
        instance_id: params.instance_id,
        current_node_id: params.current_node_id,
        node_payload: params.node_payload as Record<string, unknown> | undefined,
        confirm: params.confirm,
      };

      const result = await handler.handle(input);

      // DAWE-005: Cache or clear UX state based on the result
      if (result.ux_controls) {
        uxState.update(result.ux_controls);

        // Set the initial spinner text
        ctx.ui.setWorkingMessage(`${result.ux_controls.base_spinner}...`);
      } else if (result.isError !== true) {
        // No ux_controls and not an error — workflow may have completed.
        // Clear state for terminal statuses. We detect this by checking
        // if the result text contains terminal indicators.
        // A cleaner approach: the handler already cleans up activeInstances
        // on completion, so we clear UX state unconditionally when there
        // are no ux_controls on a non-error response.
        uxState.clear();
        ctx.ui.setWorkingMessage(undefined);
      }

      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { isError: result.isError, ux_controls: result.ux_controls },
      };
    },
  });
}
