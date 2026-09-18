import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { penWidth } from './palette';
import { format3 } from './types';

export interface FuzzyEdgeData extends Record<string, unknown> {
  path: string;
  significance: number;
  correlation: number;
  label: string | null;
  labelX: number;
  labelY: number;
  color: string;
  /** Theme colours, passed rather than read as CSS vars: every other colour in
   *  this view comes from `promenade.theme()`, and a label that silently falls
   *  back to white on a dark canvas is the failure mode of mixing the two. */
  labelBg: string;
  labelColor: string;
  faded: boolean;
  highlighted: boolean;
}

/**
 * A relation. Two channels, as in the original: thickness carries the pair's
 * combined weight, and the fill darkens with significance, so a thin pale arc
 * reads as incidental without having to be read at all.
 */
export function FuzzyEdge({ id, markerEnd, data }: EdgeProps & { data?: FuzzyEdgeData }) {
  if (!data) return null;
  const width = penWidth(data.significance, data.correlation);
  return (
    <>
      <BaseEdge
        id={id}
        path={data.path}
        markerEnd={markerEnd}
        style={{
          stroke: data.color,
          strokeWidth: data.highlighted ? width + 1.5 : width,
          opacity: data.faded ? 0.15 : 1,
          fill: 'none',
        }}
      />
      {data.label && !data.faded && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${data.labelX}px, ${data.labelY}px)`,
              pointerEvents: 'none',
              fontSize: 9, lineHeight: 1.25, textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              background: data.labelBg, color: data.labelColor,
              padding: '1px 3px', borderRadius: 3, whiteSpace: 'pre',
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export function edgeLabelText(
  mode: 'none' | 'significance' | 'both',
  significance: number,
  correlation: number
): string | null {
  if (mode === 'none') return null;
  if (mode === 'significance') return format3(significance);
  return `${format3(significance)}\n${format3(correlation)}`;
}
