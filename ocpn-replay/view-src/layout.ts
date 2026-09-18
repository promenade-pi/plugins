/**
 * ELK graph construction and layout, run entirely synchronously in this
 * frame's own thread.
 *
 * The sandboxed view boundary's CSP (`app/src/ui/plugin-frame.html`) has no
 * `worker-src`, which falls back to `default-src 'none'` — `new Worker(...)`
 * throws regardless of how it's constructed, blob URL included. So this
 * cannot use `elk-api.js` + a real `?worker`-built Worker the way the host's
 * own `ocpnLayout.ts` does, and cannot move layout into a real Web Worker at
 * all — the "synchronous shim" below is not a stepping stone toward one,
 * it's the ceiling this boundary allows.
 *
 * `elkjs/lib/elk-worker.min.js` (the actual layout engine, GWT-transpiled)
 * decides at load time whether it's running *inside* a real Worker: it
 * checks `typeof document === 'undefined'`. A document exists here (this is
 * a normal, if sandboxed, iframe document) — the same branch Node takes, for
 * the same reason — so it never calls `self.onmessage` and instead exports a
 * `Worker`-shaped class that dispatches through `setTimeout`, not a thread.
 * Handing that class to `elk-api.js` as its `workerFactory` gets the same
 * promise-based `.layout()` API the host uses, with no real Worker anywhere
 * in the call chain.
 */
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- no type declarations for the direct worker-shim import
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import type { OcpnPayload } from './types';
import { sortedArcs, sortedPlaces, sortedTransitions } from './canonical';

export const PLACE_R = 14;
/** Source/sink markers match the compact OC-DFG boundary notation. */
export const BOUNDARY_D = 29;
export const TRANS_W = 130;
export const TRANS_H = 34;

/**
 * Tuned layered-layout preset. Every key below is a real, documented ELK
 * layered option (Eclipse Layout Kernel option registry) — verified by
 * running each live rather than trusting the string alone, since elkjs's JS
 * API does not reject an unrecognised key at call time (it is silently a
 * no-op, not an error); see `docs/architecture.md`'s "ELK option
 * verification" note for how that was checked in practice.
 */
export const ocpnLayoutOptions: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',

  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.separateConnectedComponents': 'true',
  // An object-centric net over a short process is almost a straight chain —
  // left→right layout then stretches it into a thin ribbon that fits-to-width
  // at an unreadable zoom. `wrapping` folds that chain into a few rows toward
  // a ~1.7:1 box, and the layers stay close so it reads as a compact machine.
  'elk.aspectRatio': '1.7',
  'elk.layered.wrapping.strategy': 'MULTI_EDGE',
  'elk.layered.wrapping.additionalEdgeSpacing': '20',

  'elk.spacing.nodeNode': '44',
  'elk.spacing.edgeNode': '22',
  'elk.spacing.edgeEdge': '14',
  'elk.spacing.componentComponent': '80',

  'elk.layered.cycleBreaking.strategy': 'GREEDY',

  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',

  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '40',

  /**
   * NETWORK_SIMPLEX placement recurses per constraint-graph node in this
   * GWT-compiled build, with no tail-call elimination — on a dense OCPN
   * (many arcs sharing transitions across object types) that overflows V8's
   * stack well before it'd even be slow, throwing an uncaught `RangeError`
   * deep inside elkjs with nothing in this synchronous shim to catch it at.
   * LINEAR_SEGMENTS is iterative and produces near-identical layouts for the
   * graphs this preset actually sees; a size guard in plugin.tsx covers the
   * far larger graphs where LINEAR_SEGMENTS itself would just be slow
   * instead of crashing — see its `LAYOUT_EDGE_LIMIT` comment.
   */
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',

  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.layered.spacing.edgeNodeBetweenLayers': '28',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',

  'elk.layered.thoroughness': '15',

  'elk.layered.unnecessaryBendpoints': 'false',
};

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
}

export interface ElkPoint { x: number; y: number }
export interface ElkSection {
  startPoint: ElkPoint;
  bendPoints?: ElkPoint[];
  endPoint: ElkPoint;
}
interface ElkResultNode { id: string; x: number; y: number; width: number; height: number }
interface ElkResultEdge { id: string; sections?: ElkSection[] }
export interface ElkResult {
  children?: ElkResultNode[];
  edges?: ElkResultEdge[];
}

/**
 * Builds the ELK input graph in a canonical order (`canonical.ts`) — the OCPN
 * artifact's own arrays are in whatever order the discovery run happened to
 * produce, not something this view depends on. No layout coordinates or
 * timing information enters here: object type, place role and activity
 * label are structural facts of the net, not schedule information, and
 * that's the only kind of fact this function reads.
 */
export function buildElkGraph(
  net: OcpnPayload,
  visibleTypes: Set<string>,
  showSilent: boolean
): ElkGraph {
  const hiddenPlaces = new Set(net.places.filter((p) => !visibleTypes.has(p.objectType)).map((p) => p.id));
  const hiddenTransitions = new Set(
    net.transitions
      .filter((t) => (t.activity == null && !showSilent) || t.objectTypes.every((ot) => !visibleTypes.has(ot)))
      .map((t) => t.id)
  );

  const children: ElkGraph['children'] = [];
  for (const p of sortedPlaces(net.places)) {
    if (hiddenPlaces.has(p.id)) continue;
    const d = p.kind === 'normal' ? PLACE_R * 2 : BOUNDARY_D;
    children.push({ id: p.id, width: d, height: d });
  }
  for (const t of sortedTransitions(net.transitions)) {
    if (hiddenTransitions.has(t.id)) continue;
    children.push({ id: t.id, width: t.activity == null ? 24 : TRANS_W, height: TRANS_H });
  }

  const nodeIds = new Set(children.map((c) => c.id));
  const edges: ElkGraph['edges'] = [];
  for (const a of sortedArcs(net.arcs)) {
    if (!visibleTypes.has(a.objectType)) continue;
    if (!nodeIds.has(a.source.id) || !nodeIds.has(a.target.id)) continue;
    edges.push({ id: a.id, sources: [a.source.id], targets: [a.target.id] });
  }

  return { id: 'root', layoutOptions: ocpnLayoutOptions, children, edges };
}

export function layoutOcpn(graph: ElkGraph): Promise<ElkResult> {
  return ensureElk().layout(graph as any) as Promise<ElkResult>;
}

/**
 * Draw ELK `SPLINES` geometry as ELK encodes it. Bend points are not points
 * for a Catmull–Rom curve to pass through: they are cubic Bézier controls and
 * intermediate anchors in `(control, control, anchor)` triples. Interpreting
 * them as pass-through points created the visible spikes in the old renderer.
 *
 * If a section is not a valid ELK spline-control list, retain its exact
 * polyline geometry rather than inventing a different curve.
 */
export function pathFromSections(sections: ElkSection[]): string {
  return sections.map(sectionPath).filter(Boolean).join(' ');
}

function sectionPath(section: ElkSection): string {
  const polyline = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  if (polyline.length < 2) return '';

  const control = [section.startPoint, ...(section.bendPoints ?? [])];
  // ELK sometimes omits the final anchor from bend points, keeping it only
  // in `endPoint`. Then the control list ends with two controls.
  if ((control.length - 1) % 3 === 2) control.push(section.endPoint);
  if (control.length >= 4 && (control.length - 1) % 3 === 0) {
    let path = `M ${fmt(control[0])}`;
    for (let i = 1; i < control.length; i += 3) {
      path += ` C ${fmt(control[i])}, ${fmt(control[i + 1])}, ${fmt(control[i + 2])}`;
    }
    return path;
  }

  return `M ${fmt(polyline[0])}` + polyline.slice(1).map((point) => ` L ${fmt(point)}`).join('');
}

function fmt(p: ElkPoint): string {
  return `${p.x} ${p.y}`;
}
