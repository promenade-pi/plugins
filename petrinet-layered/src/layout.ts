import ELK from 'elkjs/lib/elk-api.js';
// The sandboxed plugin frame cannot create a real worker. ELK's bundled
// worker class still provides the asynchronous layout API in that context.
// @ts-ignore -- elkjs does not publish declarations for this entry point
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';
import type { AcceptingPetriNetPayload } from './types';

export const PLACE_D = 28;
export const TRANS_W = 130;
export const TRANS_H = 34;
/** Narrow, solid tau bar — its layout box deliberately has no extra gutter. */
export const SILENT_W = 12;
export const SILENT_H = 28;

/** Which way the net flows: left-to-right (the default) or top-to-bottom. */
export type FlowDirection = 'RIGHT' | 'DOWN';

/**
 * A silent transition's bar is drawn across the flow, the way Petri-net
 * notation always draws it — so its long side follows the layer, not the
 * direction of travel. A labelled transition is a box whose long side is
 * already the layer's, so only the bar has to turn.
 */
export function silentSize(direction: FlowDirection): { width: number; height: number } {
  return direction === 'DOWN'
    ? { width: SILENT_H, height: SILENT_W }
    : { width: SILENT_W, height: SILENT_H };
}

/** Exactly the maintained OCPN React-Flow layered preset. */
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
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
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

export interface PetriArc { id: string; source: string; target: string; }
export interface ElkPoint { x: number; y: number; }
export interface ElkSection { startPoint: ElkPoint; bendPoints?: ElkPoint[]; endPoint: ElkPoint; }
export interface ElkResult {
  children?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  edges?: Array<{ id: string; sections?: ElkSection[] }>;
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

export function labelOf(net: AcceptingPetriNetPayload, transition: number): string | null {
  return Array.isArray(net.labels) ? (net.labels[transition] ?? null) : `#${transition}`;
}

export function buildElkGraph(
  net: AcceptingPetriNetPayload,
  direction: FlowDirection = 'RIGHT',
): { graph: ElkGraph; arcs: PetriArc[] } {
  const children: ElkGraph['children'] = (net.places ?? []).map((_, index) => ({ id: `p${index}`, width: PLACE_D, height: PLACE_D }));
  for (const transition of [...(net.activities ?? [])].sort((a, b) => a - b)) {
    const size = labelOf(net, transition) == null ? silentSize(direction) : { width: TRANS_W, height: TRANS_H };
    children.push({ id: `t${transition}`, ...size });
  }
  const nodeIds = new Set(children.map((node) => node.id));
  const arcs: PetriArc[] = [];
  for (const [index, [place, transition]] of (net.place_to_transition ?? []).entries()) {
    const source = `p${place}`, target = `t${transition}`;
    if (nodeIds.has(source) && nodeIds.has(target)) arcs.push({ id: `pt-${place}-${transition}-${index}`, source, target });
  }
  for (const [index, [transition, place]] of (net.transition_to_place ?? []).entries()) {
    const source = `t${transition}`, target = `p${place}`;
    if (nodeIds.has(source) && nodeIds.has(target)) arcs.push({ id: `tp-${transition}-${place}-${index}`, source, target });
  }
  return {
    graph: {
      id: 'root', layoutOptions: layoutOptionsFor(direction), children,
      edges: arcs.map((arc) => ({ id: arc.id, sources: [arc.source], targets: [arc.target] })),
    },
    arcs,
  };
}

export function layoutPetriNet(graph: ElkGraph): Promise<ElkResult> {
  return ensureElk().layout(graph as any) as Promise<ElkResult>;
}

/** Decodes ELK spline controls, not merely their visual bend points. */
export function pathFromSections(sections: ElkSection[]): string {
  return sections.map(sectionPath).filter(Boolean).join(' ');
}

function sectionPath(section: ElkSection): string {
  const polyline = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  if (polyline.length < 2) return '';
  const control = [section.startPoint, ...(section.bendPoints ?? [])];
  if ((control.length - 1) % 3 === 2) control.push(section.endPoint);
  if (control.length >= 4 && (control.length - 1) % 3 === 0) {
    let path = `M ${point(control[0])}`;
    for (let index = 1; index < control.length; index += 3) {
      path += ` C ${point(control[index])}, ${point(control[index + 1])}, ${point(control[index + 2])}`;
    }
    return path;
  }
  return `M ${point(polyline[0])}` + polyline.slice(1).map((p) => ` L ${point(p)}`).join('');
}

function point({ x, y }: ElkPoint) { return `${x} ${y}`; }
