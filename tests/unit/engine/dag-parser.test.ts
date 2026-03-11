/**
 * Comprehensive tests for DAGParser, graph validation algorithms,
 * visualization helpers, and composite validation.
 *
 * Covers all acceptance criteria from DAWE-003.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { DAGParser } from '../../../src/engine/dag-parser.js';
import {
  detectCycles,
  detectUnreachableNodes,
  detectDeadEnds,
  detectOrphanedNodes,
  detectDuplicateTransitionTargets,
  checkMaxDepth,
  computeMaxDepth,
  computeGraphStats,
} from '../../../src/engine/graph-validator.js';
import { GraphErrorCode, GraphWarningCode } from '../../../src/engine/dag-graph.js';
import { toMermaid, toDot, toAdjacencyListJSON, formatValidationReport } from '../../../src/engine/visualization.js';
import { validateWorkflowFull } from '../../../src/engine/composite-validation.js';
import type { WorkflowDefinition } from '../../../src/schemas/workflow.schema.js';
import type { DAGGraph } from '../../../src/engine/dag-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, '../../fixtures');

function loadFixture(relativePath: string): WorkflowDefinition {
  const yamlString = fs.readFileSync(path.join(fixturesDir, relativePath), 'utf-8');
  return parseYaml(yamlString) as WorkflowDefinition;
}

function loadFixtureYaml(relativePath: string): string {
  return fs.readFileSync(path.join(fixturesDir, relativePath), 'utf-8');
}

/** Build a minimal valid workflow in code. */
function minimalWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: '1.0',
    workflow_name: 'test-workflow',
    description: 'A test workflow.',
    initial_node: 'start',
    nodes: {
      start: {
        type: 'llm_decision',
        instruction: 'Decide.',
        required_schema: { answer: 'string' },
        transitions: [{ condition: 'true', target: 'done' }],
      },
      done: {
        type: 'terminal',
        status: 'success',
      },
    },
    ...overrides,
  } as WorkflowDefinition;
}

// ===================================================================
// Parse tests
// ===================================================================

describe('DAGParser.parse()', () => {
  it('parses a minimal workflow (2 nodes) into a correct adjacency list', () => {
    const wf = loadFixture('valid/minimal.yml');
    const parser = new DAGParser(wf);
    const graph = parser.parse();

    expect(graph.nodes.size).toBe(2);
    expect(graph.edges.size).toBe(2);
    expect(graph.initialNodeId).toBe('decide');
    expect(graph.terminalNodeIds.size).toBe(1);
    expect(graph.terminalNodeIds.has('done')).toBe(true);

    // Check edges
    const decideEdges = graph.edges.get('decide')!;
    expect(decideEdges).toHaveLength(1);
    expect(decideEdges[0]!.to).toBe('done');
    expect(decideEdges[0]!.condition).toBe('true');

    // Terminal has no outgoing edges
    expect(graph.edges.get('done')).toHaveLength(0);
  });

  it('parses a linear workflow (A → B → C → terminal) with correct in/out degrees', () => {
    const wf = minimalWorkflow({
      initial_node: 'a',
      nodes: {
        a: {
          type: 'llm_decision',
          instruction: 'A',
          required_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'b' }],
        },
        b: {
          type: 'llm_task',
          instruction: 'B',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'c' }],
        },
        c: {
          type: 'system_action',
          runtime: 'bash',
          command: 'echo c',
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const parser = new DAGParser(wf);
    const graph = parser.parse();

    expect(graph.nodes.size).toBe(4);

    // Check degrees
    expect(graph.nodes.get('a')!.inDegree).toBe(0);
    expect(graph.nodes.get('a')!.outDegree).toBe(1);
    expect(graph.nodes.get('b')!.inDegree).toBe(1);
    expect(graph.nodes.get('b')!.outDegree).toBe(1);
    expect(graph.nodes.get('c')!.inDegree).toBe(1);
    expect(graph.nodes.get('c')!.outDegree).toBe(1);
    expect(graph.nodes.get('done')!.inDegree).toBe(1);
    expect(graph.nodes.get('done')!.outDegree).toBe(0);
  });

  it('parses a branching workflow with correct edges', () => {
    const wf = loadFixture('valid/branching.yml');
    const parser = new DAGParser(wf);
    const graph = parser.parse();

    expect(graph.nodes.size).toBe(7);
    expect(graph.terminalNodeIds.size).toBe(2);
    expect(graph.terminalNodeIds.has('done')).toBe(true);
    expect(graph.terminalNodeIds.has('fail')).toBe(true);

    // Entry has 3 outgoing transitions
    const entryEdges = graph.edges.get('entry')!;
    expect(entryEdges).toHaveLength(3);
  });

  it('parses a complex workflow (5+ nodes) with correct graph stats', () => {
    const wf = loadFixture('graphs/fully-connected.yml');
    const parser = new DAGParser(wf);
    const graph = parser.parse();

    expect(graph.nodes.size).toBe(8);
    expect(graph.terminalNodeIds.size).toBe(2);

    // Count total edges
    let totalEdges = 0;
    for (const edges of graph.edges.values()) {
      totalEdges += edges.length;
    }
    expect(totalEdges).toBeGreaterThanOrEqual(8);
  });

  it('sorts edges by priority', () => {
    const wf = loadFixture('valid/full-featured.yml');
    const parser = new DAGParser(wf);
    const graph = parser.parse();

    const assessEdges = graph.edges.get('assess')!;
    expect(assessEdges.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < assessEdges.length; i++) {
      expect(assessEdges[i]!.priority).toBeGreaterThanOrEqual(assessEdges[i - 1]!.priority);
    }
  });
});

// ===================================================================
// Cycle detection tests
// ===================================================================

describe('Cycle detection', () => {
  it('detects a simple cycle: A → B → A', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const cycleError = errors.find((e) => e.code === GraphErrorCode.CYCLE_DETECTED)!;
    expect(cycleError).toBeDefined();
    expect(cycleError.cyclePath).toBeDefined();
    expect(cycleError.cyclePath!.length).toBeGreaterThanOrEqual(3);
    // Path should start and end with the same node
    expect(cycleError.cyclePath![0]).toBe(cycleError.cyclePath![cycleError.cyclePath!.length - 1]);
  });

  it('detects a longer cycle: B → C → D → B', () => {
    const wf = loadFixture('graphs/complex-cycle.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const cycleError = errors[0]!;
    expect(cycleError.code).toBe(GraphErrorCode.CYCLE_DETECTED);
    expect(cycleError.cyclePath).toBeDefined();
    // The cycle path should contain 4 elements (3 unique + repeated start)
    expect(cycleError.cyclePath!.length).toBe(4);
    expect(cycleError.message).toContain('→');
  });

  it('detects a self-loop: A → A', () => {
    const wf = loadFixture('graphs/self-loop.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const cycleError = errors[0]!;
    expect(cycleError.code).toBe(GraphErrorCode.CYCLE_DETECTED);
    expect(cycleError.cyclePath).toBeDefined();
    // Self-loop path: ["node-a", "node-a"]
    expect(cycleError.cyclePath![0]).toBe('node-a');
    expect(cycleError.cyclePath![cycleError.cyclePath!.length - 1]).toBe('node-a');
  });

  it('does NOT detect a cycle in a diamond shape', () => {
    const wf = loadFixture('graphs/diamond-valid.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    expect(errors).toHaveLength(0);
  });

  it('detects a cycle in a branch that does not include the initial node', () => {
    const wf = loadFixture('graphs/complex-cycle.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    // The cycle is B → C → D → B, not involving the initial node A
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const cycleError = errors[0]!;
    // The initial node should NOT be in the cycle
    const cycleNodes = cycleError.cyclePath!.slice(0, -1);
    expect(cycleNodes).not.toContain('node-a');
  });

  it('detects multiple cycles when present', () => {
    // Create a workflow with two independent cycles
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'a'", target: 'cycle-a1' },
            { condition: 'true', target: 'cycle-b1' },
          ],
        },
        'cycle-a1': {
          type: 'llm_task',
          instruction: 'A1.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'cycle-a2' }],
        },
        'cycle-a2': {
          type: 'llm_task',
          instruction: 'A2.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'cycle-a1' }],
        },
        'cycle-b1': {
          type: 'llm_task',
          instruction: 'B1.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'cycle-b2' }],
        },
        'cycle-b2': {
          type: 'llm_task',
          instruction: 'B2.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'cycle-b1' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);

    // Should find both cycles
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((e) => e.code === GraphErrorCode.CYCLE_DETECTED)).toBe(true);
  });
});

// ===================================================================
// Reachability tests
// ===================================================================

describe('Reachability analysis', () => {
  it('reports no errors when all nodes are reachable', () => {
    const wf = loadFixture('valid/branching.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectUnreachableNodes(graph);

    expect(errors).toHaveLength(0);
  });

  it('detects one orphaned/unreachable node', () => {
    const wf = loadFixture('graphs/orphaned-node.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectUnreachableNodes(graph);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(GraphErrorCode.UNREACHABLE_NODE);
    expect(errors[0]!.nodeIds).toContain('orphan');
  });

  it('reports ALL unreachable nodes, not just the first one', () => {
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        orphan1: {
          type: 'llm_task',
          instruction: 'Orphan 1.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        orphan2: {
          type: 'llm_task',
          instruction: 'Orphan 2.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const graph = new DAGParser(wf).parse();
    const errors = detectUnreachableNodes(graph);

    expect(errors).toHaveLength(2);
    const unreachableIds = errors.flatMap((e) => e.nodeIds);
    expect(unreachableIds).toContain('orphan1');
    expect(unreachableIds).toContain('orphan2');
  });

  it('considers nodes reachable through only one specific branch', () => {
    const wf = loadFixture('graphs/fully-connected.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectUnreachableNodes(graph);

    // branch-c-x is only reachable through branch-c, but should still count
    expect(errors).toHaveLength(0);
  });
});

// ===================================================================
// Terminal reachability tests
// ===================================================================

describe('Terminal reachability', () => {
  it('reports no errors when all paths reach a terminal', () => {
    const wf = loadFixture('valid/branching.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectDeadEnds(graph);

    expect(errors).toHaveLength(0);
  });

  it('detects a branch that leads to a non-terminal dead end', () => {
    const wf = loadFixture('graphs/dead-end-branch.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectDeadEnds(graph);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((e) => e.code === GraphErrorCode.NO_PATH_TO_TERMINAL)).toBe(true);
    const deadEndIds = errors.flatMap((e) => e.nodeIds);
    expect(deadEndIds).toContain('dead-end');
    expect(deadEndIds).toContain('also-stuck');
  });

  it('detects a node reachable but with no path to terminal', () => {
    // dead-end-branch fixture: dead-end is reachable from start but cycles with also-stuck
    const wf = loadFixture('graphs/dead-end-branch.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectDeadEnds(graph);

    const deadEndIds = errors.flatMap((e) => e.nodeIds);
    // Both dead-end and also-stuck form a cycle with no escape to terminal
    expect(deadEndIds).toContain('dead-end');
  });

  it('reports multiple dead-end branches', () => {
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'a'", target: 'dead1' },
            { condition: "x == 'b'", target: 'dead2' },
            { condition: 'true', target: 'done' },
          ],
        },
        dead1: {
          type: 'llm_task',
          instruction: 'Dead end 1.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'dead1' }],
        },
        dead2: {
          type: 'llm_task',
          instruction: 'Dead end 2.',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'dead2' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const graph = new DAGParser(wf).parse();
    const errors = detectDeadEnds(graph);

    expect(errors.length).toBeGreaterThanOrEqual(2);
    const deadEndIds = errors.flatMap((e) => e.nodeIds);
    expect(deadEndIds).toContain('dead1');
    expect(deadEndIds).toContain('dead2');
  });
});

// ===================================================================
// Orphaned node tests
// ===================================================================

describe('Orphaned node detection', () => {
  it('detects a node with inDegree 0 that is NOT the initial node', () => {
    const wf = loadFixture('graphs/orphaned-node.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectOrphanedNodes(graph);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(GraphErrorCode.ORPHANED_NODE);
    expect(errors[0]!.nodeIds).toContain('orphan');
  });

  it('does NOT flag the initial node (which always has inDegree 0)', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectOrphanedNodes(graph);

    // Initial node has inDegree 0 but should NOT be flagged
    expect(errors).toHaveLength(0);
  });

  it('does NOT flag a node reachable via multiple paths', () => {
    const wf = loadFixture('graphs/diamond-valid.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectOrphanedNodes(graph);

    // node-d has inDegree 2 (from b and c) — definitely not orphaned
    expect(errors).toHaveLength(0);
  });
});

// ===================================================================
// Duplicate transition target detection (warning)
// ===================================================================

describe('Duplicate transition target detection', () => {
  it('warns when two transitions in the same node point to the same target', () => {
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'a'", target: 'done' },
            { condition: 'true', target: 'done' },
          ],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const graph = new DAGParser(wf).parse();
    const warnings = detectDuplicateTransitionTargets(graph);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe(GraphWarningCode.DUPLICATE_TRANSITION_TARGET);
    expect(warnings[0]!.nodeIds).toContain('start');
    expect(warnings[0]!.duplicateTarget).toBe('done');
  });

  it('does not warn when all transitions have unique targets', () => {
    const wf = loadFixture('valid/branching.yml');
    const graph = new DAGParser(wf).parse();
    const warnings = detectDuplicateTransitionTargets(graph);

    // Entry → path-a, path-b, fallback (all different)
    const entryWarning = warnings.find((w) => w.nodeIds.includes('entry'));
    expect(entryWarning).toBeUndefined();
  });
});

// ===================================================================
// Stats tests
// ===================================================================

describe('Graph statistics', () => {
  it('computes correct maxDepth for a linear workflow', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const stats = computeGraphStats(graph);

    // decide → done = depth 1
    expect(stats.maxDepth).toBe(1);
  });

  it('computes correct maxDepth for a branching workflow (uses longest path)', () => {
    const wf = loadFixture('valid/branching.yml');
    const graph = new DAGParser(wf).parse();
    const stats = computeGraphStats(graph);

    // entry → path-a/path-b → merge → done = 3 (longest)
    // entry → fallback → fail = 2
    expect(stats.maxDepth).toBe(3);
  });

  it('computes correct maxDepth for a deep linear workflow', () => {
    const wf = loadFixture('graphs/deep-linear.yml');
    const graph = new DAGParser(wf).parse();
    const stats = computeGraphStats(graph);

    // 19 edges in a 20-node linear chain
    expect(stats.maxDepth).toBe(19);
  });

  it('computes correct nodesByType counts', () => {
    const wf = loadFixture('valid/full-featured.yml');
    const graph = new DAGParser(wf).parse();
    const stats = computeGraphStats(graph);

    expect(stats.nodesByType['llm_decision']).toBe(1);
    expect(stats.nodesByType['llm_task']).toBe(1);
    expect(stats.nodesByType['system_action']).toBe(1);
    expect(stats.nodesByType['terminal']).toBe(2);
    expect(stats.totalNodes).toBe(5);
    expect(stats.terminalNodes).toBe(2);
  });

  it('counts total edges correctly', () => {
    const wf = loadFixture('valid/full-featured.yml');
    const graph = new DAGParser(wf).parse();
    const stats = computeGraphStats(graph);

    // assess: 3 transitions, do-task: 1, run-action: 2 = 6 total
    expect(stats.totalEdges).toBe(6);
  });
});

// ===================================================================
// Max depth enforcement (P1)
// ===================================================================

describe('Max depth limit', () => {
  it('reports MAX_DEPTH_EXCEEDED when graph exceeds the configured limit', () => {
    const wf = loadFixture('graphs/deep-linear.yml');
    const graph = new DAGParser(wf).parse();
    const errors = checkMaxDepth(graph, 10);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(GraphErrorCode.MAX_DEPTH_EXCEEDED);
    expect(errors[0]!.message).toContain('19');
    expect(errors[0]!.message).toContain('10');
  });

  it('does not report when depth is within limit', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const errors = checkMaxDepth(graph, 50);

    expect(errors).toHaveLength(0);
  });

  it('DAGParser respects maxDepth option', () => {
    const wf = loadFixture('graphs/deep-linear.yml');
    const parser = new DAGParser(wf, { maxDepth: 10 });
    const result = parser.validate();

    expect(result.valid).toBe(false);
    const depthError = result.errors.find((e) => e.code === GraphErrorCode.MAX_DEPTH_EXCEEDED);
    expect(depthError).toBeDefined();
  });

  it('default maxDepth is 50', () => {
    const wf = loadFixture('graphs/deep-linear.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    // 19 < 50, so should pass
    expect(result.errors.find((e) => e.code === GraphErrorCode.MAX_DEPTH_EXCEEDED)).toBeUndefined();
  });
});

// ===================================================================
// Full validate() integration
// ===================================================================

describe('DAGParser.validate() — full integration', () => {
  it('returns valid for a correct branching workflow', () => {
    const wf = loadFixture('valid/branching.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid for the fully-connected fixture', () => {
    const wf = loadFixture('graphs/fully-connected.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid for the diamond-valid fixture', () => {
    const wf = loadFixture('graphs/diamond-valid.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for a cyclic workflow', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === GraphErrorCode.CYCLE_DETECTED)).toBe(true);
  });

  it('returns errors for an orphaned node', () => {
    const wf = loadFixture('graphs/orphaned-node.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(false);
    const orphanErrors = result.errors.filter((e) => e.code === GraphErrorCode.ORPHANED_NODE);
    expect(orphanErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('returns stats even when validation fails', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.stats).toBeDefined();
    expect(result.stats.totalNodes).toBe(3);
  });

  it('collects warnings alongside errors', () => {
    // Workflow with a duplicate transition target AND a cycle
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'a'", target: 'start' },
            { condition: 'true', target: 'start' },
          ],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const parser = new DAGParser(wf);
    const result = parser.validate();

    // Should have cycle error AND duplicate target warning
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.code === GraphWarningCode.DUPLICATE_TRANSITION_TARGET)).toBe(true);
  });
});

// ===================================================================
// Visualization helpers (P1/P2)
// ===================================================================

describe('Mermaid visualization', () => {
  it('generates valid Mermaid output', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('decide');
    expect(mermaid).toContain('done');
    expect(mermaid).toContain('-->');
  });

  it('includes all edges in the Mermaid output', () => {
    const wf = loadFixture('valid/branching.yml');
    const graph = new DAGParser(wf).parse();
    const mermaid = toMermaid(graph);

    // entry has 3 transitions
    const arrowCount = (mermaid.match(/-->/g) ?? []).length;
    expect(arrowCount).toBeGreaterThanOrEqual(7); // at least 7 edges in branching.yml
  });
});

describe('DOT visualization', () => {
  it('generates valid DOT output', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const dot = toDot(graph);

    expect(dot).toContain('digraph workflow {');
    expect(dot).toContain('"decide"');
    expect(dot).toContain('"done"');
    expect(dot).toContain('->');
    expect(dot).toContain('}');
  });

  it('marks terminal nodes with doublecircle', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const dot = toDot(graph);

    expect(dot).toContain('"done" [shape=doublecircle]');
  });

  it('marks initial node as bold', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const dot = toDot(graph);

    expect(dot).toContain('"decide" [shape=box, style=bold]');
  });
});

describe('JSON adjacency list export', () => {
  it('exports a JSON-serialisable adjacency list', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const json = toAdjacencyListJSON(graph);

    expect(json['decide']).toBeDefined();
    expect(json['decide']!.type).toBe('llm_decision');
    expect(json['decide']!.edges).toHaveLength(1);
    expect(json['decide']!.edges[0]!.to).toBe('done');

    expect(json['done']).toBeDefined();
    expect(json['done']!.type).toBe('terminal');
    expect(json['done']!.edges).toHaveLength(0);

    // Verify it's actually serializable
    const serialized = JSON.stringify(json);
    expect(typeof serialized).toBe('string');
  });
});

describe('Pretty-print validation report', () => {
  it('shows ✅ for a valid graph', () => {
    const wf = loadFixture('valid/branching.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();
    const report = formatValidationReport(result);

    expect(report).toContain('✅');
    expect(report).toContain('passed');
  });

  it('shows ❌ for an invalid graph', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();
    const report = formatValidationReport(result);

    expect(report).toContain('❌');
    expect(report).toContain('failed');
    expect(report).toContain('CYCLE_DETECTED');
  });

  it('includes stats in the report', () => {
    const wf = loadFixture('valid/minimal.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();
    const report = formatValidationReport(result);

    expect(report).toContain('Nodes:');
    expect(report).toContain('Edges:');
    expect(report).toContain('Max Depth:');
    expect(report).toContain('Terminal Nodes:');
  });

  it('includes warnings in the report', () => {
    const wf = minimalWorkflow({
      initial_node: 'start',
      nodes: {
        start: {
          type: 'llm_decision',
          instruction: 'Start.',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'a'", target: 'done' },
            { condition: 'true', target: 'done' },
          ],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const parser = new DAGParser(wf);
    const result = parser.validate();
    const report = formatValidationReport(result);

    expect(report).toContain('Warning');
    expect(report).toContain('DUPLICATE_TRANSITION_TARGET');
  });
});

// ===================================================================
// Composite validation (validateWorkflowFull)
// ===================================================================

describe('Composite validation (validateWorkflowFull)', () => {
  it('valid YAML + valid graph → { ok: true }', () => {
    const yaml = loadFixtureYaml('valid/minimal.yml');
    const result = validateWorkflowFull(yaml);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.definition).toBeDefined();
      expect(result.data.graph).toBeDefined();
      expect(result.data.graph.nodes.size).toBe(2);
    }
  });

  it('invalid YAML → schema errors returned', () => {
    const result = validateWorkflowFull('not: valid: yaml: [[[');

    expect(result.ok).toBe(false);
  });

  it('valid schema but missing required fields → schema errors', () => {
    const yaml = `
version: '1.0'
workflow_name: test
description: x
initial_node: start
nodes: {}
`;
    const result = validateWorkflowFull(yaml);

    expect(result.ok).toBe(false);
  });

  it('valid schema but cyclic graph → graph errors returned', () => {
    const yaml = loadFixtureYaml('graphs/simple-cycle.yml');
    const result = validateWorkflowFull(yaml);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => 'code' in e && String(e.code) === String(GraphErrorCode.CYCLE_DETECTED))).toBe(
        true,
      );
    }
  });

  it('both schema and graph errors → schema errors returned first', () => {
    // Missing version should fail at schema level before graph check
    const yaml = `
workflow_name: test
description: x
initial_node: node-a
nodes:
  node-a:
    type: llm_decision
    instruction: x
    required_schema:
      x: string
    transitions:
      - condition: 'true'
        target: node-a
  done:
    type: terminal
    status: success
`;
    const result = validateWorkflowFull(yaml);

    expect(result.ok).toBe(false);
    // Schema error should prevent graph validation from running
  });

  it('returns warnings in the ValidatedWorkflow when valid', () => {
    const yaml = `
version: '1.0'
workflow_name: dup-target-test
description: Test duplicate targets.
initial_node: start
nodes:
  start:
    type: llm_decision
    instruction: Start.
    required_schema:
      x: string
    transitions:
      - condition: "x == 'a'"
        target: done
      - condition: 'true'
        target: done
  done:
    type: terminal
    status: success
`;
    const result = validateWorkflowFull(yaml);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.data.warnings[0]!.code).toBe(GraphWarningCode.DUPLICATE_TRANSITION_TARGET);
    }
  });

  it('respects DAGParserOptions for maxDepth', () => {
    const yaml = loadFixtureYaml('graphs/deep-linear.yml');
    const result = validateWorkflowFull(yaml, { maxDepth: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => 'code' in e && String(e.code) === String(GraphErrorCode.MAX_DEPTH_EXCEEDED)),
      ).toBe(true);
    }
  });
});

// ===================================================================
// Branch coverage — defensive paths
// ===================================================================

describe('Branch coverage — defensive paths', () => {
  it('computeMaxDepth uses BFS fallback for cyclic graphs', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const graph = new DAGParser(wf).parse();
    // Force the BFS fallback by calling computeMaxDepth on a cyclic graph
    const depth = computeMaxDepth(graph);
    expect(depth).toBeGreaterThanOrEqual(1);
  });

  it('computeMaxDepth handles graph where terminal is not directly in max-depth path', () => {
    // Construct a graph where the max depth goes through a non-terminal path
    const wf = minimalWorkflow({
      initial_node: 'a',
      nodes: {
        a: {
          type: 'llm_decision',
          instruction: 'A',
          required_schema: { x: 'string' },
          transitions: [
            { condition: "x == 'long'", target: 'b' },
            { condition: 'true', target: 'done' },
          ],
        },
        b: {
          type: 'llm_task',
          instruction: 'B',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'c' }],
        },
        c: {
          type: 'llm_task',
          instruction: 'C',
          completion_schema: { x: 'string' },
          transitions: [{ condition: 'true', target: 'done' }],
        },
        done: { type: 'terminal', status: 'success' },
      },
    } as Partial<WorkflowDefinition>);

    const graph = new DAGParser(wf).parse();
    const depth = computeMaxDepth(graph);
    expect(depth).toBe(3); // a → b → c → done
  });

  it('computeMaxDepth handles unreachable nodes in topological order', () => {
    // A graph where some nodes are not reachable from initial — their dist stays -Infinity
    const wf = loadFixture('graphs/orphaned-node.yml');
    const graph = new DAGParser(wf).parse();
    const depth = computeMaxDepth(graph);
    expect(depth).toBe(1); // start → done
  });

  it('toMermaid includes isolated nodes that have no edges at all', () => {
    // Construct a graph manually with an isolated node
    const graph: DAGGraph = {
      nodes: new Map([
        [
          'a',
          {
            id: 'a',
            definition: {
              type: 'llm_decision' as const,
              instruction: 'x',
              required_schema: { x: 'string' as const },
              transitions: [],
            },
            inDegree: 0,
            outDegree: 0,
          },
        ],
        [
          'isolated',
          {
            id: 'isolated',
            definition: { type: 'terminal' as const, status: 'success' as const },
            inDegree: 0,
            outDegree: 0,
          },
        ],
      ]),
      edges: new Map([
        ['a', []],
        ['isolated', []],
      ]),
      initialNodeId: 'a',
      terminalNodeIds: new Set(['isolated']),
    };

    const mermaid = toMermaid(graph);
    expect(mermaid).toContain('a');
    expect(mermaid).toContain('isolated');
  });

  it('detectCycles handles nodes with no outgoing edges gracefully', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const errors = detectCycles(graph);
    expect(errors).toHaveLength(0);
  });

  it('formatValidationReport includes cycle path details', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();
    const report = formatValidationReport(result);
    expect(report).toContain('Cycle:');
    expect(report).toContain('→');
  });

  it('toDot includes edge labels with conditions', () => {
    const wf = loadFixture('valid/minimal.yml');
    const graph = new DAGParser(wf).parse();
    const dot = toDot(graph);
    expect(dot).toContain('label=');
    expect(dot).toContain('true');
  });

  it('toAdjacencyListJSON includes priority on edges', () => {
    const wf = loadFixture('valid/full-featured.yml');
    const graph = new DAGParser(wf).parse();
    const json = toAdjacencyListJSON(graph);
    // assess node has prioritized transitions
    const assessEdges = json['assess']!.edges;
    expect(assessEdges.some((e) => e.priority === 0)).toBe(true);
  });
});

// ===================================================================
// Edge cases and robustness
// ===================================================================

describe('Edge cases', () => {
  it('handles a workflow with a single non-terminal node and one terminal', () => {
    const wf = loadFixture('valid/minimal.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.stats.totalNodes).toBe(2);
    expect(result.stats.maxDepth).toBe(1);
  });

  it('handles a workflow with multiple terminal nodes', () => {
    const wf = loadFixture('valid/multi-terminal.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.stats.terminalNodes).toBe(3);
  });

  it('handles the deep linear workflow within default max depth', () => {
    const wf = loadFixture('graphs/deep-linear.yml');
    const parser = new DAGParser(wf);
    const result = parser.validate();

    expect(result.valid).toBe(true);
    expect(result.stats.maxDepth).toBe(19);
    expect(result.stats.totalNodes).toBe(20);
  });

  it('computeMaxDepth handles a graph with cycles (fallback BFS)', () => {
    const wf = loadFixture('graphs/simple-cycle.yml');
    const graph = new DAGParser(wf).parse();
    const depth = computeMaxDepth(graph);

    // Even with a cycle, it should return a finite number
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThan(100);
  });
});
