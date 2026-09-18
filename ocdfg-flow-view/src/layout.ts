import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- elkjs exposes this Worker-shaped synchronous shim without declarations.
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import type { OcdfgEdge, OcdfgNode } from './types';

export const ACTIVITY_W = 154;
export const ACTIVITY_H = 52;
export const BOUNDARY_D = 29;

/** Which way the process flows: left-to-right (the default) or top-to-bottom. */
export type FlowDirection = 'RIGHT' | 'DOWN';

export const BOUNDARY_LABEL_MAX_W = 130;

/**
 * A boundary marker's object-type label is drawn outside its 29px circle, so
 * in a top-to-bottom layout — where siblings in a layer sit side by side —
 * the label, not the circle, is what decides whether two markers collide.
 * Reserving the label's width as the node's own width lets ELK space them on
 * what is actually drawn. The circle stays centred in that box, so the
 * top/bottom edge anchors ELK routes to are still the circle's own.
 * Left-to-right stacks a layer vertically instead, where a ~14px label under
 * a circle clears the 48px in-layer spacing on its own.
 */
export function boundaryWidth(objectType: string, direction: FlowDirection): number {
  if (direction !== 'DOWN') return BOUNDARY_D;
  return Math.max(BOUNDARY_D, Math.min(BOUNDARY_LABEL_MAX_W, objectType.length * 6.6 + 4));
}

/**
 * Intentionally identical to the OCPN React Flow view's layered preset.
 * Keeping the two object-centric renderers on the same spacing, routing,
 * crossing-minimisation and placement settings makes their layouts directly
 * comparable rather than attributing differences to two unrelated presets.
 */
export const ocpnLayoutOptions: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.nodeNode': '48',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.spacing.componentComponent': '96',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '40',
  /**
   * NETWORK_SIMPLEX placement recurses per constraint-graph node in this
   * GWT-compiled build of ELK, with no tail-call elimination — dense real
   * OC-DFGs (many object types sharing activity pairs) blow past V8's stack
   * well before they'd be slow, throwing an uncaught `RangeError` deep
   * inside elkjs with no plugin-visible hook to catch or degrade from.
   * LINEAR_SEGMENTS is iterative and produces near-identical layouts for the
   * graphs this preset actually sees; a size guard in plugin.tsx covers the
   * far larger graphs where LINEAR_SEGMENTS itself would just be slow
   * instead of crashing.
   */
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.layered.spacing.edgeNodeBetweenLayers': '36',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
  'elk.layered.thoroughness': '15',
  'elk.layered.unnecessaryBendpoints': 'false',
};

/** The shared preset, pointed whichever way the view is currently flowing. */
export function layoutOptionsFor(direction: FlowDirection): Record<string, string> {
  return { ...ocpnLayoutOptions, 'elk.direction': direction };
}

export interface ElkPoint { x: number; y: number }
export interface ElkSection { startPoint: ElkPoint; bendPoints?: ElkPoint[]; endPoint: ElkPoint }
export interface ElkResult {
  children?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  edges?: Array<{ id: string; sections?: ElkSection[] }>;
}

export type FlowNode =
  | { id: string; kind: 'activity'; activity: string }
  | { id: string; kind: 'source' | 'sink'; objectType: string };

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * One entry per object type this arc carries. Always length 1 unless
   * `combineParallel` merged several object types' directly-follows arcs
   * between the same activity pair into one routed edge.
   */
  types: Array<{ objectType: string; freq: number }>;
  kind: 'directly-follows' | 'start' | 'end';
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
}

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

export function edgeId(edge: OcdfgEdge): string {
  return JSON.stringify(['directly-follows', edge.objectType, edge.src, edge.dst]);
}

function combinedEdgeId(src: string, dst: string): string {
  return JSON.stringify(['directly-follows', src, dst]);
}

export function sourceId(objectType: string): string {
  return JSON.stringify(['source', objectType]);
}

export function sinkId(objectType: string): string {
  return JSON.stringify(['sink', objectType]);
}

function startEdgeId(objectType: string, activity: string): string {
  return JSON.stringify(['start', objectType, activity]);
}

function endEdgeId(objectType: string, activity: string): string {
  return JSON.stringify(['end', objectType, activity]);
}

/**
 * Turns the compact OC-DFG payload into a render graph. A source and sink
 * are per object type (not per activity): their outgoing/incoming edges are
 * the `starts` and `ends` counts discovered for that typed activity.
 *
 * When `combineParallel` is set, directly-follows arcs between the same pair
 * of activities are merged into a single routed edge carrying every object
 * type that makes the trip — one ELK edge instead of one per type, so the
 * layout no longer bundles near-identical parallel splines. Start/end arcs
 * are never merged: their source/sink nodes are already per object type, so
 * two of them never share an id to merge under.
 */
export function buildFlowGraph(nodes: OcdfgNode[], edges: OcdfgEdge[], combineParallel = false): FlowGraph {
  const activityNodes: FlowNode[] = [...new Set(nodes.map((node) => node.activity))]
    .sort()
    .map((activity) => ({ id: activity, kind: 'activity', activity }));
  const visibleActivities = new Set(activityNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleActivities.has(edge.src) && visibleActivities.has(edge.dst));

  let flowEdges: FlowEdge[];
  if (combineParallel) {
    const groups = new Map<string, FlowEdge>();
    for (const edge of visibleEdges) {
      const id = combinedEdgeId(edge.src, edge.dst);
      const group = groups.get(id) ?? { id, source: edge.src, target: edge.dst, kind: 'directly-follows', types: [] };
      group.types.push({ objectType: edge.objectType, freq: edge.freq });
      groups.set(id, group);
    }
    for (const group of groups.values()) group.types.sort((a, b) => a.objectType.localeCompare(b.objectType));
    flowEdges = [...groups.values()];
  } else {
    flowEdges = visibleEdges.map((edge) => ({
      id: edgeId(edge), source: edge.src, target: edge.dst,
      types: [{ objectType: edge.objectType, freq: edge.freq }], kind: 'directly-follows',
    }));
  }

  const boundaryNodes = new Map<string, FlowNode>();
  for (const node of nodes) {
    if (node.starts > 0) {
      const id = sourceId(node.objectType);
      boundaryNodes.set(id, { id, kind: 'source', objectType: node.objectType });
      flowEdges.push({
        id: startEdgeId(node.objectType, node.activity), source: id, target: node.activity,
        types: [{ objectType: node.objectType, freq: node.starts }], kind: 'start',
      });
    }
    if (node.ends > 0) {
      const id = sinkId(node.objectType);
      boundaryNodes.set(id, { id, kind: 'sink', objectType: node.objectType });
      flowEdges.push({
        id: endEdgeId(node.objectType, node.activity), source: node.activity, target: id,
        types: [{ objectType: node.objectType, freq: node.ends }], kind: 'end',
      });
    }
  }

  return {
    nodes: [...activityNodes, ...[...boundaryNodes.values()].sort((a, b) => a.id.localeCompare(b.id))],
    edges: flowEdges.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** A deterministic ELK graph: activity labels and typed edges are sorted. */
export function buildElkGraph(graph: FlowGraph, direction: FlowDirection = 'RIGHT'): ElkGraph {
  const children = graph.nodes.map((node) => ({
    id: node.id,
    width: node.kind === 'activity' ? ACTIVITY_W : boundaryWidth(node.objectType, direction),
    height: node.kind === 'activity' ? ACTIVITY_H : BOUNDARY_D,
  }));
  return {
    id: 'root', layoutOptions: layoutOptionsFor(direction), children,
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

export function layoutOcdfg(graph: ElkGraph): Promise<ElkResult> {
  return ensureElk().layout(graph as any) as Promise<ElkResult>;
}

/**
 * Draw ELK SPLINES with ELK's own cubic Bézier control-point convention.
 * Its bend points form `(control, control, anchor)` triples; treating them
 * as Catmull–Rom pass-through points causes sharp overshoot spikes.
 * Invalid/incomplete spline data falls back to its exact polyline.
 */
export function pathFromSections(sections: ElkSection[]): string {
  return sections.map((section) => {
    const polyline = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    if (polyline.length < 2) return '';
    const control = [section.startPoint, ...(section.bendPoints ?? [])];
    if ((control.length - 1) % 3 === 2) control.push(section.endPoint);
    if (control.length >= 4 && (control.length - 1) % 3 === 0) {
      let path = `M ${fmt(control[0])}`;
      for (let i = 1; i < control.length; i += 3) {
        path += ` C ${fmt(control[i])}, ${fmt(control[i + 1])}, ${fmt(control[i + 2])}`;
      }
      return path;
    }
    return `M ${fmt(polyline[0])}` + polyline.slice(1).map((point) => ` L ${fmt(point)}`).join('');
  }).filter(Boolean).join(' ');
}

function fmt(point: ElkPoint) { return `${point.x} ${point.y}`; }
