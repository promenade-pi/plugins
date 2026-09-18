import { useEffect, useMemo, useState } from 'react';
import type { ParquetFile } from './promenade';
import { fmtBytes, fmtInt, isNumericType } from './format';

const PAGE_SIZES = [50, 100, 250, 1000];

/** Doubling is the whole escape rule for a quoted SQL identifier. */
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * One page of a Parquet file's rows.
 *
 * Values are cast to VARCHAR in the query rather than formatted here, and
 * that is the load-bearing decision in this file: DuckDB is the thing that
 * read the file, so letting it render is the only way a raw viewer can
 * promise that what is on screen is what the file says. It also means every
 * type works — DECIMAL, LIST, STRUCT, BLOB, a TIMESTAMP whose unit would
 * otherwise have to be guessed at on this side of the boundary — instead of
 * only the types a hand-written formatter happened to cover.
 *
 * Only visible columns are selected, so hiding columns on a wide file makes
 * the query cheaper rather than merely making the table narrower.
 */
export function ParquetTable({ file }: { file: ParquetFile }) {
  const [pageSize, setPageSize] = useState(100);
  const [offset, setOffset] = useState(0);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [showCols, setShowCols] = useState(false);
  // Rows and the columns they were fetched for, as one value.
  //
  // Two pieces of state would let them disagree for exactly one render — hide
  // a column and the rows still have the old width, so `visible[i]` for the
  // last cell is `undefined` — and that render is a crash, not a glitch. It
  // also means the previous page stays on screen while the next one loads,
  // rather than the table blanking on every click.
  const [page, setPage] = useState<{ cols: ParquetFile['columns']; rows: Array<Array<unknown>> } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jump, setJump] = useState('');

  // A new file means a new schema: page position and column choices belong to
  // the file that was open, not to the panel.
  useEffect(() => {
    setOffset(0);
    setHidden({});
    setPage(null);
    setBusy(true);
    setError(null);
  }, [file.path, file.relation]);

  const visible = useMemo(
    () => file.columns.filter((c) => !hidden[c.name]),
    [file.columns, hidden]
  );

  useEffect(() => {
    let stale = false;
    if (!visible.length) { setPage({ cols: visible, rows: [] }); setBusy(false); return; }
    const select = visible
      .map((c, i) => `CAST(${quote(c.name)} AS VARCHAR) AS c${i}`)
      .join(', ');
    setError(null);
    setBusy(true);
    promenade
      .sql(`SELECT ${select} FROM ${file.relation} LIMIT ${pageSize} OFFSET ${offset}`)
      .then((result) => {
        if (stale) return;
        const out: Array<Array<unknown>> = [];
        for (let r = 0; r < result.numRows; r++) {
          out.push(visible.map((_, i) => (result.columns[`c${i}`] as ArrayLike<unknown>)?.[r] ?? null));
        }
        setPage({ cols: visible, rows: out });
        setBusy(false);
      })
      .catch((err) => {
        if (stale) return;
        setPage({ cols: visible, rows: [] });
        setBusy(false);
        setError(String(err?.message ?? err));
      });
    // A page request the user has already navigated past must not paint over
    // the one they are waiting for.
    return () => { stale = true; };
  }, [file.relation, pageSize, offset, visible]);

  const lastOffset = Math.max(0, Math.floor(Math.max(0, file.rows - 1) / pageSize) * pageSize);
  // Never `visible` here: the table must be drawn with the columns the rows in
  // hand actually have. `visible` is only the header before the first page.
  const cols = page?.cols ?? visible;
  const rows = page?.rows ?? [];
  const shown = rows.length;

  const goToRow = () => {
    const n = Number(jump);
    if (!Number.isFinite(n) || n < 1) return;
    setOffset(Math.min(lastOffset, Math.floor((Math.min(n, file.rows) - 1) / pageSize) * pageSize));
  };

  return (
    <>
      <div className="raw-head">
        <span className="raw-path">{file.path}</span>
        <span className="raw-chip">{fmtInt(file.rows)} rows</span>
        <span className="raw-chip">{file.columns.length} cols</span>
        <span className="raw-chip">{fmtBytes(file.size)}</span>
        {file.rowGroups != null && (
          <span className="raw-chip">{file.rowGroups} row group{file.rowGroups === 1 ? '' : 's'}</span>
        )}
        {file.compression && <span className="raw-chip">{file.compression}</span>}
        {file.createdBy && (
          <span className="raw-chip" title={file.createdBy}>{file.createdBy.split(/[ ,(]/)[0]}</span>
        )}
        <span className="raw-spacer" />
        <button
          type="button"
          className={`raw-btn${showCols ? ' on' : ''}`}
          onClick={() => setShowCols((v) => !v)}
        >
          Columns {visible.length}/{file.columns.length}
        </button>
      </div>

      {showCols && (
        <div className="raw-cols">
          <button type="button" className="raw-btn" onClick={() => setHidden({})}>All</button>
          <button
            type="button"
            className="raw-btn"
            // Never hide the last one: a table with no columns at all is not a
            // state worth being able to reach.
            onClick={() => setHidden(Object.fromEntries(file.columns.slice(1).map((c) => [c.name, true])))}
          >
            None
          </button>
          {file.columns.map((c) => (
            <label className="raw-col-toggle" key={c.name}>
              <input
                type="checkbox"
                checked={!hidden[c.name]}
                onChange={() => setHidden((h) => {
                  const next = { ...h, [c.name]: !h[c.name] };
                  return file.columns.every((col) => next[col.name]) ? h : next;
                })}
              />
              {c.name} <code>{c.type}</code>
            </label>
          ))}
        </div>
      )}

      {error && <div className="raw-err">{error}</div>}

      <div className="raw-scroll">
        <table className="raw-table">
          <thead>
            <tr>
              <th className="gutter">#</th>
              {cols.map((c) => (
                <th key={c.name} className={isNumericType(c.type) ? 'num' : ''} title={`${c.name} · ${c.type}`}>
                  {c.name}
                  <span className="t">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={offset + r}>
                <td className="gutter">{fmtInt(offset + r + 1)}</td>
                {row.map((v, i) => (
                  <td
                    key={cols[i].name}
                    className={isNumericType(cols[i].type) ? 'num' : ''}
                    title={v == null ? 'NULL' : String(v)}
                  >
                    {v == null ? <span className="raw-null">NULL</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <div className="raw-busy">Reading…</div>}
        {!busy && !rows.length && !error && <div className="raw-note">No rows.</div>}
      </div>

      <div className="raw-foot">
        <button type="button" className="raw-btn" disabled={offset === 0} onClick={() => setOffset(0)}>«</button>
        <button
          type="button" className="raw-btn" disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
        >‹</button>
        <span className="raw-range">
          {shown ? `${fmtInt(offset + 1)}–${fmtInt(offset + shown)}` : '0'} of {fmtInt(file.rows)}
        </span>
        <button
          type="button" className="raw-btn" disabled={offset >= lastOffset}
          onClick={() => setOffset(Math.min(lastOffset, offset + pageSize))}
        >›</button>
        <button
          type="button" className="raw-btn" disabled={offset >= lastOffset}
          onClick={() => setOffset(lastOffset)}
        >»</button>
        <span className="raw-spacer" />
        <input
          type="text" value={jump} placeholder="Jump to row"
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') goToRow(); }}
        />
        <button type="button" className="raw-btn" onClick={goToRow}>Go</button>
        <select
          value={pageSize}
          onChange={(e) => {
            const next = Number(e.target.value);
            // Keep the first visible row visible, so changing the page size
            // does not also lose the user's place in the file.
            setOffset(Math.floor(offset / next) * next);
            setPageSize(next);
          }}
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>
    </>
  );
}
