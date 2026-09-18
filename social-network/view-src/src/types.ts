/** The `SocialNetwork` payload, as `src/lib.rs` serialises it. */

export interface SocialNode {
  resource: number;
  events: number;
  cases: number;
  activities: number;
  outWeight: number;
  inWeight: number;
}

export interface SocialEdge {
  from: number;
  to: number;
  weight: number;
  raw: number;
}

export interface SocialStats {
  cases: number;
  events: number;
  eventsWithoutResource: number;
  resourcesTotal: number;
  resourcesOmitted: number;
  edgesBeforePruning: number;
  selfLoopsDropped: number;
}

export interface SocialNetworkPayload {
  metric: string;
  /** `share` | `ratio` | `similarity` — see the Rust doc comment. */
  weightKind: string;
  directed: boolean;
  resources: string[];
  nodes: SocialNode[];
  edges: SocialEdge[];
  stats: SocialStats;
}

/** How the metric id reads in a heading. */
export function metricLabel(metric: string): string {
  if (metric.startsWith('similarTask:')) {
    const kind = metric.slice('similarTask:'.length);
    const named: Record<string, string> = {
      pearson: 'Pearson correlation', cosine: 'cosine', euclidean: 'Euclidean distance',
    };
    return `Similar task (${named[kind] ?? kind})`;
  }
  return ({
    handover: 'Handover of work',
    subcontracting: 'Subcontracting',
    workingTogether: 'Working together',
    reassignment: 'Reassignment',
  } as Record<string, string>)[metric] ?? metric;
}

/** What one edge's weight means, for a tooltip. */
export function weightLabel(kind: string): string {
  return ({
    share: 'share of all transfers',
    ratio: 'of the cases either is in',
    similarity: 'similarity',
  } as Record<string, string>)[kind] ?? kind;
}
