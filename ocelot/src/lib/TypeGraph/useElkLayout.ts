/**
 * ELK layered layout, run entirely synchronously in this frame's own thread.
 *
 * Copied from `plugins/ocpn-flow-view/src/layout.ts`'s worker-shim trick: the
 * sandboxed view boundary's CSP has no `worker-src` (falls back to
 * `default-src 'none'`), so `new Worker(...)` throws regardless of how it's
 * constructed. `elkjs/lib/elk-worker.min.js` decides at load time whether
 * it's inside a real Worker by checking `typeof document === 'undefined'`; a
 * document exists in this sandboxed iframe too, so it takes the same branch
 * Node does and exports a `Worker`-shaped class that dispatches through
 * `setTimeout` instead of a thread. Handing that class to `elk-api.js` as its
 * `workerFactory` gets the same promise-based `.layout()` API with no real
 * Worker anywhere in the chain — this is the ceiling this boundary allows,
 * not a stepping stone to a real one.
 *
 * Unlike the OCPN renderer, this only needs ELK for *node placement* — plain
 * type-graph edges are drawn with React Flow's own bezier/smoothstep
 * renderers, so there's no bend-point/spline decoding to replicate here.
 */
import { useEffect, useState } from 'react';
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- no type declarations for the direct worker-shim import
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';

/**
 * Past this many edges, ELK's `NETWORK_SIMPLEX` node placement (recursive,
 * no tail-call elimination in this GWT-compiled build) risks a stack
 * overflow on this single synchronous thread — same guard as
 * `ocpn-flow-view`'s `LAYOUT_EDGE_LIMIT`, tuned for a type graph's much
 * smaller node/edge counts.
 */
export const LAYOUT_EDGE_LIMIT = 1500;

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

export interface LayoutNode { id: string; width: number; height: number }
export interface LayoutEdge { id: string; source: string; target: string }
export interface PositionedNode { id: string; x: number; y: number; width: number; height: number }

const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',
  'elk.spacing.nodeNode': '48',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  // LINEAR_SEGMENTS, not NETWORK_SIMPLEX: iterative rather than recursive,
  // so it can't stack-overflow on a dense graph — see LAYOUT_EDGE_LIMIT.
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.thoroughness': '10',
};

/**
 * Lays out a flat type graph (object types, event types — never more than a
 * few dozen nodes) and returns final top-left positions, or `null` while
 * layout is running / for an empty graph. Nodes with no edges at all are
 * laid out separately in a wrapping grid (ELK's layered algorithm has
 * nothing to place them relative to), matching Ocelot's own fallback when a
 * filter leaves no relations to draw.
 */
export function useElkLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, PositionedNode> | null {
  const [result, setResult] = useState<Map<string, PositionedNode> | null>(null);
  const nodeKey = nodes.map((n) => `${n.id}:${n.width}x${n.height}`).join('|');
  const edgeKey = edges.map((e) => `${e.source}>${e.target}`).join('|');

  useEffect(() => {
    if (nodes.length === 0) { setResult(new Map()); return; }
    if (edges.length === 0) { setResult(new Map(layoutGrid(nodes))); return; }
    if (edges.length > LAYOUT_EDGE_LIMIT) { setResult(new Map(layoutGrid(nodes))); return; }

    let cancelled = false;
    const graph = {
      id: 'root',
      layoutOptions: LAYOUT_OPTIONS,
      children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    ensureElk().layout(graph as any).then((laidOut: any) => {
      if (cancelled) return;
      const positions = new Map<string, PositionedNode>();
      for (const child of laidOut.children ?? []) {
        positions.set(child.id, { id: child.id, x: child.x, y: child.y, width: child.width, height: child.height });
      }
      setResult(positions);
    }).catch(() => {
      if (!cancelled) setResult(new Map(layoutGrid(nodes)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, edgeKey]);

  return result;
}

/** A plain wrapping grid — used when there's nothing to run ELK against. */
function layoutGrid(nodes: LayoutNode[]): Array<[string, PositionedNode]> {
  const COLS = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const GAP_X = 40, GAP_Y = 40;
  const colWidths: number[] = [];
  const rowHeights: number[] = [];
  nodes.forEach((n, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    colWidths[col] = Math.max(colWidths[col] ?? 0, n.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, n.height);
  });
  const colX: number[] = [0];
  for (let c = 1; c <= COLS; c++) colX[c] = colX[c - 1] + (colWidths[c - 1] ?? 0) + GAP_X;
  const rowY: number[] = [0];
  const rows = Math.ceil(nodes.length / COLS);
  for (let r = 1; r <= rows; r++) rowY[r] = rowY[r - 1] + (rowHeights[r - 1] ?? 0) + GAP_Y;

  return nodes.map((n, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    return [n.id, { id: n.id, x: colX[col], y: rowY[row], width: n.width, height: n.height }];
  });
}
