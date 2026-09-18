/**
 * Mirrors `plugins/ocim-rs/crates/ocim-core/src/lib.rs`'s `OcptPayload`/
 * `TreeNode`/`TreeStats` field for field. This plugin is a separate package
 * with no access to the host's own TypeScript sources across the sandboxed
 * boundary, the same reason `plugins/ocpn-flow-view/src/types.ts` carries
 * its own copy of the OCPN contract. Keep in sync by hand.
 */

export type OcptOperator = 'sequence' | 'xor' | 'parallel' | 'loop';

export interface OcptTreeNode {
  operator: OcptOperator | null;
  label: string | null;
  children: number[];
  related: string[];
  divergent: string[];
  convergent: string[];
  deficient: string[];
}

export interface OcptStats {
  nodes: number;
  leaves: number;
  silent: number;
  operators: number;
  objectTypes: number;
  activitiesDropped: number;
}

export interface OcptPayload {
  root: number;
  nodes: OcptTreeNode[];
  activities: string[];
  objectTypes: string[];
  stats: OcptStats;
}
