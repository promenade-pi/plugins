import { forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY } from 'd3-force';
import type { TotemPayload } from './types';

export interface LaidOutNode { id: string; x: number; y: number; }

/**
 * A one-shot, force-directed initial layout — the JS equivalent of the
 * reference implementation's Graphviz `sfdp` (see `totem.py`'s
 * `TOTEM_GRAPH_LAYOUT`): spread nodes apart by mutual repulsion and edge
 * springs, not a hierarchy. Runs synchronously (no animation, no requestAnimationFrame)
 * so the graph appears already-settled on first paint; the user drags nodes
 * from there, same as any other React Flow view.
 *
 * `d3-force` never touches a Worker or does I/O, so — unlike elkjs elsewhere
 * in these plugins — there is no sandboxed-CSP trick needed here at all.
 */
export function forceLayout(net: TotemPayload): Map<string, LaidOutNode> {
  const nodes = net.objectTypes.map((id) => ({ id, x: 0, y: 0 }));
  const links = net.edges.map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(nodes as any)
    .force('link', forceLink(links as any).id((d: any) => d.id).distance(220).strength(0.5))
    .force('charge', forceManyBody().strength(-900).distanceMax(900))
    .force('collide', forceCollide(90))
    .force('center', forceCenter(0, 0))
    .force('x', forceX(0).strength(0.02))
    .force('y', forceY(0).strength(0.02))
    .stop();

  const iterations = 400;
  for (let i = 0; i < iterations; i++) sim.tick();

  const out = new Map<string, LaidOutNode>();
  for (const n of nodes as unknown as Array<{ id: string; x: number; y: number }>) {
    out.set(n.id, { id: n.id, x: n.x, y: n.y });
  }
  return out;
}
