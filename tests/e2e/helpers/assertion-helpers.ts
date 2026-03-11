/**
 * Custom Vitest matchers for AgentSimulatorState assertions.
 *
 * Usage:
 *   expect(state).toBeAtNode('llm_implement_code');
 *   expect(state).toBeWaitingForAgent();
 *   expect(state).toBeCompleted('success');
 *   expect(state).toHaveSystemActionResult('system_check_issue', { success: true });
 *   expect(state.parsed.requiredFields).toContainFields(['project_name', 'requires_edits']);
 */

import { expect } from 'vitest';
import type { AgentSimulatorState } from './agent-simulator.js';

// ---------------------------------------------------------------------------
// Type augmentation for Vitest
// ---------------------------------------------------------------------------

interface CustomMatchers<R = unknown> {
  /** Assert the state is at a specific node. */
  toBeAtNode(nodeId: string): R;
  /** Assert the state is waiting for agent input. */
  toBeWaitingForAgent(): R;
  /** Assert the workflow has completed with an optional terminal status. */
  toBeCompleted(terminalStatus?: string): R;
  /** Assert a system action result exists with the given outcome. */
  toHaveSystemActionResult(nodeId: string, expected: { success: boolean }): R;
  /** Assert an array contains all the specified field names. */
  toContainFields(fields: string[]): R;
}

declare module 'vitest' {
  interface Assertion<T = unknown> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

// ---------------------------------------------------------------------------
// Matcher implementations
// ---------------------------------------------------------------------------

expect.extend({
  toBeAtNode(received: AgentSimulatorState, nodeId: string) {
    const currentNode = received.currentNodeId ?? received.parsed?.currentNodeId;
    const pass = currentNode === nodeId;
    return {
      pass,
      message: () =>
        pass
          ? `Expected state NOT to be at node "${nodeId}", but it is`
          : `Expected state to be at node "${nodeId}", but it is at "${currentNode ?? 'null'}"`,
    };
  },

  toBeWaitingForAgent(received: AgentSimulatorState) {
    // Check various markers that indicate waiting for agent
    const statusText = received.status ?? received.parsed?.status ?? '';
    const rawResponse = received.rawResponse ?? '';
    const pass =
      statusText.includes('Awaiting agent input') ||
      statusText.includes('waiting_for_agent') ||
      statusText.includes('System action completed') ||
      rawResponse.includes('Required Action') ||
      rawResponse.includes('REQUIRED ACTION') ||
      (received.currentNodeId !== null && !received.parsed?.isTerminal);

    return {
      pass,
      message: () =>
        pass
          ? `Expected state NOT to be waiting for agent, but it is`
          : `Expected state to be waiting for agent, but status is "${statusText}"`,
    };
  },

  toBeCompleted(received: AgentSimulatorState, terminalStatus?: string) {
    const isTerminal = received.parsed?.isTerminal ?? false;
    const actualStatus = received.parsed?.terminalStatus;

    let pass: boolean;
    if (terminalStatus) {
      pass = isTerminal && actualStatus === terminalStatus;
    } else {
      pass = isTerminal;
    }

    return {
      pass,
      message: () => {
        if (!isTerminal) {
          return `Expected workflow to be completed${terminalStatus ? ` with status "${terminalStatus}"` : ''}, but it is not terminal`;
        }
        if (terminalStatus && actualStatus !== terminalStatus) {
          return `Expected terminal status "${terminalStatus}", got "${actualStatus}"`;
        }
        return `Expected workflow NOT to be completed, but it is (status: ${actualStatus})`;
      },
    };
  },

  toHaveSystemActionResult(received: AgentSimulatorState, nodeId: string, expected: { success: boolean }) {
    const results = received.parsed?.systemActionResults ?? [];
    const entry = results.find((r) => r.nodeId === nodeId);
    const pass = entry !== undefined && entry.success === expected.success;

    return {
      pass,
      message: () => {
        if (!entry) {
          const availableNodes = results.map((r) => r.nodeId).join(', ') || 'none';
          return `Expected system action result for "${nodeId}", but not found. Available: ${availableNodes}`;
        }
        return `Expected system action "${nodeId}" success to be ${expected.success}, got ${entry.success}`;
      },
    };
  },

  toContainFields(received: string[] | undefined, fields: string[]) {
    const actual = received ?? [];
    const missing = fields.filter((f) => !actual.includes(f));
    const pass = missing.length === 0;

    return {
      pass,
      message: () =>
        pass
          ? `Expected NOT to contain fields [${fields.join(', ')}], but all were present`
          : `Expected fields [${fields.join(', ')}] but missing: [${missing.join(', ')}]. Got: [${actual.join(', ')}]`,
    };
  },
});
