/**
 * The Fuzzy Miner's simplification chain: conflict resolution, edge filter,
 * node aggregation.
 *
 * This is deliberately *not* in the Rust kernel. In ProM the mined artefact is
 * the metric graph; these three filters are a pure, cheap O(n²) transformation
 * of it that the sliders beside the diagram re-run on every drag. Promenade's
 * scan/finalize cache is keyed by the log and the activity limit, and a view's
 * own params never re-enter it, so a slider that had to reach the kernel would
 * be a round-trip per pixel at best and stale at worst. Running the chain here,
 * over a model that already lives in the frame, is what makes the rail feel the
 * way the original does.
 *
 * Ported from Günther's ProM implementation via the Python reference
 * (`fnc11/FuzzyMiner`: `FMRepository.FilteredDataRepository` and
 * `ClusterUtil`). Deviations from that reference are marked DEVIATION and
 * there are only two, both of them fixes for reference bugs whose behaviour
 * was clearly unintended.
 */
import type { ViewParams } from './types';

export interface FuzzyNode {
  index: number;
  label: string;
  significance: number;
  count: number;
}

export interface FuzzyCluster {
  index: number;
  significance: number;
  primitives: number[];
}

export interface FuzzyEdgeRec {
  source: number;
  target: number;
  significance: number;
  correlation: number;
}

export interface FuzzyGraph {
  nodes: FuzzyNode[];
  clusters: FuzzyCluster[];
  edges: FuzzyEdgeRec[];
  /** Activities the chain removed outright, for the rail's counter. */
  removed: number;
}

interface Model {
  n: number;
  activities: string[];
  counts: number[];
  nodeSignificance: number[];
  edgeSignificance: number[];
  edgeCorrelation: number[];
}

/**
 * Conflict resolution.
 *
 * Where A and B relate in *both* directions the log is saying one of two very
 * different things: either A and B are genuinely concurrent (so the order
 * varies and both directions are real), or one direction is the process and
 * the other is noise. ProM decides on *relative importance* — how much of
 * A's outgoing weight, and of B's incoming weight, this relation accounts
 * for. Two relations that both matter to their endpoints are left alone; a
 * lopsided pair loses its weaker half; a pair that is unimportant in both
 * directions loses both.
 */
function applyConcurrencyFilter(m: Model, p: ViewParams) {
  const sig = m.edgeSignificance.slice();
  const corr = m.edgeCorrelation.slice();
  if (!p.filterConcurrency) return { sig, corr };

  const n = m.n;
  // Relative importance is read off the *unfiltered* matrices, so the answer
  // does not depend on the order the pairs happen to be visited in.
  const relativeImportance = (x: number, y: number): number => {
    const ref = m.edgeSignificance[x * n + y];
    let sourceOut = 0;
    let targetIn = 0;
    for (let i = 0; i < n; i++) {
      if (i !== x) sourceOut += m.edgeSignificance[x * n + i];
      if (i !== y) targetIn += m.edgeSignificance[i * n + y];
    }
    return ref / sourceOut + ref / targetIn;
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const fwd = m.edgeSignificance[i * n + j];
      const bwd = m.edgeSignificance[j * n + i];
      if (!(fwd > 0 && bwd > 0)) continue;

      const impAB = relativeImportance(i, j);
      const impBA = relativeImportance(j, i);
      if (impAB > p.concurrencyPreserve && impBA > p.concurrencyPreserve) continue;

      const ratio = Math.min(impAB, impBA) / Math.max(impAB, impBA);
      if (ratio < p.concurrencyRatio) {
        // One direction clearly dominates: keep it, drop the other.
        const loser = impAB > impBA ? j * n + i : i * n + j;
        sig[loser] = 0;
        corr[loser] = 0;
      } else {
        // Evenly matched but unimportant to both endpoints: noise, not
        // concurrency.
        sig[i * n + j] = 0;
        corr[i * n + j] = 0;
        sig[j * n + i] = 0;
        corr[j * n + i] = 0;
      }
    }
  }
  return { sig, corr };
}

/**
 * The edge filter, per activity rather than globally — which is the whole
 * point. A global significance threshold silences a quiet part of the process
 * entirely; ranking each activity's own relations against each other keeps
 * every surviving activity connected to *something*.
 *
 * "Fuzzy edges" ranks by `significance × ratio + correlation × (1 − ratio)`
 * and keeps everything within `cutoff` of the range between an activity's
 * best and worst relation. "Best edges" keeps only the single strongest
 * predecessor and successor.
 */
function applyEdgeFilter(m: Model, p: ViewParams, csig: number[], ccorr: number[]) {
  const n = m.n;
  const sig = csig.slice();
  const corr = ccorr.slice();
  const keep = new Uint8Array(n * n);

  // A cutoff of exactly 0 makes `limit === max`, which floating-point
  // comparison then fails for the maximum itself on some rows; ProM nudges it
  // rather than special-casing the comparison.
  const preserve = p.edgeCutoff === 0 ? 0.001 : p.edgeCutoff;

  for (let idx = 0; idx < n; idx++) {
    if (p.edgeTransform === 'best') {
      let bestPre = -1;
      let bestSucc = -1;
      let bestPreSig = 0;
      let bestSuccSig = 0;
      for (let i = 0; i < n; i++) {
        if (i === idx && p.ignoreSelfLoops) continue;
        const pre = csig[i * n + idx];
        if (pre > bestPreSig) { bestPreSig = pre; bestPre = i; }
        const succ = csig[idx * n + i];
        if (succ > bestSuccSig) { bestSuccSig = succ; bestSucc = i; }
      }
      if (bestPre >= 0) keep[bestPre * n + idx] = 1;
      if (bestSucc >= 0) keep[idx * n + bestSucc] = 1;
      continue;
    }

    const inValues = new Float64Array(n);
    const outValues = new Float64Array(n);
    let minIn = Number.MAX_VALUE;
    let maxIn = -Number.MAX_VALUE;
    let minOut = Number.MAX_VALUE;
    let maxOut = -Number.MAX_VALUE;

    for (let i = 0; i < n; i++) {
      if (p.ignoreSelfLoops && i === idx) continue;

      const inSig = csig[i * n + idx];
      if (inSig > 0) {
        inValues[i] = inSig * p.utilityRatio + ccorr[i * n + idx] * (1 - p.utilityRatio);
        if (inValues[i] > maxIn) maxIn = inValues[i];
        if (inValues[i] < minIn) minIn = inValues[i];
      }

      const outSig = csig[idx * n + i];
      if (outSig > 0) {
        outValues[i] = outSig * p.utilityRatio + ccorr[idx * n + i] * (1 - p.utilityRatio);
        if (outValues[i] > maxOut) maxOut = outValues[i];
        if (outValues[i] < minOut) minOut = outValues[i];
      }
    }

    if (p.interpretAbsolute) {
      maxIn = Math.max(maxIn, maxOut);
      maxOut = maxIn;
      minIn = Math.min(minIn, minOut);
      minOut = minIn;
    }

    const inLimit = maxIn - (maxIn - minIn) * preserve;
    const outLimit = maxOut - (maxOut - minOut) * preserve;

    for (let i = 0; i < n; i++) {
      if (p.ignoreSelfLoops && i === idx) continue;
      // A relation that does not exist has value 0 and must not sneak past a
      // limit that has itself gone negative on a row with no relations.
      if (csig[i * n + idx] > 0 && inValues[i] >= inLimit) keep[i * n + idx] = 1;
      if (csig[idx * n + i] > 0 && outValues[i] >= outLimit) keep[idx * n + i] = 1;
    }
  }

  for (let i = 0; i < n * n; i++) {
    if (!keep[i]) { sig[i] = 0; corr[i] = 0; }
  }
  return { sig, corr };
}

/** Cluster bookkeeping — index space `>= n` is clusters, `-1` is removed. */
interface ClusterState {
  mapping: number[];
  clusters: Map<number, number[]>;
  /** Insertion order, because merging walks the list while mutating it. */
  order: number[];
}

/**
 * Node aggregation.
 *
 * An activity below the cutoff is not simply deleted — deleting it would break
 * whatever path ran through it. It joins a cluster with the neighbour it
 * correlates with most, clusters that only touch other clusters merge into
 * one, and a cluster that ends up holding a single activity is dissolved
 * again, with a transitive relation drawn around the gap it leaves.
 */
function clusterize(
  m: Model,
  cutoff: number,
  csig: number[],
  ccorr: number[],
  esig: number[],
  ecorr: number[]
): { state: ClusterState; nbsig: number[]; nbcorr: number[] } {
  const n = m.n;
  const nbsig = esig.slice();
  const nbcorr = ecorr.slice();
  const state: ClusterState = {
    mapping: Array.from({ length: n }, (_, i) => i),
    clusters: new Map(),
    order: [],
  };

  /**
   * The neighbour a victim correlates with most, read from the matrices as
   * they stood *before* the edge filter — the edge filter may well have cut
   * every relation this activity had, and it still has to go somewhere.
   */
  const mostCorrelated = (idx: number): number => {
    let max = 0;
    // DEVIATION: the Python reference initialises this to 0 rather than -1, so
    // an activity correlating with nothing is adopted by whatever activity 0
    // maps to. `-1` here means "no neighbour", which is what the surrounding
    // code already handles by opening a fresh cluster.
    let winner = -1;
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      const out = ccorr[idx * n + i];
      if (out > max) { winner = state.mapping[i]; max = out; }
      const inc = ccorr[i * n + idx];
      if (inc > max) { winner = state.mapping[i]; max = inc; }
    }
    return winner;
  };

  // ---- initial clusters -------------------------------------------------
  const victims: number[] = [];
  for (let i = 0; i < n; i++) if (m.nodeSignificance[i] < cutoff) victims.push(i);

  let nextCluster = n + 1;
  for (let i = 0; i < victims.length; i++) {
    const victim = victims[i];
    if (victim === -1) continue;
    const neighbour = mostCorrelated(victim);
    if (neighbour >= n) {
      state.clusters.get(neighbour)!.push(victim);
      state.mapping[victim] = neighbour;
      victims[i] = -1;
      continue;
    }
    const index = nextCluster++;
    const primitives = [victim];
    state.clusters.set(index, primitives);
    state.order.push(index);
    state.mapping[victim] = index;
    victims[i] = -1;
    // A neighbour that is itself an unprocessed victim joins straight away,
    // rather than waiting for its own turn and opening a second cluster.
    const at = neighbour >= 0 ? victims.indexOf(neighbour) : -1;
    if (at >= 0) {
      primitives.push(neighbour);
      state.mapping[neighbour] = index;
      victims[at] = -1;
    }
  }

  // ---- neighbours, in the post-clustering index space --------------------
  const predecessorsOfNode = (index: number): Set<number> => {
    const out = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (i === index) continue;
      if (nbsig[i * n + index] > 0 && state.mapping[i] !== -1) out.add(state.mapping[i]);
    }
    return out;
  };
  const successorsOfNode = (index: number): Set<number> => {
    const out = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (i === index) continue;
      if (nbsig[index * n + i] > 0 && state.mapping[i] !== -1) out.add(state.mapping[i]);
    }
    return out;
  };
  const around = (index: number, of: (i: number) => Set<number>): Set<number> => {
    const primitives = state.clusters.get(index)!;
    const out = new Set<number>();
    for (const p of primitives) for (const q of of(p)) out.add(q);
    for (const p of primitives) out.delete(p);
    out.delete(index);
    return out;
  };
  const predecessorsOfCluster = (i: number) => around(i, predecessorsOfNode);
  const successorsOfCluster = (i: number) => around(i, successorsOfNode);

  const aggregateCorrelation = (a: number, b: number): number => {
    let total = 0;
    for (const x of state.clusters.get(a)!) {
      for (const y of state.clusters.get(b)!) {
        total += ecorr[x * n + y] + ecorr[y * n + x];
      }
    }
    return total;
  };

  // ---- merge -------------------------------------------------------------
  /**
   * A cluster merges with a neighbouring cluster only when *all* its
   * neighbours on that side are clusters too. A single real activity upstream
   * is enough to stop the merge: it is the boundary the user can still read
   * the diagram against, and swallowing it would fold two distinct parts of
   * the process into one blob.
   */
  const preferredMergeTarget = (subject: number): number | null => {
    let preTarget: number | null = null;
    let succTarget: number | null = null;
    let maxPre = 0;
    let maxSucc = 0;

    for (const pre of predecessorsOfCluster(subject)) {
      if (state.clusters.has(pre)) {
        const corr = aggregateCorrelation(subject, pre);
        if (corr > maxPre) { maxPre = corr; preTarget = pre; }
      } else {
        preTarget = null;
        maxPre = 0;
        break;
      }
    }
    for (const succ of successorsOfCluster(subject)) {
      if (state.clusters.has(succ)) {
        const corr = aggregateCorrelation(subject, succ);
        if (corr > maxSucc) { maxSucc = corr; succTarget = succ; }
      } else {
        return preTarget;
      }
    }
    return maxPre > maxSucc ? preTarget : succTarget;
  };

  for (let i = 0; i < state.order.length; ) {
    const subject = state.order[i];
    const target = preferredMergeTarget(subject);
    if (target === null) { i++; continue; }
    for (const p of state.clusters.get(subject)!) {
      state.clusters.get(target)!.push(p);
      state.mapping[p] = target;
    }
    state.clusters.delete(subject);
    state.order.splice(i, 1);
  }

  // ---- isolated clusters -------------------------------------------------
  // Nothing leads in and nothing leads out: the activities inside were
  // insignificant *and* unconnected, so they leave the diagram entirely.
  for (let i = 0; i < state.order.length; ) {
    const index = state.order[i];
    if (predecessorsOfCluster(index).size === 0 && successorsOfCluster(index).size === 0) {
      for (const p of state.clusters.get(index)!) state.mapping[p] = -1;
      state.clusters.delete(index);
      state.order.splice(i, 1);
    } else {
      i++;
    }
  }

  // ---- singular clusters -------------------------------------------------
  /**
   * A cluster of one is not worth drawing as a cluster. The activity goes, and
   * where that would have severed a path, the relation is redrawn straight
   * from its predecessor to its successor with the mean of the two relations
   * it replaces.
   */
  const dissolveSingular = (index: number) => {
    const own = state.clusters.get(index)![0];
    const preSet = predecessorsOfNode(own);
    const succSet = successorsOfNode(own);
    for (const pre of preSet) {
      if (state.clusters.has(pre)) continue;
      for (const succ of succSet) {
        if (state.clusters.has(succ)) continue;
        if (esig[pre * n + succ] === 0) {
          nbsig[pre * n + succ] = (esig[pre * n + own] + esig[own * n + succ]) / 2;
          nbcorr[pre * n + succ] = (ecorr[pre * n + own] + ecorr[own * n + succ]) / 2;
        }
        nbsig[pre * n + own] = 0;
        nbsig[own * n + succ] = 0;
        nbcorr[pre * n + own] = 0;
        nbcorr[own * n + succ] = 0;
      }
    }
    state.mapping[own] = -1;
  };

  for (let i = 0; i < state.order.length; ) {
    const index = state.order[i];
    if (state.clusters.get(index)!.length === 1) {
      dissolveSingular(index);
      state.clusters.delete(index);
      state.order.splice(i, 1);
    } else {
      i++;
    }
  }

  void csig;
  return { state, nbsig, nbcorr };
}

/**
 * Runs the whole chain and returns what the canvas should draw.
 */
export function applyFilters(model: Model, p: ViewParams): FuzzyGraph {
  const n = model.n;
  const { sig: csig, corr: ccorr } = applyConcurrencyFilter(model, p);
  const { sig: esig, corr: ecorr } = applyEdgeFilter(model, p, csig, ccorr);
  const { state, nbsig, nbcorr } = clusterize(model, p.nodeCutoff, csig, ccorr, esig, ecorr);

  const clusters: FuzzyCluster[] = state.order.map((index) => {
    const primitives = state.clusters.get(index)!;
    const mean = primitives.reduce((a, i) => a + model.nodeSignificance[i], 0) / primitives.length;
    return { index, significance: mean, primitives: primitives.slice() };
  });

  const nodes: FuzzyNode[] = [];
  for (let i = 0; i < n; i++) {
    if (state.mapping[i] !== -1 && state.mapping[i] < n) {
      nodes.push({
        index: i,
        label: model.activities[i] ?? `a${i}`,
        significance: model.nodeSignificance[i],
        count: model.counts[i] ?? 0,
      });
    }
  }

  // Relations are lifted into the post-clustering index space. Where two of
  // them collapse onto the same pair, the stronger one wins — a cluster's
  // edge should read as its most important relation, not its last one.
  const byPair = new Map<string, FuzzyEdgeRec>();
  const put = (source: number, target: number, significance: number, correlation: number) => {
    const key = `${source}>${target}`;
    const existing = byPair.get(key);
    if (existing) {
      if (existing.significance < significance) {
        existing.significance = significance;
        existing.correlation = correlation;
      }
    } else {
      byPair.set(key, { source, target, significance, correlation });
    }
  };

  for (let i = 0; i < n; i++) {
    if (state.mapping[i] === -1) continue;
    for (let j = 0; j < n; j++) {
      const significance = nbsig[i * n + j];
      if (significance <= 0) continue;
      const correlation = nbcorr[i * n + j];
      if (i === j) {
        // Only a real activity draws a self-loop; a cluster's internal
        // behaviour is what the cluster itself already stands for.
        if (state.mapping[i] < n) put(i, j, significance, correlation);
        continue;
      }
      const a = state.mapping[i];
      const b = state.mapping[j];
      if (a === -1 || b === -1) continue;
      if (a === b) continue; // internal to one cluster
      put(a, b, significance, correlation);
    }
  }

  const removed = state.mapping.filter((x) => x === -1).length;
  const edges = [...byPair.values()];

  // Only ever drops activities nothing points at, so no edge is orphaned by
  // it — `filters.check.ts` asserts that rather than re-filtering for it.
  let visibleNodes = nodes;
  if (p.dropDisconnected) {
    const connected = new Set<number>();
    for (const e of edges) { connected.add(e.source); connected.add(e.target); }
    visibleNodes = nodes.filter((node) => connected.has(node.index));
  }

  return { nodes: visibleNodes, clusters, edges, removed };
}

export type { Model as FuzzyFilterModel };
