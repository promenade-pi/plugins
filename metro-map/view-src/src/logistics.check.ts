import fixture from './fixtures/logistics.json';
import { dfgFilter } from './complexity';
import {
  chamferCorners, countCrossings, findOverlaps, nodeIntersections,
  peakTrackDemand, refineDrawing, relayoutVisible, routeAll, toRoutingNode,
} from 'metro-layout';
import type { MetroMapPayload, StationStyle } from './types';

const map = fixture as MetroMapPayload;
function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

// Exported from the user's Logistics workspace, frequency rank tie-break.
// Test exactly the same filter, node footprints and final corner cuts as UI.
for (const preserveStability of [true, false]) {
  for (const style of ['dots', 'labels'] as StationStyle[]) {
    for (const [detail, expected] of [[2, 14], [6, 38]]) {
      const label = `Logistics ${expected}/77 ${style} ${preserveStability ? 'stable' : 'fresh'}`;
      const filter = dfgFilter(map.nodes, map.edges, detail);
      const edges = map.edges.filter(e => filter.keptEdgeIds.has(e.id));
      const nodes = map.nodes.filter(n => filter.keptNodeIds.has(n.id));
      assert(edges.length === expected, `${label}: filter changed`);
      const layout = relayoutVisible(nodes, edges, { preserveStability });
      const rn = nodes.map(n => toRoutingNode({ ...n, rank: layout.rank.get(n.id)!, lane: layout.lane.get(n.id)! }, style));
      const re = edges.map(e => ({ ...e, waypoints: layout.waypoints.get(e.id) ?? [] }));
      const before = JSON.stringify({ rn, re });
      const pitch = Math.max(style === 'dots' ? 104 : 176, (peakTrackDemand(rn, re) - 1) * 15 + 24);
      const routed = routeAll(rn, re, { laneX: l => l * pitch, pitch, spacing: 15, minChannel: style === 'dots' ? 84 : 96 });
      const drawing = refineDrawing(rn, re, routed, pitch);
      assert(before === JSON.stringify({ rn, re }), `${label}: mutated ranked layout`);
      const drawn = new Map([...drawing.points].map(([id, ps]) => [id, chamferCorners(ps, drawing.chamferCuts.get(id)!)]));
      const hits = nodeIntersections(rn, re, drawn, drawing.nodeX, routed.rowY);
      assert(!hits.length, `${label}: node intersections ${JSON.stringify(hits)}`);
      const byEdge = new Map(re.map(e => [e.id, e]));
      const byNode = new Map(rn.map(n => [n.id, n]));
      const mayMerge = (a: string, b: string) => {
        const ea = byEdge.get(a)!, eb = byEdge.get(b)!;
        // Explicit gateway branches and rework loops may never bundle.
        return ea.objectType === eb.objectType && [ea, eb].every(e => !byNode.get(e.source)!.gateway && !byNode.get(e.target)!.gateway && byNode.get(e.source)!.rank < byNode.get(e.target)!.rank);
      };
      const overlaps = findOverlaps(drawn, mayMerge, 4);
      // No baselined exemption any more. Three straight-track collisions used
      // to survive refinement in fresh/dots 38/77 and were listed here as a
      // narrow, measured allowance; ALAP start markers removed all three, so
      // every one of these eight pipelines is now asserted overlap-free
      // outright. Should they ever come back, this is where it shows.
      const known: ReadonlyArray<readonly [string, string, number]> = [];
      assert(overlaps.length <= known.length && overlaps.every(o => o.axis === 'v' && known.some(([a, b, length]) => o.a === a && o.b === b && o.span[1] - o.span[0] <= length)), `${label}: new/worse drawn overlaps ${JSON.stringify(overlaps.slice(0, 4))}`);
      // Moving a source tail must not invert its established layer order.
      for (const a of rn) for (const b of rn) {
        if (a.rank === b.rank && a.lane < b.lane) assert(drawing.nodeX.get(a.id)! < drawing.nodeX.get(b.id)!, `${label}: inverted node order`);
      }
      if (preserveStability && style === 'dots' && detail === 2) {
        for (const [source, target] of [['station:Collect Goods', 'station:Load Truck'], ['source:Container', 'station:Order Empty Containers']]) {
          const e = re.find(e => e.source === source && e.target === target)!;
          const ps = drawing.points.get(e.id)!;
          assert(ps.length === 2 && ps[0].x === ps[1].x, `${label}: unnecessary bend at ${source}`);
          assert(drawing.nodeX.get(source) === ps[0].x, `${label}: source detached from straight line`);
        }
      }
      console.log(`  ok    ${label}: no node/stop-caption intersections; ${overlaps.length} pre-existing drawn overlaps remain; crossings ${countCrossings(routed.points)} → ${countCrossings(drawing.points)}`);
    }
  }
}
