import { useMemo } from 'react';
import type { MmBoundary, MmEdge, MmNode } from './types';

export interface Coverage {
  /** e.g. "arcs" — the thing the slider directly controls. */
  primaryLabel: string;
  primaryShown: number;
  primaryTotal: number;
  /** e.g. "activities" — what that implies is shown. */
  secondaryLabel: string;
  secondaryShown: number;
  secondaryTotal: number;
  /** Headline percentage (arc-weight for OC-DFG, node share for Petri net). */
  pct: number;
}

export interface ComplexityFilterResult {
  keptNodeIds: Set<string>;
  keptEdgeIds: Set<string>;
  /** Synthetic terminus edges (Petri-net basis): when the slider hides the
   * stop a line's ▶/■ actually connects to, a dashed edge to the nearest
   * still-visible stop of that line so the terminus isn't left floating. */
  extraEdges: MmEdge[];
  coverage: Coverage;
  sliderMax: number;
  /** The position the slider sits at until the user first moves it. */
  seed: number;
}

export function useComplexityFilter(args: {
  basis: 'petriNet' | 'directlyFollows';
  nodes: MmNode[];
  edges: MmEdge[];
  byId: Map<string, MmNode>;
  complexity: number | null;
}): ComplexityFilterResult {
  const { basis, nodes, edges, complexity } = args;
  return useMemo(
    () => (basis === 'directlyFollows' ? dfgFilter(nodes, edges, complexity) : petriFilter(nodes, edges, complexity)),
    [basis, nodes, edges, complexity],
  );
}

function isBoundary(n: MmNode): n is MmBoundary {
  return n.kind === 'source' || n.kind === 'sink';
}

/**
 * Rank each object type's arcs by observed frequency,
 * keep the top N per type (N = the slider), and show exactly the activities
 * those arcs touch. The seed picks whichever N first brings the combined
 * total to about half of every arc in the graph — the slider's own scale is
 * "top N per object-type group", not a plain arc count, so hitting a target
 * arc count (rather than a target N) needs this search regardless of how
 * many groups there are or how unevenly sized they are.
 */
export function dfgFilter(nodes: MmNode[], edges: MmEdge[], complexity: number | null): ComplexityFilterResult {
  const byGroup = new Map<string, MmEdge[]>();
  for (const e of edges) {
    const g = byGroup.get(e.objectType) ?? [];
    g.push(e);
    byGroup.set(e.objectType, g);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0) || a.id.localeCompare(b.id));
  }
  const groupSizes = [...byGroup.values()].map((l) => l.length);
  const sliderMax = Math.max(1, ...groupSizes);

  const unionAt = (n: number) => groupSizes.reduce((s, len) => s + Math.min(n, len), 0);
  const targetArcs = Math.round(edges.length * 0.5);
  let seed = sliderMax;
  for (let n = 1; n <= sliderMax; n++) {
    if (unionAt(n) >= targetArcs) {
      seed = n;
      break;
    }
  }

  const n = Math.min(Math.max(0, complexity ?? seed), sliderMax);
  const keptEdges: MmEdge[] = [];
  for (const list of byGroup.values()) keptEdges.push(...list.slice(0, n));

  const keptEdgeIds = new Set(keptEdges.map((e) => e.id));
  const keptNodeIds = new Set<string>();
  for (const e of keptEdges) {
    keptNodeIds.add(e.source);
    keptNodeIds.add(e.target);
  }

  const stations = nodes.filter((x) => x.kind === 'station');
  const shownStations = stations.filter((x) => keptNodeIds.has(x.id)).length;

  return {
    keptNodeIds,
    keptEdgeIds,
    extraEdges: [],
    sliderMax,
    seed,
    coverage: {
      primaryLabel: 'arcs',
      primaryShown: keptEdges.length,
      primaryTotal: edges.length,
      secondaryLabel: 'activities',
      secondaryShown: shownStations,
      secondaryTotal: stations.length,
      // A plain share of arcs *shown*, not of the traffic they carry — the
      // top-N-per-type filter already keeps the busiest arcs first, so a
      // frequency-weighted percentage reads much higher than the "X / Y
      // arcs" count right next to it (e.g. 8/22 arcs shown as "85%"),
      // which looks like a mismatch rather than the two views of the same
      // thing they are.
      pct: edges.length > 0 ? Math.round((100 * keptEdges.length) / edges.length) : 0,
    },
  };
}

/**
 * Petri-net basis has no counts, so the slider reveals structurally: every
 * non-boundary node carries a `revealOrder` (0 = process core, higher =
 * peeled-off leaf), computed in Rust. The slider keeps everything at or
 * below its value. Every line always keeps its ▶ start and ■ end though —
 * if the slider hid the stop a terminus connects to, a synthetic dashed
 * edge reconnects it to the nearest still-visible stop of that line.
 */
function petriFilter(nodes: MmNode[], edges: MmEdge[], complexity: number | null): ComplexityFilterResult {
  const orders = nodes
    .filter((n) => !isBoundary(n) && n.meta?.revealOrder != null)
    .map((n) => n.meta!.revealOrder as number);
  const sliderMax = Math.max(1, ...orders, 0);
  const seed = Math.max(1, Math.round(sliderMax * 0.6));
  const c = Math.min(Math.max(0, complexity ?? seed), sliderMax);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keptNodeIds = new Set<string>();
  for (const n of nodes) {
    if (isBoundary(n)) continue;
    if (n.meta?.revealOrder == null || n.meta.revealOrder <= c) keptNodeIds.add(n.id);
  }
  // Every line keeps its ▶ start and ■ end at any slider level — a line that
  // just fades out mid-diagram reads as broken. Keep a boundary whenever its
  // object type still has any visible stop.
  const typeHasStop = new Set<string>();
  for (const id of keptNodeIds) {
    const n = byId.get(id);
    if (!n) continue;
    for (const ot of n.kind === 'station' ? n.objectTypes : [n.objectType]) typeHasStop.add(ot);
  }
  for (const n of nodes) {
    if (isBoundary(n) && typeHasStop.has(n.objectType)) keptNodeIds.add(n.id);
  }

  const keptEdgeIds = new Set(
    edges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target)).map((e) => e.id),
  );

  // Reconnect any terminus whose real neighbour got filtered out: a dashed
  // synthetic edge to the nearest still-visible stop of the same line
  // (nearest by payload rank), so it terminates a real line rather than
  // floating alone.
  const extraEdges: MmEdge[] = [];
  for (const n of nodes) {
    if (!isBoundary(n) || !keptNodeIds.has(n.id)) continue;
    const hasRealEdge = edges.some(
      (e) => keptEdgeIds.has(e.id) && (e.source === n.id || e.target === n.id),
    );
    if (hasRealEdge) continue;
    const stops = nodes.filter(
      (m) => m.kind === 'station' && keptNodeIds.has(m.id) && m.objectTypes.includes(n.objectType),
    );
    if (!stops.length) continue;
    // A source attaches to that line's *earliest* still-visible stop, a sink
    // to its *latest* — so the terminus stays above / below the line, never
    // floating in from the wrong direction.
    const other = stops.reduce((best, m) =>
      (n.kind === 'source' ? m.rank < best.rank : m.rank > best.rank) ? m : best,
    );
    extraEdges.push({
      id: `__term:${n.id}`,
      source: n.kind === 'source' ? n.id : other.id,
      target: n.kind === 'source' ? other.id : n.id,
      objectType: n.objectType,
      kind: 'flow',
      laneOffset: 0,
    });
  }

  const stations = nodes.filter((n) => n.kind === 'station');
  const nonBoundary = nodes.filter((n) => !isBoundary(n));
  const shownNonBoundary = nonBoundary.filter((n) => keptNodeIds.has(n.id)).length;

  return {
    keptNodeIds,
    keptEdgeIds,
    extraEdges,
    sliderMax,
    seed,
    coverage: {
      primaryLabel: 'stations',
      primaryShown: stations.filter((n) => keptNodeIds.has(n.id)).length,
      primaryTotal: stations.length,
      secondaryLabel: 'arcs',
      secondaryShown: keptEdgeIds.size,
      secondaryTotal: edges.length,
      pct: nonBoundary.length > 0 ? Math.round((100 * shownNonBoundary) / nonBoundary.length) : 0,
    },
  };
}
