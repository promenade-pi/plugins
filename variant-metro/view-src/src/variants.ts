import { useMemo } from 'react';
import type { MmEdge, MmNode, VariantSummary } from './types';

export interface Coverage {
  /** e.g. "variants" — the thing the slider directly controls. */
  primaryLabel: string;
  primaryShown: number;
  primaryTotal: number;
  /** Headline percentage, and what it is a percentage *of*. */
  pct: number;
  pctLabel: string;
  secondaryLabel: string;
  secondaryShown: number;
  secondaryTotal: number;
  tertiaryLabel: string;
  tertiaryShown: number;
  tertiaryTotal: number;
  /** Set when this slider position is the shared "and every remaining
   * variant" one — the readout says so instead of implying one more variant. */
  tail: boolean;
}

export interface VariantFilterResult {
  keptNodeIds: Set<string>;
  keptEdgeIds: Set<string>;
  /** Occurrence count of each station, over the shown variants only. */
  nodeCount: Map<string, number>;
  /** Observed frequency of each arc, over the shown variants only. */
  edgeFreq: Map<string, number>;
  /** Mean wait along each arc, over the shown variants only. Absent for an
   * arc the upstream stage gave no durations for (a ▶/■ terminus arc). */
  edgeDuration: Map<string, number>;
  coverage: Coverage;
  sliderMax: number;
  /** The position the slider sits at until the user first moves it. */
  seed: number;
}

/** Prefix sum over a sparse `[rank, ...values]` table, up to and including `k`. */
function upTo(rows: number[][] | undefined, k: number, column: number): number {
  if (!rows?.length) return 0;
  let total = 0;
  for (const row of rows) {
    if ((row[0] ?? 1) > k) break; // rows arrive ascending by rank
    total += row[column] ?? 0;
  }
  return total;
}

function minVariantOf(node: MmNode): number {
  return node.meta?.minVariant ?? 1;
}

/**
 * The whole point of this plugin, in one function.
 *
 * Every node and arc carries `minVariant`: the rank of the most frequent
 * variant it first appears in (1 = the most frequent variant of all). Keeping
 * exactly what sits at or below the slider therefore *is* the OC-DFG of the k
 * most frequent variants — no per-position recomputation, and no possibility
 * of the filtered graph disagreeing with the layout, because the layout was
 * computed once over every variant.
 *
 * Because `minVariant` is monotone along every arc (an arc cannot appear in an
 * earlier variant than its own endpoints — asserted in the Rust stage's
 * `min_variant_is_monotone_along_every_edge` test), the kept set only ever
 * grows as the slider rises, and never contains an arc whose endpoints are
 * hidden.
 *
 * The counts are re-derived per position rather than taken from the model, so
 * an arc label at "3 variants" reads the frequency within those three
 * variants, not the whole log's.
 */
export function useVariantFilter(args: {
  nodes: MmNode[];
  edges: MmEdge[];
  variants: VariantSummary[];
  position: number | null;
}): VariantFilterResult {
  const { nodes, edges, variants, position } = args;
  return useMemo(() => {
    // A payload with no variant scale at all (an empty log) still has to
    // produce a usable, non-crashing slider.
    const sliderMax = Math.max(1, variants.length);
    // Opens on the single most frequent variant: the plainest possible
    // reading of the process, with every further variant one notch up. The
    // full model is one drag away and is what the top of the slider always
    // means; opening there instead would open on the busiest picture the log
    // can produce, which is exactly what this plugin exists to unpick.
    const seed = 1;
    const k = Math.min(Math.max(1, position ?? seed), sliderMax);

    const keptNodeIds = new Set<string>();
    for (const n of nodes) if (minVariantOf(n) <= k) keptNodeIds.add(n.id);
    const keptEdgeIds = new Set<string>();
    for (const e of edges) {
      if ((e.minVariant ?? 1) > k) continue;
      if (!keptNodeIds.has(e.source) || !keptNodeIds.has(e.target)) continue;
      keptEdgeIds.add(e.id);
    }

    const nodeCount = new Map<string, number>();
    for (const n of nodes) {
      if (!keptNodeIds.has(n.id)) continue;
      const rows = n.meta?.variantCounts;
      nodeCount.set(n.id, rows ? upTo(rows, k, 1) : (n.meta?.frequency ?? 0));
    }

    const edgeFreq = new Map<string, number>();
    const edgeDuration = new Map<string, number>();
    for (const e of edges) {
      if (!keptEdgeIds.has(e.id)) continue;
      const rows = e.variantFreq;
      const freq = rows ? upTo(rows, k, 1) : (e.frequency ?? 0);
      edgeFreq.set(e.id, freq);
      // `variantFreq` carries the *sum* of waits, not their mean, precisely so
      // the mean can be taken over whichever subset is shown. An arc with no
      // recorded seconds (every ▶/■ terminus arc) gets no performance label
      // rather than a fabricated zero.
      if (rows && freq > 0) {
        const secs = upTo(rows, k, 2);
        if (secs > 0) edgeDuration.set(e.id, secs / freq);
      } else if (e.durationSecs != null) {
        edgeDuration.set(e.id, e.durationSecs);
      }
    }

    const stations = nodes.filter((n) => n.kind === 'station');
    const at = variants[k - 1];
    const variantTotal = variants.reduce((s, v) => s + (v.variants ?? 1), 0);
    return {
      keptNodeIds,
      keptEdgeIds,
      nodeCount,
      edgeFreq,
      edgeDuration,
      sliderMax,
      seed,
      coverage: {
        primaryLabel: 'variants',
        primaryShown: at?.cumulativeVariants ?? k,
        primaryTotal: variantTotal || k,
        pct: Math.round(100 * (at?.share ?? (k >= sliderMax ? 1 : 0))),
        pctLabel: 'of cases',
        secondaryLabel: 'activities',
        secondaryShown: stations.filter((n) => keptNodeIds.has(n.id)).length,
        secondaryTotal: stations.length,
        tertiaryLabel: 'arcs',
        tertiaryShown: keptEdgeIds.size,
        tertiaryTotal: edges.length,
        tail: at?.tail ?? false,
      },
    };
  }, [nodes, edges, variants, position]);
}
