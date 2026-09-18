import { BOUNDARY_D, GATEWAY_D, stationSize } from './sizes';
import type { RNode } from './router';
import type { LayoutNode, StationStyle } from './types';

/** Shared by the renderer and geometry tests; excludes a dot's caption. */
export function toRoutingNode(n: LayoutNode, style: StationStyle): RNode {
  const size = n.kind === 'station' ? stationSize(style, n.objectTypes.length)
    : n.kind === 'gateway' ? { w: GATEWAY_D * Math.SQRT2, h: GATEWAY_D * Math.SQRT2 }
    : { w: BOUNDARY_D, h: BOUNDARY_D };
  return {
    id: n.id, rank: n.rank, lane: n.lane,
    halfW: size.w / 2, halfH: size.h / 2,
    gateway: n.kind === 'gateway',
    alignable: n.kind === 'source' || (n.kind === 'station' && n.objectTypes.length === 1),
    labelHalfW: n.kind === 'sink' ? Math.min(96, n.objectType.length * 6 + 8) / 2 : undefined,
  };
}
