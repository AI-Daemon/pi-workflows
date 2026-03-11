/**
 * Tests for DAWE-018: DAGParser structured logging integration.
 *
 * Verifies that the parser emits structured log entries for validation
 * start, results, and uses ErrorCollector for multi-error reporting.
 */

import { describe, it, expect } from 'vitest';
import { DAGParser } from '../../../src/engine/dag-parser.js';
import { DAWELogger } from '../../../src/utils/logger.js';
import type { WorkflowDefinition } from '../../../src/schemas/workflow.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  message: string;
  [key: string]: unknown;
}

function createLoggingParser(workflow: WorkflowDefinition): { parser: DAGParser; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const logger = new DAWELogger({
    level: 'debug',
    format: 'json',
    output: (line: string) => {
      try {
        logs.push(JSON.parse(line) as LogEntry);
      } catch {
        // ignore
      }
    },
  });
  const parser = new DAGParser(workflow, { logger });
  return { parser, logs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DAGParser — Structured Logging (DAWE-018)', () => {
  it('logs validation start and results', () => {
    const workflow: WorkflowDefinition = {
      version: '1.0',
      workflow_name: 'test-logging',
      description: 'Test',
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_task',
          instruction: 'Do something',
          completion_schema: { result: 'string' },
          transitions: [{ condition: 'default', target: 'done' }],
        },
        done: {
          type: 'terminal',
          status: 'success',
          message: 'Done',
        },
      },
    };

    const { parser, logs } = createLoggingParser(workflow);
    const result = parser.validate();

    expect(result.valid).toBe(true);

    const startLog = logs.find((l) => l.message === 'Graph validation started');
    expect(startLog).toBeDefined();
    expect(startLog!.level).toBe('info');
    expect(startLog!['workflowName']).toBe('test-logging');
    expect(startLog!['nodeCount']).toBe(2);

    const completeLog = logs.find((l) => l.message === 'Graph validation complete');
    expect(completeLog).toBeDefined();
    expect(completeLog!.level).toBe('info');
    expect(completeLog!['valid']).toBe(true);
    expect(completeLog!['errorCount']).toBe(0);
  });

  it('uses ErrorCollector for multi-error reporting via validateWithCollector', () => {
    // Create a workflow with multiple graph errors (orphaned nodes, dead ends)
    const workflow: WorkflowDefinition = {
      version: '1.0',
      workflow_name: 'bad-graph',
      description: 'Test',
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_task',
          instruction: 'Do something',
          completion_schema: { result: 'string' },
          transitions: [{ condition: 'default', target: 'done' }],
        },
        orphan: {
          type: 'llm_task',
          instruction: 'Orphaned',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'default', target: 'done' }],
        },
        done: {
          type: 'terminal',
          status: 'success',
          message: 'Done',
        },
      },
    };

    const { parser, logs } = createLoggingParser(workflow);
    const { result, collector } = parser.validateWithCollector();

    expect(result.valid).toBe(false);
    expect(collector.hasErrors()).toBe(true);
    expect(collector.getErrors().length).toBeGreaterThan(0);

    // Should have a warning log about validation errors
    const warnLog = logs.find((l) => l.message === 'Graph validation found errors');
    expect(warnLog).toBeDefined();
    expect(warnLog!.level).toBe('warn');
  });
});
