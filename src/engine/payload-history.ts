/**
 * Payload history types for tracking merge provenance.
 *
 * Each merge operation on the PayloadManager is recorded as a
 * `PayloadHistoryEntry`, enabling debugging and audit trails.
 */

// ---------------------------------------------------------------------------
// History entry type
// ---------------------------------------------------------------------------

/**
 * A single entry in the payload merge history.
 *
 * Captures what node produced the merge, when it happened, which keys
 * were modified, and a full snapshot of the payload at that point.
 */
export interface PayloadHistoryEntry {
  /** The ID of the node that triggered this merge. */
  nodeId: string;
  /** Unix timestamp (ms) when the merge occurred. */
  timestamp: number;
  /** Top-level keys that were modified by this merge. */
  keysModified: string[];
  /** Deep clone of the full payload at the time of this merge. */
  snapshot: Record<string, unknown>;
}
