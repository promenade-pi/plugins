import ELK from 'elkjs/lib/elk-api.js';
// The sandboxed plugin frame cannot start a real worker, but ELK's packaged
// worker class still exposes the asynchronous layout API used by React Flow.
// @ts-ignore
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import type { AcceptingPetriNetPayload, Arc, ElkResult, Point, Section } from './types';

export const PLACE_D = 34;
export const TRANS_W = 138;
export const TRANS_H = 38;
export const TAU_W = 11;
export const TAU_H = 30;

/** Same maintained ELK preset used by the OCPN and Petri-net React Flow views. */
export const layoutOptions: Record<string, string> = {
  'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'SPLINES',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.separateConnectedComponents': 'true',
  'elk.spacing.nodeNode': '48', 'elk.spacing.edgeNode': '24', 'elk.spacing.edgeEdge': '16',
  'elk.spacing.componentComponent': '96', 'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX', 'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '40',
  // NETWORK_SIMPLEX placement recurses per constraint-graph node in this
  // GWT-compiled build with no tail-call elimination — a dense net can
  // overflow V8's stack outright (the exact `RangeError` fixed in the
  // sibling ocdfg-flow-view/ocpn-flow-view presets). LINEAR_SEGMENTS is
  // iterative and gives near-identical layouts for the nets this preset
  // actually sees.
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS', 'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.layered.spacing.edgeNodeBetweenLayers': '36',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18', 'elk.layered.thoroughness': '15',
  'elk.layered.unnecessaryBendpoints': 'false',
};

let elk: InstanceType<typeof ELK> | null = null;
function engine() { return elk ??= new ELK({ workerFactory: () => new ElkSyncWorker() }); }

export function labelOf(net: AcceptingPetriNetPayload, transition: number) {
  return Array.isArray(net.labels) ? net.labels[transition] ?? null : String(transition);
}

export function buildGraph(net: AcceptingPetriNetPayload) {
  const children: Array<{ id: string; width: number; height: number }> = (net.places ?? []).map((_, i) => ({ id: `p${i}`, width: PLACE_D, height: PLACE_D }));
  for (const id of [...(net.activities ?? [])].sort((a, b) => a - b)) {
    const visible = labelOf(net, id) != null;
    children.push({ id: `t${id}`, width: visible ? TRANS_W : TAU_W, height: visible ? TRANS_H : TAU_H });
  }
  const valid = new Set(children.map((node) => node.id));
  const arcs: Arc[] = [];
  for (const [i, [p, t]] of (net.place_to_transition ?? []).entries()) {
    const source = `p${p}`, target = `t${t}`;
    if (valid.has(source) && valid.has(target)) arcs.push({ id: `pt-${p}-${t}-${i}`, source, target });
  }
  for (const [i, [t, p]] of (net.transition_to_place ?? []).entries()) {
    const source = `t${t}`, target = `p${p}`;
    if (valid.has(source) && valid.has(target)) arcs.push({ id: `tp-${t}-${p}-${i}`, source, target });
  }
  return { graph: { id: 'root', layoutOptions, children, edges: arcs.map((a) => ({ id: a.id, sources: [a.source], targets: [a.target] })) }, arcs };
}

export function layout(graph: unknown) { return engine().layout(graph as any) as Promise<ElkResult>; }

function lerp(a: Point, b: Point, t: number): Point { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const ab = lerp(a, b, t), bc = lerp(b, c, t), cd = lerp(c, d, t);
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t);
}

/**
 * Decodes the cubic spline controls emitted by ELK. The same geometry feeds
 * both the SVG BaseEdge and the Canvas particle layer — no straight-line
 * approximation causes particles to leave their edge route.
 */
export function pathAndSamples(sections: Section[], density = 18) {
  const commands: string[] = [];
  const points: Point[] = [];
  for (const section of sections) {
    const control = [section.startPoint, ...(section.bendPoints ?? [])];
    if ((control.length - 1) % 3 === 2) control.push(section.endPoint);
    if (control.length >= 4 && (control.length - 1) % 3 === 0) {
      commands.push(`M ${control[0].x} ${control[0].y}`);
      if (!points.length) points.push(control[0]);
      for (let i = 1; i < control.length; i += 3) {
        commands.push(`C ${control[i].x} ${control[i].y}, ${control[i + 1].x} ${control[i + 1].y}`);
        for (let step = 1; step <= density; step++) points.push(cubic(control[i - 1], control[i], control[i + 1], control[i + 2], step / density));
      }
    } else {
      const line = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      commands.push(`M ${line[0].x} ${line[0].y}` + line.slice(1).map((p) => ` L ${p.x} ${p.y}`).join(''));
      if (!points.length) points.push(line[0]);
      points.push(...line.slice(1));
    }
  }
  return { path: commands.join(' '), samples: points };
}

export function pointAt(points: Point[], progress: number) {
  if (!points.length) return { x: 0, y: 0 };
  const p = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const i = Math.floor(p);
  return i === points.length - 1 ? points[i] : lerp(points[i], points[i + 1], p - i);
}
