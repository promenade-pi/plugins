/**
 * ELK graph construction and layout, run entirely synchronously in this
 * frame's own thread.
 *
 * The sandboxed view boundary's CSP has no `worker-src`, which falls back to
 * `default-src 'none'` — `new Worker(...)` throws regardless of how it's
 * constructed. `elkjs/lib/elk-worker.min.js` detects `typeof document !==
 * 'undefined'` and, finding one here (a normal, if sandboxed, iframe
 * document), exports a `Worker`-shaped class that dispatches through
 * `setTimeout` instead of a real thread. Handing that to `elk-api.js` as its
 * `workerFactory` gives the same promise-based `.layout()` API with no real
 * Worker anywhere in the chain — the identical trick `ocpn-flow-view` and
 * `ocim-rs`'s view use for the same CSP reason.
 */
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- no type declarations for the direct worker-shim import
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import type { BpmnPayload } from './types';

export const TASK_W = 120;
export const TASK_H = 56;
export const GATEWAY_D = 42;
export const EVENT_D = 36;

/**
 * Orthogonal routing is the idiomatic BPMN look (bpmn.io and every other
 * mainstream BPMN tool draw rectilinear connectors, not splines) — unlike
 * `ocpn-flow-view`'s Petri-net rendering, which follows classical Petri-net
 * drawing convention instead.
 */
export const bpmnLayoutOptions: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',

  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '14',

  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',

  // See `ocpn-flow-view/src/layout.ts`: NETWORK_SIMPLEX node placement
  // recurses per constraint-graph node with no tail-call elimination in
  // this GWT-compiled build, and can overflow the stack on a dense graph.
  // LINEAR_SEGMENTS is iterative and visually near-identical for the
  // graph sizes a BPMN diagram actually reaches.
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',

  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',

  'elk.layered.thoroughness': '15',
};

/** Same reasoning as `ocpn-flow-view`'s `LAYOUT_EDGE_LIMIT`: a size guard
 * against the single-threaded synchronous layout hanging the tab. */
export const LAYOUT_EDGE_LIMIT = 1500;

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

function sizeOf(kind: BpmnPayload['nodes'][number]['kind']): { width: number; height: number } {
  if (kind === 'task') return { width: TASK_W, height: TASK_H };
  if (kind === 'startEvent' || kind === 'endEvent') return { width: EVENT_D, height: EVENT_D };
  return { width: GATEWAY_D, height: GATEWAY_D };
}

export function buildElkGraph(bpmn: BpmnPayload): ElkGraph {
  const children = bpmn.nodes.map((n) => ({ id: n.id, ...sizeOf(n.kind) }));
  const edges = bpmn.flows.map((f) => ({ id: f.id, sources: [f.source], targets: [f.target] }));
  return { id: 'root', layoutOptions: bpmnLayoutOptions, children, edges };
}

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

export function layoutBpmn(graph: ElkGraph): Promise<ElkResult> {
  return ensureElk().layout(graph as any) as Promise<ElkResult>;
}

/** Draws ELK `ORTHOGONAL` geometry: a plain polyline through every bend
 * point, unlike `ocpn-flow-view`'s spline-control decoding (that shape is
 * specific to `SPLINES` routing, which this view does not use). */
export function pathFromSections(sections: ElkSection[]): string {
  return sections.map(sectionPath).filter(Boolean).join(' ');
}

function sectionPath(section: ElkSection): string {
  const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  if (points.length < 2) return '';
  return `M ${fmt(points[0])}` + points.slice(1).map((p) => ` L ${fmt(p)}`).join('');
}

function fmt(p: ElkPoint): string {
  return `${p.x} ${p.y}`;
}
