/**
 * The 2D ground plan, laid out by ELK, run synchronously in this frame.
 *
 * The third dimension of this view carries performance, and only performance.
 * Inventing a free 3D graph layout would spend the z axis on aesthetics and
 * leave nothing to read the friction off, so the plan is a perfectly ordinary
 * layered process layout - the same one a 2D directly-follows graph would get
 * - and elevation is derived from the log afterwards. Two analysts looking at
 * the same log therefore get the same map, and the map is comparable with the
 * 2D model they already know.
 *
 * The sandboxed view boundary's CSP (`app/src/ui/plugin-frame.html`) has no
 * `worker-src` and falls back to `default-src 'none'`, so `new Worker(...)`
 * throws however it is constructed, blob URL included. `elk-worker.min.js`
 * decides at load time whether it is inside a real Worker by looking for a
 * `document`; one exists here, so it exports a `Worker`-shaped class that
 * dispatches through `setTimeout` instead of a thread. Handing that to
 * `elk-api.js` as its `workerFactory` gets the same promise-based `.layout()`
 * with no real Worker anywhere in the chain.
 */
import ELK from 'elkjs/lib/elk-api.js';
// @ts-ignore -- no type declarations for the direct worker-shim import
import { Worker as ElkSyncWorker } from 'elkjs/lib/elk-worker.min.js';

import { edgeKey, type FilteredModel } from './model';
import { dedupe, PLAN_FIT, type Plan, type PlanEdge, type PlanNode, type Point } from './path';

export type { Plan, PlanEdge, PlanNode, Point } from './path';
export { smoothPath } from './path';

const NODE_W = 150;
const NODE_H = 60;

/**
 * Every key below is a real, documented ELK layered option; elkjs silently
 * ignores an unrecognised one rather than erroring, so these were checked by
 * running them.
 *
 * `POLYLINE` rather than `SPLINES`: the routed polyline is resampled and
 * projected onto the terrain, and a spline's control points are not on the
 * curve, so treating them as path points bends the drawn stream away from
 * where ELK actually routed it.
 */
const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'POLYLINE',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.nodeNode': '70',
  'elk.spacing.edgeNode': '34',
  'elk.spacing.edgeEdge': '18',
  'elk.spacing.componentComponent': '110',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '130',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.layered.thoroughness': '10',
  'elk.layered.unnecessaryBendpoints': 'false',
};

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkSyncWorker() });
  return elk;
}

/** Node ids have to survive ELK, which is unhappy with arbitrary text. */
function idOf(index: number): string {
  return `n${index}`;
}

/**
 * How much later in a case the target step normally happens than the source,
 * for a flow to count as rework.
 *
 * Half a step: enough to ignore two activities that genuinely interleave, small
 * enough to catch a real loop back to the immediately preceding step.
 */
const REWORK_MARGIN = 0.5;

export async function layoutPlan(model: FilteredModel): Promise<Plan> {
  const names = model.activities.map((a) => a.activity);
  const medianPos = new Map(model.activities.map((a) => [a.activity, a.medianPos]));
  const indexOf = new Map(names.map((name, i) => [name, i]));

  const graph = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: names.map((_, i) => ({ id: idOf(i), width: NODE_W, height: NODE_H })),
    edges: model.edges.map((e) => ({
      id: `e${indexOf.get(e.source)}_${indexOf.get(e.target)}`,
      sources: [idOf(indexOf.get(e.source)!)],
      targets: [idOf(indexOf.get(e.target)!)],
    })),
  };

  const result: any = await ensureElk().layout(graph as any);

  const raw = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    const index = Number(String(child.id).slice(1));
    const name = names[index];
    if (name == null) continue;
    raw.set(name, { x: (child.x ?? 0) + NODE_W / 2, y: (child.y ?? 0) + NODE_H / 2 });
  }
  // A disconnected activity gets no placement worth trusting; park it in a
  // trailing column rather than at the origin, where it would sit on top of
  // whatever ELK put there.
  let parked = 0;
  const width = Math.max(1, result.width ?? 1);
  const height = Math.max(1, result.height ?? 1);
  for (const name of names) {
    if (raw.has(name)) continue;
    raw.set(name, { x: width + 140, y: 40 + parked * (NODE_H + 60) });
    parked++;
  }

  const xs = [...raw.values()].map((p) => p.x);
  const ys = [...raw.values()].map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const aspect = spanX / spanY;

  /**
   * A long, thin process is turned to run across the plate's diagonal.
   *
   * Layered layout of a mostly sequential process is always much wider than it
   * is deep, and the terrain it has to live on is square. Left axis-aligned,
   * such a plan uses a narrow band across the middle and pushes its own
   * mountains off the near and far rims, while two thirds of the plate stay
   * empty. The square's diagonal is 41% longer than its side, so a rigid
   * rotation buys real room - and it is a rotation, not a stretch: no distance
   * on the map changes, so nothing about the terrain's meaning does either.
   */
  const angle = aspect >= 1.5 ? -Math.PI * 0.17 : 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const rotate = (p: { x: number; y: number }) => {
    const cx = p.x - minX - spanX / 2;
    const cy = p.y - minY - spanY / 2;
    return { x: cx * cos - cy * sin, y: cx * sin + cy * cos };
  };

  // Fit the rotated plan inside a margin, rather than filling the plate to its
  // edge. The margin is where the interpolated skirts of the border stations
  // go; without it the rim window (see `field.ts`) slices a mountain in half,
  // which reads as the process continuing past the edge of the picture.
  const rotated = [...raw.values()].map(rotate);
  const reach = Math.max(
    1e-6,
    ...rotated.map((p) => Math.abs(p.x)),
    ...rotated.map((p) => Math.abs(p.y))
  );
  const fit = PLAN_FIT / reach;

  const project = (p: { x: number; y: number }): Point => {
    const r = rotate(p);
    return { x: r.x * fit, y: r.y * fit };
  };

  const layers = [...new Set([...raw.values()].map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const rankOfX = new Map(layers.map((x, i) => [x, i]));

  const nodes: PlanNode[] = names.map((name) => {
    const point = raw.get(name)!;
    const projected = project(point);
    return {
      activity: name,
      x: projected.x,
      y: projected.y,
      rank: rankOfX.get(Math.round(point.x)) ?? 0,
    };
  });
  const byActivity = new Map(nodes.map((n) => [n.activity, n]));
  const rank = new Map(nodes.map((n) => [n.activity, n.rank]));

  const routed = new Map<string, Point[]>();
  for (const edge of result.edges ?? []) {
    const sections = edge.sections ?? [];
    if (!sections.length) continue;
    const points: Point[] = [];
    for (const section of sections) {
      if (section.startPoint) points.push(project(section.startPoint));
      for (const bend of section.bendPoints ?? []) points.push(project(bend));
      if (section.endPoint) points.push(project(section.endPoint));
    }
    routed.set(String(edge.id), points);
  }

  const edges: PlanEdge[] = model.edges.map((e) => {
    const id = `e${indexOf.get(e.source)}_${indexOf.get(e.target)}`;
    const from = byActivity.get(e.source)!;
    const to = byActivity.get(e.target)!;
    const points = routed.get(id) ?? [];
    // Always anchor on the node centres: ELK routes to the node *border*, and
    // a stream that stops short of the station it feeds looks like a break in
    // the process rather than a hand-off.
    const path: Point[] = [
      { x: from.x, y: from.y },
      ...points.slice(1, Math.max(1, points.length - 1)),
      { x: to.x, y: to.y },
    ];
    // Rework is read off the *log*, not off the layout. ELK breaks a cycle by
    // reversing whichever arc its greedy heuristic reaches first, which on an
    // order-to-delivery process routinely nominates the busiest forward
    // hand-off as the back edge - and then the map labels the main line
    // "rework". The log already knows how far into a case each step normally
    // happens, so a flow is rework when it lands somewhere the process has
    // usually already been.
    const fromPos = medianPos.get(e.source);
    const toPos = medianPos.get(e.target);
    const backward = fromPos != null && toPos != null
      ? toPos < fromPos - REWORK_MARGIN
      : to.rank < from.rank;
    return {
      source: e.source,
      target: e.target,
      key: edgeKey(e.source, e.target),
      points: dedupe(path),
      backward,
    };
  });

  return { nodes, edges, byActivity, rank, aspect };
}
