import { useEffect, useRef, useState } from 'react';
import { ControlButton, useReactFlow } from '@xyflow/react';
import { exportElementAsPdf, exportElementAsPng, exportElementAsSvg } from './exportFigure';

type Kind = 'png' | 'svg' | 'pdf';

/** A React Flow `<Controls>` button that opens a PNG/SVG/PDF submenu and
 * exports the `.react-flow` root as a figure. Self-contained (inline
 * styles only) so it can be dropped into any plugin's Controls without
 * pulling in that plugin's own stylesheet. */
export function ExportMenu({ filename, getElement }: { filename: string; getElement?: () => HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { getNodes, getViewport, setViewport, fitView } = useReactFlow();

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const resolveElement = () => (getElement ? getElement() : document.querySelector('.react-flow')) as HTMLElement | null;

  const run = async (kind: Kind) => {
    const el = resolveElement();
    if (!el) return;
    setBusy(kind);
    // A figure export should capture the whole model, not just whatever
    // happens to be panned/zoomed into view — and if this view uses
    // `onlyRenderVisibleElements`, an off-screen node isn't even in the DOM
    // to capture. Fit the full node set into view first (instantly, no
    // animation) so everything is rendered and visible, then restore the
    // user's own viewport afterwards; they never see the jump because it
    // happens and reverts between paints.
    const nodes = getNodes();
    const prevViewport = nodes.length > 0 ? getViewport() : null;
    if (prevViewport) {
      fitView({ padding: 0.1, duration: 0 });
      // Let React Flow mount newly-visible nodes and apply the new
      // transform before the DOM is captured.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    try {
      if (kind === 'png') await exportElementAsPng(el, `${filename}.png`);
      else if (kind === 'svg') await exportElementAsSvg(el, `${filename}.svg`);
      else await exportElementAsPdf(el, `${filename}.pdf`);
    } finally {
      if (prevViewport) setViewport(prevViewport, { duration: 0 });
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <ControlButton onClick={() => setOpen((v) => !v)} title="Export as figure…">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <path d="M8 1v9m0 0 3-3m-3 3-3-3M2 13h12" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </ControlButton>
      {open && (
        <div
          style={{
            position: 'absolute', left: '100%', bottom: 0, marginLeft: 4,
            background: 'var(--bg, #fff)', border: '1px solid var(--border, #ccc)', borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)', minWidth: 92, overflow: 'hidden', zIndex: 20,
            fontSize: 12, fontFamily: 'inherit',
          }}
        >
          {(['png', 'svg', 'pdf'] as const).map((kind) => (
            <button
              key={kind}
              onClick={() => run(kind)}
              disabled={busy !== null}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                background: 'transparent', border: 'none', color: 'var(--text, #222)',
                cursor: busy ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = 'var(--bg-soft, #eee)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {busy === kind ? 'Exporting…' : kind.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
