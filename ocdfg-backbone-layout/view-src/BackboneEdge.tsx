import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { edgePath, type EdgeStyle, type Point } from './geometry.ts';

export interface BackboneEdgeData {
  points: Point[];
  color: string;
  width: number;
  style: EdgeStyle;
  backbone: boolean;
  back: boolean;
  horizontal: boolean;
  dimmed: boolean;
  highlighted: boolean;
  label: string | null;
  labelAt: Point | null;
  theme: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Draws the route the action computed.
 *
 * A back edge is dashed and takes the theme's warning colour, matching both
 * papers' figures (blue forward, red backward) — the whole point of the
 * rank-assignment IP is that there should be few of them, so they have to be
 * countable at a glance. A horizontal edge gets a round cap and no arrow
 * shortening: it connects a mutually dependent pair, where neither direction
 * is a precedence ([2] Sect. 3.2).
 */
export function BackboneEdge({ id, data, markerEnd }: EdgeProps & { data?: BackboneEdgeData }) {
  if (!data || data.points.length < 2) return null;
  const path = edgePath(data.points, data.style);
  if (!path) return null;

  const stroke = data.back ? (data.theme.warn ?? '#d2544b') : data.color;
  const opacity = data.dimmed ? 0.12 : data.highlighted ? 1 : 0.82;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={data.horizontal ? undefined : markerEnd}
        style={{
          stroke,
          strokeWidth: data.highlighted ? data.width + 1 : data.width,
          strokeDasharray: data.back ? '7 4' : undefined,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity,
          fill: 'none',
        }}
      />
      {data.label && data.labelAt && !data.dimmed && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)`,
              background: data.theme['bg-soft'], color: data.theme['text-dim'],
              border: `1px solid ${data.theme.border}`, borderRadius: 4,
              padding: '0 3px', fontSize: 9, pointerEvents: 'none', whiteSpace: 'nowrap',
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
