/**
 * Visualization helpers for DAG graphs.
 *
 * - `toMermaid(graph)` — Mermaid diagram string
 * - `toDot(graph)` — Graphviz DOT format
 * - `toAdjacencyListJSON(graph)` — JSON export of the adjacency list
 * - `formatValidationReport(result)` — Pretty-printed CLI report
 */

import type { DAGGraph, GraphValidationResult } from './dag-graph.js';

// ---------------------------------------------------------------------------
// P1 — Mermaid diagram
// ---------------------------------------------------------------------------

/**
 * Generate a Mermaid diagram string for the given graph.
 *
 * ```
 * graph TD
 *   assess_intent --> system_check_issue
 *   assess_intent --> exit_informational
 * ```
 */
export function toMermaid(graph: DAGGraph): string {
  const lines: string[] = ['graph TD'];

  for (const [fromId, edges] of graph.edges) {
    for (const edge of edges) {
      // Escape special Mermaid characters in node IDs
      const from = escapeMermaidId(fromId);
      const to = escapeMermaidId(edge.to);
      lines.push(`  ${from} --> ${to}`);
    }
  }

  // Include isolated nodes (terminals with no outgoing edges that might
  // not appear in any edge)
  for (const nodeId of graph.nodes.keys()) {
    const edges = graph.edges.get(nodeId) ?? [];
    const hasIncoming = [...graph.edges.values()].some((el) => el.some((e) => e.to === nodeId));
    if (edges.length === 0 && !hasIncoming) {
      lines.push(`  ${escapeMermaidId(nodeId)}`);
    }
  }

  return lines.join('\n');
}

function escapeMermaidId(id: string): string {
  // Mermaid doesn't like hyphens in bare IDs — wrap in quotes if needed
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id) ? id : `${id}`;
}

// ---------------------------------------------------------------------------
// P2 — DOT format for Graphviz
// ---------------------------------------------------------------------------

/**
 * Generate a Graphviz DOT format string.
 */
export function toDot(graph: DAGGraph): string {
  const lines: string[] = ['digraph workflow {'];
  lines.push('  rankdir=TD;');

  // Node declarations with shapes
  for (const [nodeId, node] of graph.nodes) {
    const shape = node.definition.type === 'terminal' ? 'doublecircle' : 'box';
    const style = nodeId === graph.initialNodeId ? ', style=bold' : '';
    lines.push(`  "${nodeId}" [shape=${shape}${style}];`);
  }

  lines.push('');

  // Edges
  for (const [, edges] of graph.edges) {
    for (const edge of edges) {
      lines.push(`  "${edge.from}" -> "${edge.to}" [label="${escapeLabel(edge.condition)}"];`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function escapeLabel(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// P2 — JSON export
// ---------------------------------------------------------------------------

/**
 * Export the adjacency list as a plain JSON-serialisable object.
 */
export function toAdjacencyListJSON(
  graph: DAGGraph,
): Record<string, { type: string; edges: Array<{ to: string; condition: string; priority: number }> }> {
  const result: Record<string, { type: string; edges: Array<{ to: string; condition: string; priority: number }> }> =
    {};

  for (const [nodeId, node] of graph.nodes) {
    const edges = (graph.edges.get(nodeId) ?? []).map((e) => ({
      to: e.to,
      condition: e.condition,
      priority: e.priority,
    }));
    result[nodeId] = {
      type: node.definition.type,
      edges,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// P1 — Pretty-print validation report
// ---------------------------------------------------------------------------

/**
 * Format a `GraphValidationResult` as a human-readable CLI report.
 */
export function formatValidationReport(result: GraphValidationResult): string {
  const lines: string[] = [];

  // Header
  if (result.valid) {
    lines.push('✅ Graph validation passed');
  } else {
    lines.push('❌ Graph validation failed');
  }
  lines.push('');

  // Stats
  lines.push('📊 Graph Statistics:');
  lines.push(`   Nodes: ${result.stats.totalNodes}`);
  lines.push(`   Edges: ${result.stats.totalEdges}`);
  lines.push(`   Max Depth: ${result.stats.maxDepth}`);
  lines.push(`   Terminal Nodes: ${result.stats.terminalNodes}`);
  const types = Object.entries(result.stats.nodesByType)
    .map(([t, c]) => `${t}=${c}`)
    .join(', ');
  lines.push(`   Node Types: ${types}`);
  lines.push('');

  // Errors
  if (result.errors.length > 0) {
    lines.push(`🚨 Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      lines.push(`   [${err.code}] ${err.message}`);
      if (err.cyclePath) {
        lines.push(`     Cycle: ${err.cyclePath.join(' → ')}`);
      }
    }
    lines.push('');
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push(`⚠️  Warnings (${result.warnings.length}):`);
    for (const warn of result.warnings) {
      lines.push(`   [${warn.code}] ${warn.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
