/**
 * Unit tests for response-formatter — AdvanceResult → markdown conversion.
 *
 * Minimum 10 test cases.
 */

import { describe, it, expect } from 'vitest';

import {
  formatListResponse,
  formatAdvanceResponse,
  formatCompletedResponse,
  formatStatusResponse,
  formatCancelResponse,
  formatErrorResponse,
  formatActiveInstanceWarning,
} from '../../../src/extension/response-formatter.js';

import type { AdvanceResult, WorkflowInstance } from '../../../src/engine/advance-result.js';
import type { RuntimeError } from '../../../src/engine/runtime-errors.js';
import { RuntimeErrorCode } from '../../../src/engine/runtime-errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdvanceResult(overrides: Partial<AdvanceResult> = {}): AdvanceResult {
  return {
    instanceId: 'test-instance-123',
    status: 'waiting_for_agent',
    currentNodeId: 'test_node',
    currentNodeType: 'llm_task',
    instruction: 'Do the thing.',
    completionSchema: { result: 'string' },
    agentMessage: '',
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instanceId: 'test-instance-123',
    workflowId: 'wf-id',
    workflowName: 'test-workflow',
    status: 'active',
    currentNodeId: 'node-a',
    currentNodeType: 'llm_task',
    payload: {},
    history: [
      { nodeId: 'node-a', nodeType: 'llm_task', enteredAt: 1000, payloadSnapshot: {} },
    ],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('response-formatter', () => {
  // 1. Format llm_decision response → includes instruction, schema, advance hint
  it('should format llm_decision response with instruction and schema', () => {
    const result = makeAdvanceResult({
      currentNodeType: 'llm_decision',
      currentNodeId: 'assess_intent',
      instruction: 'Determine the intent of the user request.',
      requiredSchema: { intent: 'string', confidence: 'number' },
    });

    const output = formatAdvanceResponse(result, 'test-workflow');

    expect(output).toContain('**WORKFLOW:** test-workflow');
    expect(output).toContain('Current Node: `assess_intent`');
    expect(output).toContain('llm_decision');
    expect(output).toContain('Determine the intent');
    expect(output).toContain('advance_workflow');
    expect(output).toContain('advance');
  });

  // 2. Format llm_task response → includes instruction, context, advance hint
  it('should format llm_task response with context payload', () => {
    const result = makeAdvanceResult({
      currentNodeType: 'llm_task',
      currentNodeId: 'implement_code',
      instruction: 'Implement the fix.',
      completionSchema: { status: 'string' },
      contextPayload: { project_name: 'pi-daemon', issue_number: 42 },
    });

    const output = formatAdvanceResponse(result, 'dev-workflow');

    expect(output).toContain('Implement the fix');
    expect(output).toContain('### Context');
    expect(output).toContain('project_name');
    expect(output).toContain('"pi-daemon"');
    expect(output).toContain('### Required Action');
  });

  // 3. Format terminal success → includes summary and history
  it('should format completed workflow with history', () => {
    const result = makeAdvanceResult({
      status: 'completed',
      terminalStatus: 'success',
      terminalMessage: 'All tasks done.',
    });

    const instance = makeInstance({
      status: 'completed',
      history: [
        { nodeId: 'ask', nodeType: 'llm_decision', enteredAt: 1000, completedAt: 2000, payloadSnapshot: {} },
        { nodeId: 'do-task', nodeType: 'llm_task', enteredAt: 2000, completedAt: 3000, payloadSnapshot: {} },
        { nodeId: 'done', nodeType: 'terminal', enteredAt: 3000, completedAt: 3000, payloadSnapshot: {} },
      ],
    });

    const output = formatCompletedResponse(result, 'my-workflow', instance);

    expect(output).toContain('Workflow completed successfully');
    expect(output).toContain('All tasks done.');
    expect(output).toContain('### Workflow History');
    expect(output).toContain('✅ ask');
    expect(output).toContain('✅ do-task');
    expect(output).toContain('✅ done');
  });

  // 4. Format terminal failure → includes failure info
  it('should format failed terminal with status', () => {
    const result = makeAdvanceResult({
      status: 'completed',
      terminalStatus: 'failure',
      terminalMessage: 'Pipeline failed at step 3.',
    });

    const instance = makeInstance({
      status: 'completed',
      terminalStatus: 'failure',
    });

    const output = formatCompletedResponse(result, 'ci-workflow', instance);

    expect(output).toContain('Pipeline failed at step 3.');
  });

  // 5. Format with system action results → results listed with status icons
  it('should include system action results with icons', () => {
    const result = makeAdvanceResult({
      systemActionResults: [
        {
          nodeId: 'check-status',
          actionResult: {
            exit_code: 0,
            stdout: 'ok',
            stderr: '',
            timed_out: false,
          },
        },
        {
          nodeId: 'deploy',
          actionResult: {
            exit_code: 1,
            stdout: '',
            stderr: 'failed',
            timed_out: false,
          },
        },
      ],
    });

    const output = formatAdvanceResponse(result, 'test-workflow');

    expect(output).toContain('### System Actions Executed');
    expect(output).toContain('✅ `check-status`');
    expect(output).toContain('❌ `deploy`');
    expect(output).toContain('exit code 0');
    expect(output).toContain('exit code 1');
  });

  // 6. Format error: payload validation → includes field details
  it('should format payload validation error', () => {
    const error: RuntimeError = {
      code: RuntimeErrorCode.PAYLOAD_VALIDATION_FAILED,
      message: 'Payload validation failed against required_schema: Missing keys: intent, confidence',
      nodeId: 'assess_intent',
      instanceId: 'inst-1',
    };

    const output = formatErrorResponse(error);

    expect(output).toContain('PAYLOAD_VALIDATION_FAILED');
    expect(output).toContain('Missing keys: intent, confidence');
    expect(output).toContain('assess_intent');
  });

  // 7. Format error: node mismatch → includes expected vs actual
  it('should format node mismatch error', () => {
    const error: RuntimeError = {
      code: RuntimeErrorCode.NODE_MISMATCH,
      message: 'Expected node "ask", but received "do-task"',
      nodeId: 'do-task',
      instanceId: 'inst-2',
    };

    const output = formatErrorResponse(error);

    expect(output).toContain('NODE_MISMATCH');
    expect(output).toContain('Expected node "ask"');
    expect(output).toContain('inst-2');
  });

  // 8. Format list response → markdown table
  it('should format list as markdown table', () => {
    const output = formatListResponse([
      { name: 'issue-first-development', description: 'Enforces GitHub issue creation' },
      { name: 'pr-creation', description: 'Creates a PR with proper template' },
    ]);

    expect(output).toContain('## Available Workflows');
    expect(output).toContain('| 1 | issue-first-development |');
    expect(output).toContain('| 2 | pr-creation |');
    expect(output).toContain('advance_workflow');
  });

  // 9. Format status response → current state summary
  it('should format instance status', () => {
    const instance = makeInstance({
      status: 'waiting_for_agent',
      currentNodeId: 'implement',
      currentNodeType: 'llm_task',
      payload: { project: 'test', issue: 42 },
      history: [
        { nodeId: 'ask', nodeType: 'llm_decision', enteredAt: 1000, completedAt: 2000, payloadSnapshot: {} },
        { nodeId: 'implement', nodeType: 'llm_task', enteredAt: 2000, payloadSnapshot: {} },
      ],
    });

    const output = formatStatusResponse(instance);

    expect(output).toContain('Instance Status');
    expect(output).toContain('implement');
    expect(output).toContain('waiting_for_agent');
    expect(output).toContain('✅ ask');
    expect(output).toContain('⏳ implement');
    expect(output).toContain('Payload Summary');
    expect(output).toContain('project, issue');
  });

  // 10. Long instruction text → not truncated
  it('should not truncate long instruction text', () => {
    const longInstruction = 'A'.repeat(5000);
    const result = makeAdvanceResult({ instruction: longInstruction });

    const output = formatAdvanceResponse(result, 'test-workflow');

    expect(output).toContain(longInstruction);
  });

  // 11. Format cancel response
  it('should format cancel confirmation', () => {
    const output = formatCancelResponse('inst-123', 'my-workflow');

    expect(output).toContain('cancelled');
    expect(output).toContain('inst-123');
    expect(output).toContain('my-workflow');
  });

  // 12. Format active instance warning
  it('should format active instance warning', () => {
    const output = formatActiveInstanceWarning('inst-456', 'implement_code');

    expect(output).toContain('WARNING');
    expect(output).toContain('inst-456');
    expect(output).toContain('implement_code');
    expect(output).toContain('confirm');
  });

  // 13. Format system action with timeout
  it('should show timed out status for system actions', () => {
    const result = makeAdvanceResult({
      systemActionResults: [
        {
          nodeId: 'slow-action',
          actionResult: {
            exit_code: 1,
            stdout: '',
            stderr: '',
            timed_out: true,
          },
        },
      ],
    });

    const output = formatAdvanceResponse(result, 'test-workflow');

    expect(output).toContain('timed out');
  });

  // 14. Format empty list response
  it('should handle empty workflow list', () => {
    const output = formatListResponse([]);

    expect(output).toContain('No workflows are currently available');
  });
});
