/**
 * Graph structural validation algorithms.
 *
 * Each function is a pure, composable validator that operates on a `DAGGraph`.
 * The `DAGParser` orchestrates them via `validate()`.
 *
 * Algorithms implemented:
 * - Cycle detection (DFS with back-edge tracking)
 * - Reachability from initial node (BFS)
 * - Terminal reachability via reverse BFS
 * - Orphaned node detection (inDegree == 0 && not initial)
 * - Duplicate transition target detection (warning)
 * - Max depth enforcement (configurable)
 * - Graph statistics (maxDepth via BFS/topological-sort longest path)
 */

import type { DAGGraph, GraphValidationError, GraphValidationWarning, GraphStats } from './dag-graph.js';
import { GraphErrorCode, GraphWarningCode } from './dag-graph.js';
import type { WorkflowDefinition } from '../schemas/workflow.schema.js';

// ---------------------------------------------------------------------------
// Cycle detection — DFS with back-edge tracking
// ---------------------------------------------------------------------------

/** Node visitation state for DFS. */
enum DFSState {
  UNVISITED,
  IN_PROGRESS,
  VISITED,
}

/**
 * Detect **all** cycles in the graph using DFS with back-edge detection.
 *
 * Returns one `GraphValidationError` per cycle found, each with the full
 * cycle path (e.g., `["A", "B", "C", "A"]`).
 */
export function detectCycles(graph: DAGGraph): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  const state = new Map<string, DFSState>();
  // Track the current DFS path for cycle reconstruction
  const pathStack: string[] = [];
  // Track cycles we've already reported (by sorted node set) to avoid duplicates
  const reportedCycles = new Set<string>();

  for (const nodeId of graph.nodes.keys()) {
    state.set(nodeId, DFSState.UNVISITED);
  }

  function dfs(nodeId: string): void {
    state.set(nodeId, DFSState.IN_PROGRESS);
    pathStack.push(nodeId);

    const edges = graph.edges.get(nodeId) ?? [];
    for (const edge of edges) {
      const neighborState = state.get(edge.to);
      if (neighborState === DFSState.IN_PROGRESS) {
        // Back edge found — extract cycle from the stack
        const cycleStartIdx = pathStack.indexOf(edge.to);
        if (cycleStartIdx !== -1) {
          const cyclePath = [...pathStack.slice(cycleStartIdx), edge.to];
          // Deduplicate: use sorted node set as key (without the repeated last element)
          const cycleNodes = cyclePath.slice(0, -1).sort().join(',');
          if (!reportedCycles.has(cycleNodes)) {
            reportedCycles.add(cycleNodes);
            errors.push({
              code: GraphErrorCode.CYCLE_DETECTED,
              message: `Cycle detected: ${cyclePath.join(' → ')}`,
              nodeIds: cyclePath.slice(0, -1),
              cyclePath,
            });
          }
        }
      } else if (neighborState === DFSState.UNVISITED) {
        dfs(edge.to);
      }
    }

    pathStack.pop();
    state.set(nodeId, DFSState.VISITED);
  }

  // Start DFS from every unvisited node (handles disconnected components)
  for (const nodeId of graph.nodes.keys()) {
    if (state.get(nodeId) === DFSState.UNVISITED) {
      dfs(nodeId);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Bounded cycle validation (v2.0) — back-edge targets must have max_visits
// ---------------------------------------------------------------------------

/**
 * Validate bounded cycles for v2.0 workflows.
 *
 * Uses the same DFS back-edge detection as `detectCycles`, but instead of
 * rejecting all cycles, it checks that every back-edge target has `max_visits`
 * defined. Returns `UNBOUNDED_CYCLE` errors for targets missing `max_visits`.
 */
export function validateBoundedCycles(graph: DAGGraph, workflow: WorkflowDefinition): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  const state = new Map<string, DFSState>();
  const pathStack: string[] = [];
  // Track back-edge targets we've already checked to avoid duplicate errors
  const checkedTargets = new Set<string>();

  for (const nodeId of graph.nodes.keys()) {
    state.set(nodeId, DFSState.UNVISITED);
  }

  function dfs(nodeId: string): void {
    state.set(nodeId, DFSState.IN_PROGRESS);
    pathStack.push(nodeId);

    const edges = graph.edges.get(nodeId) ?? [];
    for (const edge of edges) {
      const neighborState = state.get(edge.to);
      if (neighborState === DFSState.IN_PROGRESS) {
        // Back edge found — check that the target has max_visits
        if (!checkedTargets.has(edge.to)) {
          checkedTargets.add(edge.to);
          const targetNodeDef = workflow.nodes[edge.to];
          if (targetNodeDef && targetNodeDef.type !== 'terminal') {
            const hasMaxVisits = 'max_visits' in targetNodeDef && targetNodeDef.max_visits !== undefined;
            if (!hasMaxVisits) {
              errors.push({
                code: GraphErrorCode.UNBOUNDED_CYCLE,
                message: `Node "${edge.to}" is targeted by a back-edge but has no max_visits defined`,
                nodeIds: [edge.to],
              });
            }
          }
        }
      } else if (neighborState === DFSState.UNVISITED) {
        dfs(edge.to);
      }
    }

    pathStack.pop();
    state.set(nodeId, DFSState.VISITED);
  }

  for (const nodeId of graph.nodes.keys()) {
    if (state.get(nodeId) === DFSState.UNVISITED) {
      dfs(nodeId);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Reachability from initial node — BFS
// ---------------------------------------------------------------------------

/**
 * Find all nodes NOT reachable from the initial node.
 * Returns one error per unreachable node.
 */
export function detectUnreachableNodes(graph: DAGGraph): GraphValidationError[] {
  const visited = new Set<string>();
  const queue: string[] = [graph.initialNodeId];
  visited.add(graph.initialNodeId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges = graph.edges.get(current) ?? [];
    for (const edge of edges) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  const errors: GraphValidationError[] = [];
  for (const nodeId of graph.nodes.keys()) {
    if (!visited.has(nodeId)) {
      errors.push({
        code: GraphErrorCode.UNREACHABLE_NODE,
        message: `Node "${nodeId}" is not reachable from the initial node "${graph.initialNodeId}"`,
        nodeIds: [nodeId],
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Terminal reachability — Reverse BFS
// ---------------------------------------------------------------------------

/**
 * Build a reverse adjacency list and BFS from all terminal nodes.
 * Any non-terminal node that is NOT reached by this reverse BFS
 * has no path to any terminal — it's a dead end.
 */
export function detectDeadEnds(graph: DAGGraph): GraphValidationError[] {
  // Build reverse adjacency list
  const reverseEdges = new Map<string, string[]>();
  for (const nodeId of graph.nodes.keys()) {
    reverseEdges.set(nodeId, []);
  }
  for (const [fromId, edges] of graph.edges) {
    for (const edge of edges) {
      reverseEdges.get(edge.to)?.push(fromId);
    }
  }

  // BFS from all terminal nodes using reverse edges
  const visited = new Set<string>();
  const queue: string[] = [...graph.terminalNodeIds];
  for (const termId of graph.terminalNodeIds) {
    visited.add(termId);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const predecessors = reverseEdges.get(current) ?? [];
    for (const pred of predecessors) {
      if (!visited.has(pred)) {
        visited.add(pred);
        queue.push(pred);
      }
    }
  }

  // Any non-terminal node not visited is a dead end
  const errors: GraphValidationError[] = [];
  for (const [nodeId, node] of graph.nodes) {
    if (node.definition.type !== 'terminal' && !visited.has(nodeId)) {
      errors.push({
        code: GraphErrorCode.NO_PATH_TO_TERMINAL,
        message: `Node "${nodeId}" has no path to any terminal node`,
        nodeIds: [nodeId],
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Orphaned node detection
// ---------------------------------------------------------------------------

/**
 * Detect nodes with inDegree == 0 that are NOT the initial node.
 * These are "orphaned" — they exist but can never be entered via transitions.
 */
export function detectOrphanedNodes(graph: DAGGraph): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  for (const [nodeId, node] of graph.nodes) {
    if (nodeId !== graph.initialNodeId && node.inDegree === 0) {
      errors.push({
        code: GraphErrorCode.ORPHANED_NODE,
        message: `Node "${nodeId}" has no incoming transitions and is not the initial node (orphaned)`,
        nodeIds: [nodeId],
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Duplicate transition target detection (warning)
// ---------------------------------------------------------------------------

/**
 * Within each node, warn if two or more transitions point to the same target.
 * This is likely a copy-paste error.
 */
export function detectDuplicateTransitionTargets(graph: DAGGraph): GraphValidationWarning[] {
  const warnings: GraphValidationWarning[] = [];

  for (const [nodeId, edges] of graph.edges) {
    const targetCounts = new Map<string, number>();
    for (const edge of edges) {
      targetCounts.set(edge.to, (targetCounts.get(edge.to) ?? 0) + 1);
    }
    for (const [target, count] of targetCounts) {
      if (count > 1) {
        warnings.push({
          code: GraphWarningCode.DUPLICATE_TRANSITION_TARGET,
          message: `Node "${nodeId}" has ${count} transitions pointing to "${target}"`,
          nodeIds: [nodeId],
          duplicateTarget: target,
        });
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Max depth enforcement
// ---------------------------------------------------------------------------

/**
 * Check that the graph depth does not exceed the configured maximum.
 *
 * Uses BFS longest-path from initial node. This is safe to call even if
 * cycles exist (uses a visited set to break infinite loops), but the
 * maxDepth value is only meaningful for acyclic graphs.
 */
export function checkMaxDepth(graph: DAGGraph, maxDepth: number): GraphValidationError[] {
  const depth = computeMaxDepth(graph);
  if (depth > maxDepth) {
    return [
      {
        code: GraphErrorCode.MAX_DEPTH_EXCEEDED,
        message: `Graph depth ${depth} exceeds the configured maximum of ${maxDepth}`,
        nodeIds: [graph.initialNodeId],
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Graph statistics
// ---------------------------------------------------------------------------

/**
 * Compute the longest path (in edges) from the initial node to any
 * terminal node. Uses topological sort + dynamic programming when the
 * graph is acyclic. Falls back to BFS with distance tracking if cycles
 * are present (returns best-effort depth).
 */
export function computeMaxDepth(graph: DAGGraph): number {
  // Use BFS-based longest path computation.
  // For a DAG we can use topological order to compute longest path.
  // We use Kahn's algorithm for topological sort.

  const inDegreeMap = new Map<string, number>();
  for (const [nodeId, node] of graph.nodes) {
    inDegreeMap.set(nodeId, node.inDegree);
  }

  const topoOrder: string[] = [];
  const queue: string[] = [];

  for (const [nodeId, deg] of inDegreeMap) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    topoOrder.push(current);
    const edges = graph.edges.get(current) ?? [];
    for (const edge of edges) {
      const newDeg = (inDegreeMap.get(edge.to) ?? 1) - 1;
      inDegreeMap.set(edge.to, newDeg);
      if (newDeg === 0) {
        queue.push(edge.to);
      }
    }
  }

  // If topological sort doesn't include all nodes, the graph has cycles.
  // Fall back to BFS-based depth from initial node with visited guard.
  if (topoOrder.length !== graph.nodes.size) {
    return bfsMaxDepth(graph);
  }

  // Longest path from initial node using topological order + DP
  const dist = new Map<string, number>();
  for (const nodeId of graph.nodes.keys()) {
    dist.set(nodeId, -Infinity);
  }
  dist.set(graph.initialNodeId, 0);

  for (const nodeId of topoOrder) {
    const d = dist.get(nodeId)!;
    if (d === -Infinity) continue; // not reachable from initial
    const edges = graph.edges.get(nodeId) ?? [];
    for (const edge of edges) {
      const alt = d + 1;
      if (alt > (dist.get(edge.to) ?? -Infinity)) {
        dist.set(edge.to, alt);
      }
    }
  }

  // Max depth to any terminal node
  let maxD = 0;
  for (const termId of graph.terminalNodeIds) {
    const d = dist.get(termId) ?? 0;
    if (d > maxD) maxD = d;
  }

  // Also consider max depth to ANY node (in case no terminal is reachable)
  for (const d of dist.values()) {
    if (d !== -Infinity && d > maxD) maxD = d;
  }

  return maxD;
}

/**
 * Fallback BFS-based max-depth for graphs that may contain cycles.
 * Uses a visited set to prevent infinite loops.
 */
function bfsMaxDepth(graph: DAGGraph): number {
  const dist = new Map<string, number>();
  const queue: string[] = [graph.initialNodeId];
  dist.set(graph.initialNodeId, 0);

  let maxD = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const d = dist.get(current)!;
    const edges = graph.edges.get(current) ?? [];
    for (const edge of edges) {
      if (!dist.has(edge.to)) {
        const newD = d + 1;
        dist.set(edge.to, newD);
        if (newD > maxD) maxD = newD;
        queue.push(edge.to);
      }
    }
  }

  return maxD;
}

/**
 * Compute aggregate graph statistics.
 */
export function computeGraphStats(graph: DAGGraph): GraphStats {
  let totalEdges = 0;
  for (const edges of graph.edges.values()) {
    totalEdges += edges.length;
  }

  const nodesByType: Record<string, number> = {};
  for (const node of graph.nodes.values()) {
    const t = node.definition.type;
    nodesByType[t] = (nodesByType[t] ?? 0) + 1;
  }

  return {
    totalNodes: graph.nodes.size,
    totalEdges,
    maxDepth: computeMaxDepth(graph),
    terminalNodes: graph.terminalNodeIds.size,
    nodesByType,
  };
}
