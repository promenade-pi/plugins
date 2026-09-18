import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react';
import { getEdgeParams } from './floating';

export interface TotemEdgeData {
  color: string;
  /** Near the source end — the reference's `lc_inverse` (log cardinality read backwards). */
  startLabel: string | null;
  /** Near the target end — `lc`. */
  endLabel: string | null;
  /** Centered, both event-cardinality readings joined — `ec · ec_inverse`. */
  midLabel: string;
  [key: string]: unknown;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function Pill({ x, y, text, background }: { x: number; y: number; text: string; background?: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        pointerEvents: 'none',
        fontSize: 10.5,
        fontWeight: background ? 600 : 500,
        color: background ? '#1a1a1a' : 'var(--text, #252a33)',
        background: background ?? 'var(--bg, #fff)',
        padding: background ? '2px 7px' : '1px 3px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

/** A straight line (matching the reference's force-directed drawing, not a
 * routed/bundled one) carrying up to three labels — the two log-cardinality
 * readings near each endpoint, the joined event-cardinality reading in the
 * middle — plus custom start/end markers (see `markers.ts`) for the
 * temporal-containment relation, which `markerStart`/`markerEnd` alone
 * can't express since their shape (triangle/tee/circle) differs per edge. */
export function TotemEdge({
  source, target, data, markerStart, markerEnd, selected,
}: EdgeProps & { data: TotemEdgeData }) {
  // Not the fixed per-side sourceX/sourceY/targetX/targetY EdgeProps hands
  // over (those come from whichever static Handle got picked, which reads
  // as arbitrary once nodes aren't arranged top-to-bottom) — the actual
  // node-boundary intersection point, recomputed every render so it tracks
  // a drag. See `floating.ts`.
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode);

  const path = `M ${sx},${sy} L ${tx},${ty}`;
  const startX = lerp(sx, tx, 0.16), startY = lerp(sy, ty, 0.16);
  const midX = lerp(sx, tx, 0.5), midY = lerp(sy, ty, 0.5);
  const endX = lerp(sx, tx, 0.84), endY = lerp(sy, ty, 0.84);

  return (
    <>
      <BaseEdge
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{ stroke: data.color, strokeWidth: selected ? 2.5 : 1.5, opacity: selected ? 1 : 0.85 }}
      />
      <EdgeLabelRenderer>
        {data.startLabel && <Pill x={startX} y={startY} text={data.startLabel} />}
        {data.midLabel && <Pill x={midX} y={midY} text={data.midLabel} background={data.color} />}
        {data.endLabel && <Pill x={endX} y={endY} text={data.endLabel} />}
      </EdgeLabelRenderer>
    </>
  );
}
