/**
 * DAG Parser — builds and validates the graph representation of a workflow.
 *
 * The `DAGParser` is **stateless after construction**: `parse()` and
 * `validate()` are pure functions over the input `WorkflowDefinition`.
 *
 * Usage:
 * ```ts
 * const parser = new DAGParser(workflowDef);
 * const graph = parser.parse();
 * const result = parser.validate();
 * ```
 */

import type { WorkflowDefinition } from '../schemas/workflow.schema.js';
import type {
  DAGGraph,
  GraphNode,
  GraphEdge,
  GraphValidationResult,
  GraphValidationError,
  GraphValidationWarning,
} from './dag-graph.js';
import {
  detectCycles,
  validateBoundedCycles,
  detectUnreachableNodes,
  detectDeadEnds,
  detectOrphanedNodes,
  detectDuplicateTransitionTargets,
  checkMaxDepth,
  computeGraphStats,
} from './graph-validator.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DAGParserOptions {
  /** Maximum allowed graph depth (default 50). */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 50;

// ---------------------------------------------------------------------------
// DAGParser
// ---------------------------------------------------------------------------

export class DAGParser {
  private readonly workflow: WorkflowDefinition;
  private readonly maxDepth: number;

  constructor(workflow: WorkflowDefinition, options?: DAGParserOptions) {
    this.workflow = workflow;
    this.maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Build the internal adjacency-list representation from the workflow.
   */
  parse(): DAGGraph {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge[]>();
    const terminalNodeIds = new Set<string>();

    // Initialise nodes with zero degree
    for (const [id, def] of Object.entries(this.workflow.nodes)) {
      nodes.set(id, {
        id,
        definition: def,
        inDegree: 0,
        outDegree: 0,
      });
      edges.set(id, []);

      if (def.type === 'terminal') {
        terminalNodeIds.add(id);
      }
    }

    // Build edges from transitions
    for (const [id, def] of Object.entries(this.workflow.nodes)) {
      if (def.type === 'terminal') continue; // terminal nodes have no transitions

      for (const transition of def.transitions) {
        const edge: GraphEdge = {
          from: id,
          to: transition.target,
          condition: transition.condition,
          priority: transition.priority ?? 0,
        };
        edges.get(id)!.push(edge);

        // Update degrees
        const fromNode = nodes.get(id);
        if (fromNode) fromNode.outDegree++;

        const toNode = nodes.get(transition.target);
        if (toNode) toNode.inDegree++;
      }

      // Sort edges by priority for deterministic evaluation order
      edges.get(id)!.sort((a, b) => a.priority - b.priority);
    }

    return {
      nodes,
      edges,
      initialNodeId: this.workflow.initial_node,
      terminalNodeIds,
    };
  }

  /**
   * Run all structural validations. Returns all errors & warnings found.
   *
   * Version-aware cycle handling:
   * - v1.0: `detectCycles()` rejects all cycles.
   * - v2.0: `validateBoundedCycles()` — cycles with `max_visits` are allowed,
   *   unbounded cycles are rejected.
   */
  validate(): GraphValidationResult {
    const graph = this.parse();
    const version = this.workflow.version;

    // Version-aware cycle validation
    const cycleErrors: GraphValidationError[] =
      version === '2.0' ? validateBoundedCycles(graph, this.workflow) : detectCycles(graph);

    const errors: GraphValidationError[] = [
      ...cycleErrors,
      ...detectUnreachableNodes(graph),
      ...detectDeadEnds(graph),
      ...detectOrphanedNodes(graph),
      ...checkMaxDepth(graph, this.maxDepth),
    ];

    const warnings: GraphValidationWarning[] = [...detectDuplicateTransitionTargets(graph)];

    const stats = computeGraphStats(graph);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      stats,
    };
  }
}
