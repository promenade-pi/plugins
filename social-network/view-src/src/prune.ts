import type { SocialEdge } from './types';

/**
 * Which edges to draw.
 *
 * A real handover network is a long tail: fifty people produce a nearly
 * complete graph in which almost every edge carries almost nothing. Drawing
 * all of it is a hairball that hides the twenty transfers the process
 * actually runs on, so the view always has a cut — and the cut has to be one
 * the reader can state, not a magic threshold.
 *
 * "The strongest edges accounting for X% of all the weight" is that
 * statement, and it is the right one for a share or a ratio: at 0.8 you are
 * looking at the pairs that carry four fifths of the traffic, whatever the
 * shape of the tail.
 *
 * It is the wrong statement for a similarity, where a weight can be negative
 * (two people whose work is anti-correlated) and a cumulative total is
 * meaningless — a negative edge would *reduce* the running sum and pull
 * weaker edges back in. There the cut falls back to rank: the strongest X% of
 * the edges by count. Both are "show me less", and which one applies follows
 * from the data rather than from another control nobody wants to set.
 */
export function prunedEdges(edges: SocialEdge[], share: number): SocialEdge[] {
  if (edges.length === 0) return [];
  const keepAll = share >= 1;
  if (keepAll) return edges;

  // The kernel already sorts strongest-first; sorting again here keeps this
  // function honest on its own terms rather than on a caller's promise.
  const sorted = [...edges].sort((a, b) => b.weight - a.weight);
  const anyNegative = sorted.some((e) => e.weight < 0);

  if (anyNegative) {
    const keep = Math.max(1, Math.round(share * sorted.length));
    return sorted.slice(0, keep);
  }

  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return sorted;
  const target = total * share;
  const out: SocialEdge[] = [];
  let running = 0;
  for (const e of sorted) {
    out.push(e);
    running += e.weight;
    if (running >= target) break;
  }
  return out;
}

/** Nodes left with nothing attached once the edges are cut. */
export function isolatedNodes(count: number, edges: SocialEdge[]): Set<number> {
  const touched = new Set<number>();
  for (const e of edges) { touched.add(e.from); touched.add(e.to); }
  const out = new Set<number>();
  for (let i = 0; i < count; i++) if (!touched.has(i)) out.add(i);
  return out;
}
