import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArtifactFileEntry, BytesFile, ParquetFile } from './promenade';
import { buildTree, defaultSelection, totalBytes } from './tree';
import { FileTree } from './FileTree';
import { ParquetTable } from './ParquetTable';
import { RawBytes } from './RawBytes';
import { fmtBytes } from './format';
import css from './styles.css';

/**
 * Raw Artifact Viewer.
 *
 * Two panes: what is on disk for this artifact, and what one of those files
 * actually contains. It exists because every other view in Promenade shows an
 * artifact through an interpretation of it — a net, a map, a chart — and when
 * one of those looks wrong, the question that follows is whether the *storage*
 * is wrong, which nothing could previously answer.
 *
 * The list comes from `promenade.files()`, not from the artifact's declared
 * relations, and the difference is the point: a sidecar, a materialized JSON
 * payload, or a Parquet file whose relation has since been dropped are all
 * real bytes on disk that the catalog does not mention.
 */
function App() {
  const [entries, setEntries] = useState<ArtifactFileEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<ParquetFile | BytesFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(232);
  const artifact = promenade.artifact();

  // The listing and whatever this same panel was last looking at, together:
  // a remembered path is only usable once the list confirms the file is still
  // there, so waiting for both avoids a flash of the wrong selection.
  useEffect(() => {
    let stale = false;
    Promise.all([promenade.files(), promenade.cachedState().catch(() => null)])
      .then(([{ entries: list }, cached]) => {
        if (stale) return;
        const saved = (cached ?? null) as { path?: string; width?: number } | null;
        if (saved?.width) setWidth(saved.width);
        setEntries(list);
        setSelected(
          saved?.path && list.some((e) => e.path === saved.path)
            ? saved.path
            : defaultSelection(list)
        );
      })
      .catch((err) => { if (!stale) setError(String(err?.message ?? err)); });
    return () => { stale = true; };
  }, []);

  useEffect(() => {
    if (entries == null) return;
    promenade.setCachedState({ path: selected, width });
  }, [entries, selected, width]);

  useEffect(() => {
    if (!selected) { setOpened(null); return; }
    let stale = false;
    setOpened(null);
    setError(null);
    promenade.openFile(selected)
      .then((file) => { if (!stale) setOpened(file); })
      .catch((err) => { if (!stale) setError(String(err?.message ?? err)); });
    return () => { stale = true; };
  }, [selected]);

  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      // Clamped rather than free: a pane dragged to nothing is a pane the user
      // then has to guess how to get back.
      setWidth(Math.max(140, Math.min(520, drag.current.w + (e.clientX - drag.current.x))));
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  const tree = entries ? buildTree(entries) : [];

  return (
    <div className="raw">
      <div className="raw-side" style={{ width }}>
        <div className="raw-side-head">
          <b title={`${artifact.name} · ${artifact.type || 'artifact'}`}>artifacts/{artifact.id}</b>
          <span>{entries ? fmtBytes(totalBytes(entries)) : '…'}</span>
        </div>
        {entries == null && !error && <div className="raw-busy">Listing…</div>}
        {entries != null && !entries.length && (
          <div className="raw-note">
            No files. This artifact keeps its value in the catalog, or it lives on a
            compute engine rather than in this browser.
          </div>
        )}
        {entries != null && !!entries.length && (
          <FileTree nodes={tree} selected={selected} onSelect={setSelected} />
        )}
      </div>
      <div
        className="raw-grip"
        onMouseDown={(e) => { drag.current = { x: e.clientX, w: width }; e.preventDefault(); }}
      />
      <div className="raw-main">
        {error && <div className="raw-err">{error}</div>}
        {!error && !selected && <div className="raw-note">Pick a file.</div>}
        {!error && selected && !opened && <div className="raw-busy">Opening {selected}…</div>}
        {!error && opened?.kind === 'parquet' && <ParquetTable file={opened} />}
        {!error && opened?.kind === 'bytes' && <RawBytes file={opened} />}
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
promenade.ready();
