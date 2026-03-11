/**
 * DAG graph types for structural representation of a workflow.
 *
 * A `DAGGraph` is the adjacency-list representation built from a
 * `WorkflowDefinition`. It is consumed by the graph validator and
 * (later) by the runtime engine.
 */

import type { NodeDefinition } from '../schemas/workflow.schema.js';

// ---------------------------------------------------------------------------
// Core graph types
// ---------------------------------------------------------------------------

/** A node in the DAG with degree information. */
export interface GraphNode {
  /** Node identifier (key in the workflow `nodes` map). */
  id: string;
  /** Original node definition from the workflow schema. */
  definition: NodeDefinition;
  /** Number of edges pointing TO this node. */
  inDegree: number;
  /** Number of edges pointing FROM this node. */
  outDegree: number;
}

/** A directed edge between two nodes. */
export interface GraphEdge {
  /** Source node identifier. */
  from: string;
  /** Target node identifier. */
  to: string;
  /** Condition expression that triggers this edge. */
  condition: string;
  /** Evaluation priority (lower = earlier). */
  priority: number;
}

/** The full adjacency-list representation of a workflow DAG. */
export interface DAGGraph {
  /** All nodes keyed by their identifier. */
  nodes: Map<string, GraphNode>;
  /** Outgoing edges keyed by source node identifier. */
  edges: Map<string, GraphEdge[]>;
  /** The node where execution begins. */
  initialNodeId: string;
  /** Set of node identifiers that are terminal (end) states. */
  terminalNodeIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

/** Graph-level error codes produced by structural validation. */
export enum GraphErrorCode {
  /** The graph contains a cycle. */
  CYCLE_DETECTED = 'CYCLE_DETECTED',
  /** A node is not reachable from the initial node. */
  UNREACHABLE_NODE = 'UNREACHABLE_NODE',
  /** A non-terminal node has no path to any terminal node. */
  NO_PATH_TO_TERMINAL = 'NO_PATH_TO_TERMINAL',
  /** A node (other than initial) has inDegree 0. */
  ORPHANED_NODE = 'ORPHANED_NODE',
  /** The graph exceeds the configured maximum depth. */
  MAX_DEPTH_EXCEEDED = 'MAX_DEPTH_EXCEEDED',
  /** A back-edge target in a v2.0 workflow has no max_visits defined. */
  UNBOUNDED_CYCLE = 'UNBOUNDED_CYCLE',
}

/** Graph-level warning codes. */
export enum GraphWarningCode {
  /** Two transitions in the same node point to the same target. */
  DUPLICATE_TRANSITION_TARGET = 'DUPLICATE_TRANSITION_TARGET',
}

/** A structural validation error. */
export interface GraphValidationError {
  /** Machine-readable error code. */
  code: GraphErrorCode;
  /** Human-readable description. */
  message: string;
  /** Node ID(s) related to this error. */
  nodeIds: string[];
  /** For cycles: the full cycle path (e.g., ["A", "B", "C", "A"]). */
  cyclePath?: string[];
}

/** A structural validation warning. */
export interface GraphValidationWarning {
  /** Machine-readable warning code. */
  code: GraphWarningCode;
  /** Human-readable description. */
  message: string;
  /** Node ID(s) related to this warning. */
  nodeIds: string[];
  /** The duplicate target node. */
  duplicateTarget?: string;
}

/** Aggregate statistics about the graph. */
export interface GraphStats {
  /** Total number of nodes. */
  totalNodes: number;
  /** Total number of edges. */
  totalEdges: number;
  /** Longest path from initial to any terminal (in number of edges). */
  maxDepth: number;
  /** Number of terminal nodes. */
  terminalNodes: number;
  /** Count of nodes grouped by their `type` field. */
  nodesByType: Record<string, number>;
}

/** Full result of graph structural validation. */
export interface GraphValidationResult {
  /** `true` if no errors were found (warnings are OK). */
  valid: boolean;
  /** All structural errors found. */
  errors: GraphValidationError[];
  /** All structural warnings found. */
  warnings: GraphValidationWarning[];
  /** Aggregate graph statistics. */
  stats: GraphStats;
}
