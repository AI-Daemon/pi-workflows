/**
 * UX State Manager — Encapsulates UX state caching logic for the Pi extension.
 *
 * Maintains `base_spinner`, `hide_tools`, and `show_output` across agent turns.
 * Used by the extension's `tool_call` / `tool_execution_start` / `tool_execution_end`
 * hooks to suppress native tool output and drive dynamic spinner concatenation.
 *
 * Part of the Zero-Config Dynamic UX architecture (DAWE-005).
 *
 * @module
 */

import { LexicalFormatter } from '../engine/utils/LexicalFormatter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cached UX state extracted from `ux_controls` in the advance_workflow
 * tool result's `details` field.
 */
export interface ActiveUxState {
  /** Resolved spinner text for the current workflow node. */
  base_spinner: string;
  /** When true, suppress native Pi tool JSON output in the TUI. */
  hide_tools: boolean;
  /** When true, override hide_tools — show output for debugging. */
  show_output: boolean;
}

/** The name of the advance_workflow tool — never suppressed. */
const ADVANCE_WORKFLOW_TOOL = 'advance_workflow';

// ---------------------------------------------------------------------------
// UxStateManager
// ---------------------------------------------------------------------------

/**
 * Manages UX state across agent turns for the DAWE Pi extension.
 *
 * Lifecycle:
 * 1. `update()` — Called after `advance_workflow` returns with `ux_controls`.
 * 2. `shouldSuppressTool()` — Queried on every native tool call to decide suppression.
 * 3. `getSpinnerWithTool()` — Queried on every native tool call for spinner text.
 * 4. `clear()` — Called when the workflow completes, fails, or the session ends.
 *
 * @example
 * ```ts
 * const uxState = new UxStateManager();
 * uxState.update({ base_spinner: 'Gathering requirements', hide_tools: true, show_output: false });
 *
 * uxState.shouldSuppressTool('read');      // true
 * uxState.shouldSuppressTool('advance_workflow'); // false (self-exclusion)
 *
 * uxState.getSpinnerWithTool('read_file'); // "Gathering requirements... Reading file..."
 * ```
 */
export class UxStateManager {
  /** Current UX state, or null when no workflow is active. */
  private state: ActiveUxState | null = null;

  /** Count of tool calls suppressed in the current node (P2 debug). */
  private suppressedCount = 0;

  /**
   * Cache UX controls from an advance_workflow result.
   *
   * Overwrites any previously cached state. Called each time
   * advance_workflow returns a `waiting_for_agent` result with `ux_controls`.
   *
   * @param uxControls - The UX controls from the advance result's details.
   */
  update(uxControls: ActiveUxState): void {
    this.state = { ...uxControls };
    this.suppressedCount = 0;
  }

  /**
   * Clear cached UX state.
   *
   * Called when:
   * - The workflow reaches a terminal status (completed, failed, cancelled, suspended).
   * - The session ends (`session_shutdown` event).
   */
  clear(): void {
    this.state = null;
    this.suppressedCount = 0;
  }

  /**
   * Get the current cached UX state, or null if no workflow is active.
   */
  get(): ActiveUxState | null {
    return this.state ? { ...this.state } : null;
  }

  /**
   * Determine whether a native tool's output should be suppressed.
   *
   * Returns `true` when ALL of:
   * 1. UX state is active (a workflow node is in progress).
   * 2. `hide_tools` is `true`.
   * 3. `show_output` is `false` (debugging escape hatch).
   * 4. The tool is NOT `advance_workflow` itself (self-exclusion).
   *
   * @param toolName - The name of the tool being called.
   * @returns Whether to suppress the tool's JSON output in the TUI.
   */
  shouldSuppressTool(toolName: string): boolean {
    if (this.state === null) return false;
    if (toolName === ADVANCE_WORKFLOW_TOOL) return false;
    if (this.state.show_output) return false;
    return this.state.hide_tools;
  }

  /**
   * Build the concatenated spinner text for a tool call.
   *
   * Combines the cached `base_spinner` with the tool's lexically-formatted
   * action phrase.
   *
   * @param toolName - The tool name (e.g. `"read_file"`, `"bash"`).
   * @returns The concatenated spinner string, e.g.
   *          `"Gathering requirements... Reading file..."`.
   *          Returns the `base_spinner` alone if no state is cached.
   */
  getSpinnerWithTool(toolName: string): string {
    if (this.state === null) return '';
    const actionPhrase = LexicalFormatter.toActionPhrase(toolName);
    if (!actionPhrase) return `${this.state.base_spinner}...`;
    return `${this.state.base_spinner}... ${actionPhrase}...`;
  }

  /**
   * Get the base spinner text (without any tool concatenation).
   *
   * @returns The base spinner string with trailing `...`, or empty string if no state.
   */
  getBaseSpinner(): string {
    if (this.state === null) return '';
    return `${this.state.base_spinner}...`;
  }

  /**
   * Increment the suppressed tool call counter (P2 debug logging).
   */
  recordSuppression(): void {
    this.suppressedCount++;
  }

  /**
   * Get the count of suppressed tool calls for the current node.
   */
  getSuppressedCount(): number {
    return this.suppressedCount;
  }
}
