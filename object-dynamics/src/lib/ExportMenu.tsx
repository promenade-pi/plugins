import { useEffect, useRef, useState } from 'react';
import { exportElementAsPng, exportElementAsSvg } from './exportFigure';
import { exportCsv } from './csv';

/**
 * The one export control every Object Dynamics view offers, wired the same
 * way regardless of which chart or table it sits above — consistent with
 * `ocelot/src/lib/ExportMenu.tsx`'s figure export, plus a CSV row for the
 * aggregated data behind the chart. There is no per-view bespoke export path.
 */
export function ExportMenu({
  filename, getElement, csvRows,
}: {
  filename: string;
  /** Element to rasterize for PNG/SVG. Omit to hide the figure options
   * (a view with only a table and no chart worth rasterizing). */
  getElement?: () => HTMLElement | null;
  /** Rows behind the chart/table, for "Export data as CSV". Omit or pass an
   * empty array to hide the CSV option (nothing to export yet). */
  csvRows?: ReadonlyArray<object>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const hasFigure = !!getElement;
  const hasCsv = !!csvRows && csvRows.length > 0;
  if (!hasFigure && !hasCsv) return null;

  const run = async (kind: 'png' | 'svg' | 'csv') => {
    setBusy(kind);
    try {
      if (kind === 'csv') exportCsv(csvRows!, `${filename}.csv`);
      else {
        const el = getElement?.();
        if (!el) return;
        if (kind === 'png') await exportElementAsPng(el, `${filename}.png`);
        else await exportElementAsSvg(el, `${filename}.svg`);
      }
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" className="od-btn" onClick={() => setOpen((v) => !v)} title="Export…">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M8 1v9m0 0 3-3m-3 3-3-3M2 13h12" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        Export
      </button>
      {open && (
        <div className="od-menu">
          {hasFigure && (
            <>
              <button type="button" onClick={() => run('png')} disabled={!!busy}>{busy === 'png' ? 'Exporting…' : 'PNG'}</button>
              <button type="button" onClick={() => run('svg')} disabled={!!busy}>{busy === 'svg' ? 'Exporting…' : 'SVG'}</button>
            </>
          )}
          {hasCsv && <button type="button" onClick={() => run('csv')} disabled={!!busy}>{busy === 'csv' ? 'Exporting…' : 'Data as CSV'}</button>}
        </div>
      )}
    </div>
  );
}
