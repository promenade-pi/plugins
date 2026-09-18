/**
 * ELK layered layout, run synchronously in this frame's own thread.
 *
 * The sandboxed view boundary's CSP (`app/src/ui/plugin-frame.html`) has no
 * `worker-src` and falls back to `default-src 'none'`, so `new Worker(...)`
 * throws however it is constructed — blob URL included. `elk-worker.min.js`
 * decides at load time whether it is running inside a real Worker by checking
 * for a `document`; one exists here, so it exports a `Worker`-shaped class
 * that dispatches through `setTimeout` instead of a thread. Handing that to
 * `elk-api.js` as its `workerFactory` gets the same promise-based `.layout()`
 * API with no real Worker anywhere in the chain. This is the ceiling the
 * boundary allows, not a stepping stone toward a real one.
 */
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- no type declarations for the direct worker-shim import
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';

/**
 * Every key below is a real, documented ELK layered option. elkjs silently
 * ignores an unrecognised one rather than erroring, so these were verified by
 * running them, not by trusting the string.
 *
 * `LINEAR_SEGMENTS` rather than `NETWORK_SIMPLEX`: the latter recurses per
 * constraint-graph node in this GWT-compiled build with no tail-call
 * elimination, and a Fuzzy graph is exactly the dense, many-relations shape
 * that overflows the stack.
 */
export const fuzzyLayoutOptions: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'SPLINES',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '26',
  'elk.spacing.edgeEdge': '14',
  'elk.spacing.componentComponent': '80',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '62',
  'elk.layered.spacing.edgeNodeBetweenLayers': '28',
  'elk.layered.thoroughness': '12',
  'elk.layered.unnecessaryBendpoints': 'false',
};

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

export interface ElkPoint { x: number; y: number }
export interface ElkSection {
  startPoint: ElkPoint;
  bendPoints?: ElkPoint[];
  endPoint: ElkPoint;
}
export interface ElkResult {
  children?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  edges?: Array<{ id: string; sections?: ElkSection[] }>;
}
export interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
}

/**
 * Clearance trimmed off each end of a drawn edge, so the arrowhead has room
 * to sit in front of the node instead of half-buried under it.
 *
 * ELK routes to the node's true boundary — it has to, or the ports it spreads
 * across a multi-edge node's edge would spread across a boundary bigger than
 * the node itself, landing edges beside it rather than on it. So the node
 * passed to ELK, and the node drawn, are the same real size; what moves is
 * only the *rendered* path, shortened at both ends by `trimPath` below.
 * Sized for the 13px arrow marker with a little air behind it.
 */
export const NODE_MARGIN = 9;

/**
 * The point half-way along a path *by arc length*, and the path's length.
 *
 * A point that is actually on the drawn curve — unlike an ELK bend point,
 * which is usually a Bézier *control* sitting well off it, and which is why
 * labels used to land on top of nodes. Measured with the browser's own path
 * geometry rather than by re-implementing curve subdivision.
 *
 * `getTotalLength()` on a detached path is measurable in Chrome but has not
 * always been everywhere, so `fallback` — the section endpoints as a polyline
 * — keeps both the anchor and the length approximately right rather than
 * letting the caller's short-edge rule silently stop applying.
 */
export function midpointOf(
  d: string,
  fallback: ElkPoint[] = []
): { x: number; y: number; length: number } {
  if (d) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    try {
      const length = el.getTotalLength();
      if (Number.isFinite(length) && length > 0) {
        const p = el.getPointAtLength(length / 2);
        return { x: p.x, y: p.y, length };
      }
    } catch { /* fall through to the polyline estimate */ }
  }
  return polylineMidpoint(fallback);
}

/** Arc-length midpoint of a polyline — the estimate used when the browser
 * will not measure a detached path. */
export function polylineMidpoint(points: ElkPoint[]): { x: number; y: number; length: number } {
  if (!points.length) return { x: 0, y: 0, length: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y, length: 0 };
  const seg: number[] = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    seg.push(d);
    length += d;
  }
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= length / 2) {
      const t = seg[i] === 0 ? 0 : (length / 2 - acc) / seg[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
        length,
      };
    }
    acc += seg[i];
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y, length };
}

/**
 * Shortens a path by `margin` at each end, for drawing only — ELK's routing
 * and every node position stay exact; only the pixels actually painted move.
 *
 * Resampled as a polyline through evenly spaced points between the two arc
 * lengths, not re-expressed as a shorter Bézier: a curve's endpoint tangent
 * does not survive being cut at an arbitrary arc length without re-solving
 * it, and a visually-identical polyline at typical zoom is a far smaller
 * problem than a wrong tangent would be — React Flow orients the arrowhead
 * off the path's final segment, so that tangent is the one thing here that
 * has to be right.
 */
export function trimPath(d: string, margin: number): string {
  if (!d || margin <= 0) return d;
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  let length: number;
  try { length = el.getTotalLength(); } catch { return d; }
  if (!Number.isFinite(length) || length <= 0) return d;

  // A hop shorter than both margins combined has no room to trim without
  // erasing it; draw it in full rather than disappearing a real relation.
  if (length <= margin * 2 + 1) return d;

  const SAMPLES = 24;
  const from = margin;
  const to = length - margin;
  const points: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const at = from + ((to - from) * i) / SAMPLES;
    const p = el.getPointAtLength(at);
    points.push(`${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`);
  }
  return points.join(' ');
}

export function layout(graph: ElkGraph): Promise<ElkResult> {
  return ensureElk().layout(graph as any) as Promise<ElkResult>;
}

/**
 * Draws ELK `SPLINES` geometry the way ELK encodes it: bend points are cubic
 * Bézier controls and intermediate anchors in `(control, control, anchor)`
 * triples, not points a curve passes through. Reading them as pass-through
 * points is what produces visible spikes.
 */
export function pathFromSections(sections: ElkSection[]): string {
  return sections.map(sectionPath).filter(Boolean).join(' ');
}

function sectionPath(section: ElkSection): string {
  const polyline = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  if (polyline.length < 2) return '';

  const control = [section.startPoint, ...(section.bendPoints ?? [])];
  // ELK sometimes omits the final anchor from bend points, keeping it only in
  // `endPoint`; then the control list ends with two controls.
  if ((control.length - 1) % 3 === 2) control.push(section.endPoint);
  if (control.length >= 4 && (control.length - 1) % 3 === 0) {
    let path = `M ${fmt(control[0])}`;
    for (let i = 1; i < control.length; i += 3) {
      path += ` C ${fmt(control[i])}, ${fmt(control[i + 1])}, ${fmt(control[i + 2])}`;
    }
    return path;
  }
  return `M ${fmt(polyline[0])}` + polyline.slice(1).map((p) => ` L ${fmt(p)}`).join('');
}

function fmt(p: ElkPoint): string {
  return `${p.x} ${p.y}`;
}
