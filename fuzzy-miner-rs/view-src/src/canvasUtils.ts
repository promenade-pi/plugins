/** Shared between `Heatmap.tsx` and `CurveChart.tsx` — the canvas-2D text
 * measurement, truncation and DPR-aware sizing every chart in this view needs. */

export const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

let measureCanvas: HTMLCanvasElement | null = null;
export function measureCtx(): CanvasRenderingContext2D {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d')!;
  ctx.font = FONT;
  return ctx;
}

/** Binary-searches the longest prefix (plus an ellipsis) that fits `maxWidth`. */
export function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}…`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return lo === 0 ? '…' : `${text.slice(0, lo)}…`;
}

/** Sizes a canvas's backing store for the device pixel ratio and scales its
 * context so every subsequent draw call can keep using CSS-pixel coordinates. */
export function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Merges a chart's stacked base+overlay canvases into one PNG and triggers
 * a download — the sandboxed frame's `allow-downloads` makes a plain
 * `<a download>` work, same technique `lib/exportFigure.ts` uses for the
 * graph view's own PNG/SVG/PDF export. */
export function exportCanvasesAsPng(base: HTMLCanvasElement | null, overlay: HTMLCanvasElement | null, filename: string) {
  if (!base) return;
  const merged = document.createElement('canvas');
  merged.width = base.width;
  merged.height = base.height;
  const mctx = merged.getContext('2d')!;
  mctx.drawImage(base, 0, 0);
  if (overlay) mctx.drawImage(overlay, 0, 0);
  const a = document.createElement('a');
  a.href = merged.toDataURL('image/png');
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
