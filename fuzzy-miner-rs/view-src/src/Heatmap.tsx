import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { exportCanvasesAsPng, FONT, measureCtx, setupCanvas, truncateToWidth } from './canvasUtils';
import { heatColor, ON_FILL } from './palette';
import { matrixMetricOf, ROW_METRICS, type MatrixData, type MatrixMetricKey, type RowMetricKey, type RowSeries } from './matrixMetrics';
import { format3, type FuzzyModelPayload } from './types';

/**
 * ProM's binary-metrics matrix: a coloured n×n grid over activity pairs, with
 * a per-activity bar in the row gutter carrying the unary side. Two stacked
 * canvases — the heatmap itself repaints only when the data, metric, sort or
 * cell size actually change; hover and selection, which repaint on every
 * mouse move, draw onto a second, transparent canvas on top.
 */

const ROW_BAR_WIDTH = 30;
const ROW_LABEL_TEXT_MAX = 130;
const COL_HEADER_MAX = 110;
const MIN_CELL_FOR_DOT = 6; // below this, a self-loop dot would just be noise

interface Layout {
  n: number;
  cellSize: number;
  rowLabelWidth: number;
  colHeaderHeight: number;
  width: number;
  height: number;
  /** In display order, each truncated to the space it will actually be
   * drawn into — the row gutter's text column and the diagonal column
   * header respectively. Two arrays, not one, because those two spaces are
   * different widths. */
  rowLabels: string[];
  colLabels: string[];
}

function computeLayout(activities: string[], order: number[], cellSize: number): Layout {
  const ctx = measureCtx();
  const n = order.length;
  const raw = order.map((i) => activities[i] ?? `a${i}`);

  const rowTextWidth = Math.min(
    ROW_LABEL_TEXT_MAX,
    Math.ceil(Math.max(0, ...raw.map((l) => ctx.measureText(l).width)))
  );
  const rowLabelWidth = rowTextWidth + 6 + ROW_BAR_WIDTH + 8;

  // Diagonal text at 45° projects its width onto the vertical axis at cos(45°).
  const colTextWidth = Math.min(
    ROW_LABEL_TEXT_MAX,
    Math.ceil(Math.max(0, ...raw.map((l) => ctx.measureText(l).width)))
  );
  const colHeaderHeight = Math.min(COL_HEADER_MAX, Math.ceil(colTextWidth * 0.72) + 14);
  // The diagonal has more room than a horizontal line of the same box width
  // would, since it runs along the hypotenuse — dividing back by that same
  // cosine converts the vertical budget back into an allowance along the text.
  const colTextBudget = (colHeaderHeight - 14) / 0.72;

  return {
    n, cellSize, rowLabelWidth, colHeaderHeight,
    width: rowLabelWidth + n * cellSize,
    height: colHeaderHeight + n * cellSize,
    rowLabels: raw.map((l) => truncateToWidth(ctx, l, rowTextWidth)),
    colLabels: raw.map((l) => truncateToWidth(ctx, l, colTextBudget)),
  };
}

type Hit =
  | { kind: 'cell'; r: number; c: number }
  | { kind: 'row'; r: number }
  | { kind: 'col'; c: number }
  | null;

function hitTest(layout: Layout, localX: number, localY: number): Hit {
  const { n, cellSize, rowLabelWidth, colHeaderHeight } = layout;
  const inGutter = localX < rowLabelWidth;
  const inHeader = localY < colHeaderHeight;
  if (!inGutter && !inHeader) {
    const c = Math.floor((localX - rowLabelWidth) / cellSize);
    const r = Math.floor((localY - colHeaderHeight) / cellSize);
    if (r >= 0 && r < n && c >= 0 && c < n) return { kind: 'cell', r, c };
    return null;
  }
  if (inGutter && !inHeader) {
    const r = Math.floor((localY - colHeaderHeight) / cellSize);
    return r >= 0 && r < n ? { kind: 'row', r } : null;
  }
  if (!inGutter && inHeader) {
    const c = Math.floor((localX - rowLabelWidth) / cellSize);
    return c >= 0 && c < n ? { kind: 'col', c } : null;
  }
  return null;
}

function drawBase(
  ctx: CanvasRenderingContext2D, layout: Layout, matrix: MatrixData | null, rowSeries: RowSeries | null,
  palette: string[], theme: Record<string, string>
) {
  const { n, cellSize, rowLabelWidth, colHeaderHeight, rowLabels, colLabels } = layout;
  // `||`, not `??`: a canvas `fillStyle` assignment silently keeps its
  // previous value (defaulting to black) on an invalid string, and an empty
  // string is exactly the shape a not-yet-populated theme token takes here —
  // `??` alone would let one straight through as if it were a real colour.
  const bg = theme.bg || '#fff';
  const border = theme.border || '#dde1e6';
  const text = theme.text || '#1c2027';
  const textDim = theme['text-dim'] || '#697386';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';

  // Matrix cells.
  for (let r = 0; r < n; r++) {
    const y = colHeaderHeight + r * cellSize;
    for (let c = 0; c < n; c++) {
      const x = rowLabelWidth + c * cellSize;
      const v = matrix ? matrix.value(r, c) : 0;
      if (v > 0 && matrix) {
        ctx.fillStyle = heatColor(palette, v / matrix.max);
        ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
      } else {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellSize - 2, cellSize - 2);
      }
      if (r === c && cellSize >= MIN_CELL_FOR_DOT) {
        ctx.fillStyle = v > 0 ? ON_FILL : textDim;
        ctx.globalAlpha = v > 0 ? 0.55 : 0.35;
        ctx.beginPath();
        ctx.arc(x + cellSize / 2, y + cellSize / 2, Math.max(1.5, cellSize * 0.1), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  // Row bars + labels.
  ctx.textAlign = 'right';
  for (let r = 0; r < n; r++) {
    const y = colHeaderHeight + r * cellSize;
    const cy = y + cellSize / 2;
    ctx.fillStyle = text;
    ctx.fillText(rowLabels[r], rowLabelWidth - ROW_BAR_WIDTH - 6, cy);
    if (rowSeries) {
      const w = Math.max(1, ((ROW_BAR_WIDTH - 4) * rowSeries.value(r)) / rowSeries.max);
      ctx.fillStyle = heatColor(palette, rowSeries.value(r) / rowSeries.max);
      ctx.fillRect(rowLabelWidth - ROW_BAR_WIDTH - 2 + (ROW_BAR_WIDTH - 2 - w), cy - 3, w, 6);
    }
  }

  // Column headers, rotated -45° so they read diagonally, anchored just
  // above each column.
  ctx.textAlign = 'left';
  ctx.fillStyle = text;
  for (let c = 0; c < n; c++) {
    const x = rowLabelWidth + c * cellSize + cellSize / 2;
    ctx.save();
    ctx.translate(x, colHeaderHeight - 6);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(colLabels[c], 0, 0);
    ctx.restore();
  }
}

function drawOverlay(
  ctx: CanvasRenderingContext2D, layout: Layout, theme: Record<string, string>,
  hover: Hit, selectedRows: Set<number>
) {
  const { n, cellSize, rowLabelWidth, colHeaderHeight } = layout;
  ctx.clearRect(0, 0, layout.width, layout.height);
  const accent = theme.accent || '#2563eb';

  const stripeRow = (r: number, alpha: number) => {
    const y = colHeaderHeight + r * cellSize;
    ctx.fillStyle = accent;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, y, rowLabelWidth + n * cellSize, cellSize);
    ctx.globalAlpha = 1;
  };
  const stripeCol = (c: number, alpha: number) => {
    const x = rowLabelWidth + c * cellSize;
    ctx.fillStyle = accent;
    ctx.globalAlpha = alpha;
    ctx.fillRect(x, 0, cellSize, colHeaderHeight + n * cellSize);
    ctx.globalAlpha = 1;
  };

  for (const r of selectedRows) { stripeRow(r, 0.12); stripeCol(r, 0.12); }

  if (hover) {
    if (hover.kind === 'cell') {
      stripeRow(hover.r, 0.06);
      stripeCol(hover.c, 0.06);
      ctx.strokeStyle = theme.text || '#1c2027';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        rowLabelWidth + hover.c * cellSize + 0.75,
        colHeaderHeight + hover.r * cellSize + 0.75,
        cellSize - 1.5, cellSize - 1.5
      );
    } else if (hover.kind === 'row') {
      stripeRow(hover.r, 0.08);
    } else {
      stripeCol(hover.c, 0.08);
    }
  }
}

export interface HeatmapHandle {
  exportPng(): void;
}

export const Heatmap = forwardRef<HeatmapHandle, {
  payload: FuzzyModelPayload;
  order: number[];
  matrix: MatrixData | null;
  rowSeries: RowSeries | null;
  palette: string[];
  cellSize: number;
  theme: Record<string, string>;
  selected: Set<string>;
  effectiveMetric: MatrixMetricKey;
  effectiveRowMetric: RowMetricKey;
}>(function Heatmap(
  { payload, order, matrix, rowSeries, palette, cellSize, theme, selected, effectiveMetric, effectiveRowMetric },
  ref
) {
  const [hover, setHover] = useState<Hit>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const layout = useMemo(
    () => computeLayout(payload.activities, order, cellSize),
    [payload.activities, order, cellSize]
  );

  useImperativeHandle(ref, () => ({
    exportPng: () => exportCanvasesAsPng(baseRef.current, overlayRef.current, 'fuzzy-metrics-matrix.png'),
  }), []);

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    drawBase(ctx, layout, matrix, rowSeries, palette, theme);
  }, [layout, matrix, rowSeries, palette, theme]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = setupCanvas(canvas, layout.width, layout.height);
    const selectedRows = new Set(
      order.map((origIdx, r) => (selected.has(payload.activities[origIdx]) ? r : -1)).filter((r) => r >= 0)
    );
    drawOverlay(ctx, layout, theme, hover, selectedRows);
  }, [layout, theme, hover, selected, order, payload.activities]);

  const localPoint = (e: React.MouseEvent) => {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = layout.width / rect.width;
    const scaleY = layout.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const onMove = (e: React.MouseEvent) => {
    const { x, y } = localPoint(e);
    setHover(hitTest(layout, x, y));
    setMouse({ x: e.clientX, y: e.clientY });
  };

  const onLeave = () => { setHover(null); setMouse(null); };

  const onClick = () => {
    if (!hover) return;
    const idOf = (r: number) => payload.activities[order[r]] ?? `a${order[r]}`;
    if (hover.kind === 'cell') {
      const items = hover.r === hover.c
        ? [{ kind: 'activity' as const, id: idOf(hover.r) }]
        : [{ kind: 'activity' as const, id: idOf(hover.r) }, { kind: 'activity' as const, id: idOf(hover.c) }];
      promenade.select(items);
    } else if (hover.kind === 'row') {
      promenade.select([{ kind: 'activity', id: idOf(hover.r) }]);
    } else {
      promenade.select([{ kind: 'activity', id: idOf(hover.c) }]);
    }
  };

  const tooltip = useMemo(() => {
    if (!hover) return null;
    const nameOf = (r: number) => payload.activities[order[r]] ?? `a${order[r]}`;
    if (hover.kind === 'cell') {
      const v = matrix ? matrix.value(hover.r, hover.c) : 0;
      const metricLabel = matrixMetricOf(effectiveMetric).label;
      if (hover.r === hover.c) return `${nameOf(hover.r)}  (self-loop)\n${metricLabel}: ${format3(v)}`;
      return `${nameOf(hover.r)} → ${nameOf(hover.c)}\n${metricLabel}: ${format3(v)}`;
    }
    const r = hover.kind === 'row' ? hover.r : hover.c;
    const rowLabel = ROW_METRICS.find((m) => m.key === effectiveRowMetric)?.label ?? '';
    return `${nameOf(r)}\n${rowLabel}: ${rowSeries ? format3(rowSeries.value(r)) : '—'}`;
  }, [hover, matrix, rowSeries, order, payload.activities, effectiveMetric, effectiveRowMetric]);

  return (
    <>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' }}>
        <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
          <canvas ref={baseRef} style={{ position: 'absolute', top: 0, left: 0 }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', top: 0, left: 0, cursor: hover ? 'pointer' : 'default' }}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            onClick={onClick}
          />
        </div>
      </div>

      {hover && tooltip && mouse && (
        <div style={{
          position: 'fixed', left: mouse.x, top: mouse.y, pointerEvents: 'none', zIndex: 10,
          transform: 'translate(14px, 14px)',
          background: theme['bg-soft'], color: theme.text, border: `1px solid ${theme.border}`,
          borderRadius: 6, padding: '6px 8px', fontSize: 10.5, whiteSpace: 'pre-line', lineHeight: 1.4,
          boxShadow: '0 2px 8px rgba(0,0,0,.15)', maxWidth: 240,
        }}>
          {tooltip}
        </div>
      )}
    </>
  );
});
