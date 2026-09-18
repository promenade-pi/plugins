import type { EdgeProps } from '@xyflow/react';
import type { ElkPoint, ElkSection } from './layout';
import { pathFromSections } from './layout';

export interface EdgeStroke {
  objectType: string;
  freq: number;
  color: string;
}

export interface OcdfgEdgeData {
  sections: ElkSection[];
  /** One stroke per object type. Combined edges carry more than one, drawn as parallel offset lines. */
  strokes: EdgeStroke[];
  width: number;
  opacity: number;
  [key: string]: unknown;
}

const ARROW_SIZE = 7;

/**
 * Two points of a routed edge are the same point as far as a direction is
 * concerned when they are closer together than this. ELK works in layout
 * units, which are CSS pixels here, so half a pixel is below anything that
 * can be drawn — but well above the exact duplicates it actually emits.
 */
const COINCIDENT = 0.5;

/** Every point ELK routed, start to end, across all of an edge's sections. */
function trail(sections: ElkSection[]): ElkPoint[] {
  return sections.flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
}

/**
 * A constant-vector offset, not a true parallel curve (which would need to
 * offset every point by its own local normal). Cheap, and indistinguishable
 * from the real thing on the gently-bent splines ELK routes here; only a
 * sharply doubled-back edge would show it.
 *
 * Measured from the first point that is anywhere other than the last one, so
 * a self-loop — whose start and end are the same node boundary — still gets
 * a direction to offset its parallel strokes along.
 */
function overallNormal(sections: ElkSection[]): { nx: number; ny: number } {
  const points = trail(sections);
  const end = points[points.length - 1];
  if (!end) return { nx: 0, ny: 0 };
  for (const point of points) {
    const dx = end.x - point.x;
    const dy = end.y - point.y;
    const len = Math.hypot(dx, dy);
    if (len > COINCIDENT) return { nx: -dy / len, ny: dx / len };
  }
  return { nx: 0, ny: 0 };
}

/**
 * The direction the arrowhead points: the tangent where the route ends.
 *
 * ELK hands a reversed edge back with its final bend point sitting *on* its
 * end point — a back link closing a cycle is laid out the other way round by
 * cycle breaking and then restored, and the restore leaves that duplicate
 * behind. Reading the last bend point blindly therefore gave a zero-length
 * tangent on exactly those edges, and the arrowhead collapsed into a single
 * point: present in the DOM, at the right place, and invisible. Every
 * back link in a loop lost its arrow that way, which read as the loop not
 * being drawn at all.
 *
 * So walk back through the route for the last point that is genuinely
 * somewhere else. `null` means the whole route is one point, which no
 * arrowhead can be aimed along.
 */
function endTangent(sections: ElkSection[]): { tx: number; ty: number; end: ElkPoint } | null {
  const points = trail(sections);
  const end = points[points.length - 1];
  if (!end) return null;
  for (let i = points.length - 2; i >= 0; i--) {
    const dx = end.x - points[i].x;
    const dy = end.y - points[i].y;
    const len = Math.hypot(dx, dy);
    if (len > COINCIDENT) return { tx: dx / len, ty: dy / len, end };
  }
  return null;
}

function arrowPoints(end: ElkPoint, tx: number, ty: number): string {
  const nx = -ty;
  const ny = tx;
  const bx = end.x - tx * ARROW_SIZE;
  const by = end.y - ty * ARROW_SIZE;
  const half = ARROW_SIZE * 0.42;
  return [
    `${end.x},${end.y}`,
    `${bx + nx * half},${by + ny * half}`,
    `${bx - nx * half},${by - ny * half}`,
  ].join(' ');
}

export function OcdfgEdge({ data }: EdgeProps & { data: OcdfgEdgeData }) {
  const { sections, strokes, width, opacity } = data;
  if (!sections.length || !strokes.length) return null;

  const path = pathFromSections(sections);
  const { nx, ny } = overallNormal(sections);
  const tangent = endTangent(sections);
  const arrow = tangent ? arrowPoints(tangent.end, tangent.tx, tangent.ty) : null;
  const spacing = Math.max(width + 2.5, 4);
  const count = strokes.length;

  return (
    <>
      {strokes.map((stroke, i) => {
        const offset = (i - (count - 1) / 2) * spacing;
        const transform = offset ? `translate(${nx * offset} ${ny * offset})` : undefined;
        return (
          <g key={stroke.objectType} transform={transform}>
            <path d={path} fill="none" stroke={stroke.color} strokeWidth={width} strokeLinecap="round" opacity={opacity}>
              <title>{`${stroke.objectType}: ${stroke.freq.toLocaleString()} objects`}</title>
            </path>
            {arrow && (
              <polygon points={arrow} fill={stroke.color} opacity={opacity}>
                <title>{`${stroke.objectType}: ${stroke.freq.toLocaleString()} objects`}</title>
              </polygon>
            )}
          </g>
        );
      })}
    </>
  );
}
