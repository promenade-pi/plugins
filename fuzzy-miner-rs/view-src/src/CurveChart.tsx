import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { exportCanvasesAsPng, FONT, measureCtx, setupCanvas, truncateToWidth } from './canvasUtils';
import { buildRowSeries, type RowMetricKey, type RowSeries } from './matrixMetrics';
import { format3, type FuzzyModelPayload } from './types';

/**
 * ProM's other metrics screen: "a multi-curve two-dimensional graph"
 * plotting every unary metric across all activities at once, each with a
 * "colored square" to toggle its visibility, mouse hover for exact values —
 * the companion this plugin's matrix view never had, since a matrix is a
 * poor way to compare several *unary* (per-activity, not per-pair) metrics
 * against each other.
 *
 * Unlike the matrix's metric picker, all three curves a model can carry
 * (the weighted total, and — with per-metric detail kept — the two raw
 * unary metrics behind it) are always computed and drawn together; there is
 * nothing to *pick*, only to show or hide, which is what the legend chips
 * are for. Visibility is local, unpersisted state: which lines are
 * currently highlighted for comparison is a reading aid, not an analysis
 * setting worth round-tripping through a saved view.
 */

const CURVES: Array<{ key: RowMetricKey; label: string; color: string }> = [
  { key: 'nodeSignificance', label: 'Overall significance', color: '#2563eb' },
  { key: 'frequencyUnary', label: 'Frequency significance', color: '#f59e0b' },
  { key: 'routingUnary', label: 'Routing significance', color: '#8b5cf6' },
];

const AXIS_LABEL_WIDTH = 34;
const BOTTOM_LABEL_MAX = 90;
const CHART_HEIGHT = 220;
const TOP_PAD = 10;
const POINT_R = 2.5;

interface Layout {
  n: number;
  spacing: number;
  axisWidth: number;
  bottomHeight: number;
  width: number;
  height: number;
  labels: string[];
  /** Chart-area x for activity index r in display order. */
  x(r: number): number;
  /** Chart-area y for a value in [0, 1]. */
  y(v: number): number;
  plotTop: number;
  plotBottom: number;
}

function computeLayout(activities: string[], order: number[], spacing: number): Layout {
  const ctx = measureCtx();
  const n = order.length;
  const raw = order.map((i) => activities[i] ?? `a${i}`);
  const longest = Math.max(0, ...raw.map((l) => ctx.measureText(l).width));
  const bottomHeight = Math.min(BOTTOM_LABEL_MAX, Math.ceil(Math.min(longest, 130) * 0.72) + 14);
  const plotTop = TOP_PAD;
  const plotBottom = TOP_PAD + CHART_HEIGHT;
  const width = AXIS_LABEL_WIDTH + Math.max(1, n - 1) * spacing + spacing;
  return {
    n, spacing, axisWidth: AXIS_LABEL_WIDTH, bottomHeight,
    width, height: plotBottom + bottomHeight,
    labels: raw.map((l) => truncateToWidth(ctx, l, spacing + 24)),
    x: (r) => AXIS_LABEL_WIDTH + spacing / 2 + r * spacing,
    y: (v) => plotBottom - Math.max(0, Math.min(1, v)) * CHART_HEIGHT,
    plotTop, plotBottom,
  };
}

function nearestIndex(layout: Layout, localX: number): number | null {
  if (layout.n === 0) return null;
  const r = Math.round((localX - layout.axisWidth - layout.spacing / 2) / layout.spacing);
  return r >= 0 && r < layout.n ? r : null;
}

function drawBase(
  ctx: CanvasRenderingContext2D, layout: Layout, series: Partial<Record<RowMetricKey, RowSeries>>,
  visible: Set<RowMetricKey>, theme: Record<string, string>
) {
  const bg = theme.bg || '#fff';
  const border = theme.border || '#dde1e6';
  const text = theme.text || '#1c2027';
  const textDim = theme['text-dim'] || '#697386';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.font = FONT;

  // Y-axis: 0 / 0.5 / 1 gridlines and labels.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [0, 0.5, 1]) {
    const y = layout.y(v);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.axisWidth, y + 0.5);
    ctx.lineTo(layout.width, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = textDim;
    ctx.fillText(v.toFixed(1), layout.axisWidth - 6, y);
  }

  // X-axis labels, rotated -45° and anchored at the tick so they hang below it.
  ctx.textAlign = 'right';
  ctx.fillStyle = text;
  for (let r = 0; r < layout.n; r++) {
    const x = layout.x(r);
    ctx.save();
    ctx.translate(x, layout.plotBottom + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(layout.labels[r], 0, 0);
    ctx.restore();
  }

  // The curves.
  for (const c of CURVES) {
    if (!visible.has(c.key)) continue;
    const s = series[c.key];
    if (!s) continue;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let r = 0; r < layout.n; r++) {
      const px = layout.x(r);
      const py = layout.y(s.value(r));
      if (r === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = c.color;
    for (let r = 0; r < layout.n; r++) {
      ctx.beginPath();
      ctx.arc(layout.x(r), layout.y(s.value(r)), POINT_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawOverlay(
  ctx: CanvasRenderingContext2D, layout: Layout, theme: Record<string, string>,
  hoverIndex: number | null, selectedIndices: Set<number>
) {
  ctx.clearRect(0, 0, layout.width, layout.height);
  const accent = theme.accent || '#2563eb';

  for (const r of selectedIndices) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(layout.x(r) - layout.spacing / 2, layout.plotTop, layout.spacing, layout.plotBottom - layout.plotTop);
    ctx.globalAlpha = 1;
  }

  if (hoverIndex != null) {
    ctx.strokeStyle = theme.text || '#1c2027';
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.x(hoverIndex), layout.plotTop);
    ctx.lineTo(layout.x(hoverIndex), layout.plotBottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export interface CurveChartHandle {
  exportPng(): void;
}

export const CurveChart = forwardRef<CurveChartHandle, {
  payload: FuzzyModelPayload;
  order: number[];
  spacing: number;
  theme: Record<string, string>;
  selected: Set<string>;
}>(function CurveChart({ payload, order, spacing, theme, selected }, ref) {
  const [visible, setVisible] = useState<Set<RowMetricKey>>(new Set(CURVES.map((c) => c.key)));
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const series = useMemo(() => {
    const out: Partial<Record<RowMetricKey, RowSeries>> = {};
    for (const c of CURVES) {
      const s = buildRowSeries(payload, c.key, order);
      if (s) out[c.key] = s;
    }
    return out;
  }, [payload, order]);

  const layout = useMemo(
    () => computeLayout(payload.activities, order, spacing),
    [payload.activities, order, spacing]
  );

  useImperativeHandle(ref, () => ({
    exportPng: () => exportCanvasesAsPng(baseRef.current, overlayRef.current, 'fuzzy-metrics-curves.png'),
  }), []);

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    drawBase(ctx, layout, series, visible, theme);
  }, [layout, series, visible, theme]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    const selectedIndices = new Set(
      order.map((origIdx, r) => (selected.has(payload.activities[origIdx]) ? r : -1)).filter((r) => r >= 0)
    );
    drawOverlay(ctx, layout, theme, hoverIndex, selectedIndices);
  }, [layout, theme, hoverIndex, selected, order, payload.activities]);

  const localPoint = (e: React.MouseEvent) => {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = layout.width / rect.width;
    return { x: (e.clientX - rect.left) * scaleX };
  };

  const onMove = (e: React.MouseEvent) => {
    const { x } = localPoint(e);
    setHoverIndex(nearestIndex(layout, x));
    setMouse({ x: e.clientX, y: e.clientY });
  };
  const onLeave = () => { setHoverIndex(null); setMouse(null); };
  const onClick = () => {
    if (hoverIndex == null) return;
    const id = payload.activities[order[hoverIndex]] ?? `a${order[hoverIndex]}`;
    promenade.select([{ kind: 'activity', id }]);
  };

  const toggleCurve = (key: RowMetricKey) => setVisible((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const tooltip = useMemo(() => {
    if (hoverIndex == null) return null;
    const name = payload.activities[order[hoverIndex]] ?? `a${order[hoverIndex]}`;
    const lines = [name];
    for (const c of CURVES) {
      if (!visible.has(c.key)) continue;
      const s = series[c.key];
      if (!s) continue;
      lines.push(`${c.label}: ${format3(s.value(hoverIndex))}`);
    }
    return lines.join('\n');
  }, [hoverIndex, order, payload.activities, series, visible]);

  return (
    <>
      <div style={{
        flex: '0 0 auto', display: 'flex', gap: 10, flexWrap: 'wrap',
        padding: '6px 12px', fontSize: 10.5, color: theme.text,
      }}>
        {CURVES.map((c) => {
          const available = !!series[c.key];
          const on = visible.has(c.key) && available;
          return (
            <label
              key={c.key}
              title={available ? c.label : `${c.label} — not kept for this run`}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                cursor: available ? 'pointer' : 'default', opacity: available ? 1 : 0.4,
              }}
            >
              <input
                type="checkbox" checked={on} disabled={!available}
                onChange={() => toggleCurve(c.key)}
                style={{ margin: 0, accentColor: c.color }}
              />
              <span style={{ width: 10, height: 10, borderRadius: 2, background: c.color, flex: '0 0 auto' }} />
              <span>{c.label}</span>
            </label>
          );
        })}
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' }}>
        <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
          <canvas ref={baseRef} style={{ position: 'absolute', top: 0, left: 0 }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', top: 0, left: 0, cursor: hoverIndex != null ? 'pointer' : 'default' }}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            onClick={onClick}
          />
        </div>
      </div>

      {hoverIndex != null && tooltip && mouse && (
        <div style={{
          position: 'fixed', left: mouse.x, top: mouse.y, pointerEvents: 'none', zIndex: 10,
          transform: 'translate(14px, 14px)',
          background: theme['bg-soft'], color: theme.text, border: `1px solid ${theme.border}`,
          borderRadius: 6, padding: '6px 8px', fontSize: 10.5, whiteSpace: 'pre-line', lineHeight: 1.4,
          boxShadow: '0 2px 8px rgba(0,0,0,.15)', maxWidth: 220,
        }}>
          {tooltip}
        </div>
      )}
    </>
  );
});
