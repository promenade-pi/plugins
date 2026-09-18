import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { exportCanvasesAsPng, FONT, setupCanvas } from './canvasUtils';
import { attenuationFactor, type FuzzyModelPayload } from './types';

/**
 * A diagnostic ProM never had: how many relation observations the scan
 * actually found at each look-back distance, with the *current* mining
 * params' attenuation curve overlaid. `maximalDistance`/`attenuation`/
 * `radical` are Inspector-only action params — this view can read them off
 * `payload.stats` but not change them — so the point of this panel is to
 * make an Inspector adjustment an informed choice: is there real, unweighted
 * data past the current cutoff worth raising it for, and how hard does the
 * current radical/attenuation choice discount the tail already included.
 *
 * The histogram is params-independent (the kernel computes it once, straight
 * off the scan's raw per-distance accumulator) — it does not shrink or grow
 * as `maximalDistance` moves, only the cutoff line and the shaded "not
 * currently included" region do.
 */

const BAR_GAP = 3;
const CHART_HEIGHT = 200;
const TOP_PAD = 10;
const AXIS_LABEL_WIDTH = 40;
const BOTTOM_LABEL_HEIGHT = 22;

interface Layout {
  n: number;
  barWidth: number;
  width: number;
  height: number;
  plotTop: number;
  plotBottom: number;
  x(i: number): number;
  yCount(v: number): number;
  yFactor(v: number): number;
}

function computeLayout(n: number, barWidth: number): Layout {
  const plotTop = TOP_PAD;
  const plotBottom = TOP_PAD + CHART_HEIGHT;
  const width = AXIS_LABEL_WIDTH + n * barWidth;
  return {
    n, barWidth, width, height: plotBottom + BOTTOM_LABEL_HEIGHT,
    plotTop, plotBottom,
    x: (i) => AXIS_LABEL_WIDTH + i * barWidth,
    yCount: (v) => plotBottom - v * CHART_HEIGHT,
    yFactor: (v) => plotBottom - Math.max(0, Math.min(1, v)) * CHART_HEIGHT,
  };
}

function drawBase(
  ctx: CanvasRenderingContext2D, layout: Layout, counts: number[], maxCount: number,
  attenuation: string, radical: number, maximalDistance: number, theme: Record<string, string>
) {
  const bg = theme.bg || '#fff';
  const border = theme.border || '#dde1e6';
  const text = theme.text || '#1c2027';
  const textDim = theme['text-dim'] || '#697386';
  const accent = theme.accent || '#2563eb';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.font = FONT;

  // Left axis: raw observation counts, 0 / max.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textDim;
  ctx.fillText('0', layout.plotBottom - 6 >= 0 ? AXIS_LABEL_WIDTH - 6 : 0, layout.plotBottom);
  ctx.fillText(String(maxCount), AXIS_LABEL_WIDTH - 6, layout.plotTop + 4);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(AXIS_LABEL_WIDTH, layout.plotBottom + 0.5);
  ctx.lineTo(layout.width, layout.plotBottom + 0.5);
  ctx.stroke();

  // Bars — the shaded region past `maximalDistance` isn't currently
  // contributing to the model at all, cutoff line makes that boundary explicit.
  for (let i = 0; i < layout.n; i++) {
    const distance = i + 1;
    const v = maxCount > 0 ? counts[i] / maxCount : 0;
    const x = layout.x(i);
    const y = layout.yCount(v);
    const included = distance <= maximalDistance;
    ctx.fillStyle = included ? accent : textDim;
    ctx.globalAlpha = included ? 0.75 : 0.28;
    ctx.fillRect(x + BAR_GAP / 2, y, layout.barWidth - BAR_GAP, layout.plotBottom - y);
    ctx.globalAlpha = 1;
  }

  // Attenuation curve for the current params, sharing the same [0,1] vertical
  // space as the bars (which are already normalised to their own max).
  ctx.strokeStyle = text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < layout.n; i++) {
    const distance = i + 1;
    const f = attenuationFactor(attenuation, radical, distance);
    const px = layout.x(i) + layout.barWidth / 2;
    const py = layout.yFactor(f);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = text;
  for (let i = 0; i < layout.n; i++) {
    const distance = i + 1;
    const f = attenuationFactor(attenuation, radical, distance);
    ctx.beginPath();
    ctx.arc(layout.x(i) + layout.barWidth / 2, layout.yFactor(f), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Cutoff line at the current maximalDistance.
  if (maximalDistance >= 1 && maximalDistance <= layout.n) {
    const cx = layout.x(maximalDistance - 1) + layout.barWidth;
    ctx.strokeStyle = accent;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, layout.plotTop);
    ctx.lineTo(cx, layout.plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // X-axis distance labels.
  ctx.textAlign = 'center';
  ctx.fillStyle = text;
  for (let i = 0; i < layout.n; i++) {
    if (layout.barWidth < 16 && (i + 1) % 2 === 0) continue; // thin out when cramped
    ctx.fillText(String(i + 1), layout.x(i) + layout.barWidth / 2, layout.plotBottom + 13);
  }
}

function nearestIndex(layout: Layout, localX: number): number | null {
  const i = Math.floor((localX - AXIS_LABEL_WIDTH) / layout.barWidth);
  return i >= 0 && i < layout.n ? i : null;
}

export interface DistanceHistogramHandle {
  exportPng(): void;
}

export const DistanceHistogram = forwardRef<DistanceHistogramHandle, {
  payload: FuzzyModelPayload;
  theme: Record<string, string>;
}>(function DistanceHistogram({ payload, theme }, ref) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const counts = payload.distanceHistogram ?? [];
  const maxCount = Math.max(1, ...counts);
  const { attenuation, radical, maximalDistance } = payload.stats;

  const barWidth = counts.length > 40 ? 14 : counts.length > 24 ? 20 : 28;

  const layout = useMemo(() => computeLayout(counts.length, barWidth), [counts.length, barWidth]);

  useImperativeHandle(ref, () => ({
    exportPng: () => exportCanvasesAsPng(baseRef.current, overlayRef.current, 'fuzzy-metrics-distance-histogram.png'),
  }), []);

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    drawBase(ctx, layout, counts, maxCount, attenuation, radical, maximalDistance, theme);
  }, [layout, counts, maxCount, attenuation, radical, maximalDistance, theme]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    ctx.clearRect(0, 0, layout.width, layout.height);
    if (hoverIndex != null) {
      const x = layout.x(hoverIndex) + layout.barWidth / 2;
      ctx.strokeStyle = theme.text || '#1c2027';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, layout.plotTop);
      ctx.lineTo(x, layout.plotBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, [layout, hoverIndex, theme]);

  const localPoint = (e: React.MouseEvent) => {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = layout.width / rect.width;
    return { x: (e.clientX - rect.left) * scaleX };
  };
  const onMove = (e: React.MouseEvent) => {
    setHoverIndex(nearestIndex(layout, localPoint(e).x));
    setMouse({ x: e.clientX, y: e.clientY });
  };
  const onLeave = () => { setHoverIndex(null); setMouse(null); };

  const tooltip = useMemo(() => {
    if (hoverIndex == null) return null;
    const distance = hoverIndex + 1;
    const count = counts[hoverIndex] ?? 0;
    const factor = attenuationFactor(attenuation, radical, distance);
    const included = distance <= maximalDistance;
    return [
      `Distance ${distance}${included ? '' : '  (past current cutoff)'}`,
      `Observations: ${count}`,
      `Attenuation factor: ${factor.toFixed(3)}`,
    ].join('\n');
  }, [hoverIndex, counts, attenuation, radical, maximalDistance]);

  return (
    <>
      <div style={{
        flex: '0 0 auto', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center',
        padding: '6px 12px', fontSize: 10.5, color: theme['text-dim'],
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: theme.accent }} />
          Observed (current cutoff)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: theme['text-dim'], opacity: 0.5 }} />
          Observed (past cutoff)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 14, height: 2, background: theme.text }} />
          Attenuation curve ({attenuation === 'linear' ? 'linear' : 'nth-root'}, radical {radical})
        </span>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' }}>
        <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
          <canvas ref={baseRef} style={{ position: 'absolute', top: 0, left: 0 }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', top: 0, left: 0, cursor: hoverIndex != null ? 'pointer' : 'default' }}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
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
