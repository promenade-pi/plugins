import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cell, fillSeries, type ColumnSpec, type Row } from './model';

/**
 * A spreadsheet grid: one active cell, a rectangular selection, a fill handle
 * that continues a pattern, clipboard paste from a real spreadsheet, and
 * per-column autocomplete.
 *
 * Hand-rolled rather than pulled from a data-grid package, for two reasons
 * that both come from the sandbox: the frame's CSP forbids external
 * stylesheets (so a library's CSS has to be inlined anyway) and the bundle is
 * eval'd as one classic script, so every kilobyte is a kilobyte the host
 * fetches before the panel can paint. What is actually needed here — fixed
 * columns, a few hundred rows at most, keyboard navigation and a fill handle
 * — is small enough to own.
 *
 * Clipboard access goes through the `copy`/`paste` DOM events rather than
 * `navigator.clipboard`: the async API needs a permission an opaque-origin
 * frame cannot be granted, while the events fire normally because the user's
 * own keystroke is what triggers them.
 *
 * The grid knows nothing about OCEL. Which columns exist, which cells a row
 * is allowed to fill in, what completes inside a cell and what counts as a
 * legal value all arrive as *per-cell* callbacks — the schema lives in
 * `model.ts` and is edited on the Types tab. Per cell rather than per column
 * because a declaration can be named by another cell in the same row: the
 * Changes sheet's `value` is typed by whichever attribute that row names.
 */

/** Blank rows kept below the data so the sheet always has somewhere to type. */
const SPARE_ROWS = 4;

interface Cursor { r: number; c: number }

export function Grid({
  columns, rows, completionsAt, allowedAt, errorAt, spare = true, rowAction, onChange, onActiveRow,
}: {
  columns: ColumnSpec[];
  rows: Row[];
  /** Completions for one cell, given the row it is in. */
  completionsAt?: (rowIndex: number, column: ColumnSpec) => string[];
  /**
   * Whether a cell may be edited — how a declared type reaches the grid. A
   * cell its row's type does not have is shown as unavailable and cannot be
   * typed into, pasted over or filled: an attribute belongs to a type, not to
   * a column position.
   */
  allowedAt?: (rowIndex: number, column: ColumnSpec) => boolean;
  /** What is wrong with a cell's current text, if anything. */
  errorAt?: (rowIndex: number, column: ColumnSpec) => string | null;
  /**
   * Whether blank rows are offered below the data. False on any page but the
   * last: a row typed "below page 3" of a paged sheet would not stay there.
   */
  spare?: boolean;
  /**
   * A trailing, non-spreadsheet action per row — the "+ relation" button on
   * Events/Objects. Returning null renders an empty cell (a spare row with no
   * id yet has nothing to act on); the column itself only appears when this
   * prop is passed at all, so sheets that don't need it stay unchanged.
   */
  rowAction?: (rowIndex: number) => ReactNode;
  onChange: (rows: Row[]) => void;
  onActiveRow?: (rowIndex: number) => void;
}) {
  const rowCount = rows.length + (spare ? SPARE_ROWS : 0);

  const [active, setActive] = useState<Cursor>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Cursor>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ r: number; c: number; value: string; pick: number } | null>(null);
  const [dragging, setDragging] = useState<'select' | 'fill' | null>(null);
  const [fillTo, setFillTo] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLInputElement>(null);

  // The rows the callbacks below read: they must never write a stale array
  // back over a newer one.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const at = (r: number, key: string) => cell(rowsRef.current[r], key);
  const allowed = (r: number, c: number) => !allowedAt || allowedAt(r, columns[c]);

  useEffect(() => { onActiveRow?.(active.r); }, [active.r, onActiveRow]);

  /** Writes cells, growing the rows array to fit whatever was addressed. */
  const write = (edits: Array<{ r: number; key: string; value: string }>) => {
    const next = rowsRef.current.map((row) => ({ ...row }));
    const highest = Math.max(...edits.map((e) => e.r), -1);
    while (next.length <= highest) next.push({});
    for (const { r, key, value } of edits) next[r][key] = value;
    // Trailing rows the user has just emptied are dropped, so the sheet does
    // not accumulate invisible blank rows that publishing then has to ignore.
    while (next.length && Object.values(next[next.length - 1]).every((v) => !v?.trim())) next.pop();
    onChange(next);
  };

  const selection = {
    top: Math.min(active.r, anchor.r),
    bottom: Math.max(active.r, anchor.r),
    left: Math.min(active.c, anchor.c),
    right: Math.max(active.c, anchor.c),
  };
  const inSelection = (r: number, c: number) =>
    r >= selection.top && r <= selection.bottom && c >= selection.left && c <= selection.right;
  const inFillPreview = (r: number, c: number) =>
    dragging === 'fill' && fillTo !== null && c >= selection.left && c <= selection.right
    && r > selection.bottom && r <= fillTo;

  const move = (dr: number, dc: number, extend = false) => {
    const r = Math.max(0, Math.min(rowCount - 1, active.r + dr));
    const c = Math.max(0, Math.min(columns.length - 1, active.c + dc));
    setActive({ r, c });
    if (!extend) setAnchor({ r, c });
  };

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!allowed(r, c)) return;
    setActive({ r, c });
    setAnchor({ r, c });
    setEditing({ r, c, value: initial ?? at(r, columns[c].key), pick: -1 });
  };

  const commitEdit = (advance: 'down' | 'right' | 'none') => {
    if (!editing) return;
    write([{ r: editing.r, key: columns[editing.c].key, value: editing.value }]);
    setEditing(null);
    if (advance === 'down') move(1, 0);
    if (advance === 'right') move(0, 1);
    root.current?.focus();
  };

  // Completions for the cell being edited, prefix matches first — the value
  // someone is halfway through typing is far likelier than one that merely
  // contains what they typed.
  const completions = (() => {
    if (!editing) return [];
    const all = completionsAt?.(editing.r, columns[editing.c]) ?? [];
    if (!all.length) return [];
    const typed = editing.value.trim().toLowerCase();
    const starts = all.filter((v) => v.toLowerCase().startsWith(typed) && v.toLowerCase() !== typed);
    const contains = all.filter((v) => !starts.includes(v) && typed && v.toLowerCase().includes(typed));
    return [...starts, ...contains].slice(0, 8);
  })();

  const acceptCompletion = (value: string, advance: 'down' | 'right') => {
    if (!editing) return;
    write([{ r: editing.r, key: columns[editing.c].key, value }]);
    setEditing(null);
    if (advance === 'down') move(1, 0);
    else move(0, 1);
    root.current?.focus();
  };

  useLayoutEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing?.r, editing?.c]);

  // A fill drag can end anywhere, including outside the grid, so the release
  // is watched on the window rather than on a cell.
  useEffect(() => {
    if (!dragging) return;
    const onUp = () => {
      if (dragging === 'fill' && fillTo !== null && fillTo > selection.bottom) {
        const edits: Array<{ r: number; key: string; value: string }> = [];
        for (let c = selection.left; c <= selection.right; c++) {
          const column = columns[c];
          const seed: string[] = [];
          for (let r = selection.top; r <= selection.bottom; r++) seed.push(at(r, column.key));
          const values = fillSeries(seed, fillTo - selection.bottom, column.kind, column.attr);
          values.forEach((value, i) => {
            const r = selection.bottom + 1 + i;
            if (allowed(r, c)) edits.push({ r, key: column.key, value });
          });
        }
        if (edits.length) {
          write(edits);
          setAnchor({ r: selection.top, c: selection.left });
          setActive({ r: fillTo, c: selection.right });
        }
      }
      setDragging(null);
      setFillTo(null);
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [dragging, fillTo, selection.top, selection.bottom, selection.left, selection.right]);

  const selectedText = () => {
    const lines: string[] = [];
    for (let r = selection.top; r <= selection.bottom; r++) {
      const cells: string[] = [];
      for (let c = selection.left; c <= selection.right; c++) cells.push(at(r, columns[c].key));
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.clipboardData.setData('text/plain', selectedText());
    e.preventDefault();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const grid = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
    const edits: Array<{ r: number; key: string; value: string }> = [];
    grid.forEach((line, dr) => line.forEach((value, dc) => {
      const c = active.c + dc;
      const r = active.r + dr;
      if (c >= columns.length) return;
      // A pasted block lands only where cells exist: a spreadsheet column
      // pasted across rows of different types must not smuggle values into
      // attributes those types never declared.
      if (!allowed(r, c)) return;
      edits.push({ r, key: columns[c].key, value: value.trim() });
    }));
    if (!edits.length) return;
    write(edits);
    setAnchor({ r: active.r, c: active.c });
    setActive({
      r: active.r + grid.length - 1,
      c: Math.min(columns.length - 1, active.c + Math.max(...grid.map((l) => l.length)) - 1),
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) {
      if (e.key === 'Escape') { setEditing(null); root.current?.focus(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown' && completions.length) {
        setEditing({ ...editing, pick: Math.min(completions.length - 1, editing.pick + 1) });
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp' && completions.length) {
        setEditing({ ...editing, pick: Math.max(-1, editing.pick - 1) });
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const advance = e.key === 'Tab' ? 'right' : 'down';
        // Enter with a highlighted completion takes it; with none it commits
        // what was typed, so a new value never needs an extra keystroke to
        // escape the suggestion list.
        if (editing.pick >= 0 && completions[editing.pick]) acceptCompletion(completions[editing.pick], advance);
        else commitEdit(advance);
        e.preventDefault();
        return;
      }
      return;
    }

    const meta = e.metaKey || e.ctrlKey;
    if (meta) return; // copy/paste/undo are handled by their own events

    switch (e.key) {
      case 'ArrowDown': move(1, 0, e.shiftKey); break;
      case 'ArrowUp': move(-1, 0, e.shiftKey); break;
      case 'ArrowLeft': move(0, -1, e.shiftKey); break;
      case 'ArrowRight': move(0, 1, e.shiftKey); break;
      case 'Tab': move(0, e.shiftKey ? -1 : 1); break;
      case 'Enter':
      case 'F2': startEdit(active.r, active.c); break;
      case 'Backspace':
      case 'Delete': {
        const edits: Array<{ r: number; key: string; value: string }> = [];
        for (let r = selection.top; r <= selection.bottom; r++) {
          for (let c = selection.left; c <= selection.right; c++) {
            if (allowed(r, c)) edits.push({ r, key: columns[c].key, value: '' });
          }
        }
        if (edits.length) write(edits);
        break;
      }
      default:
        // Typing replaces the cell, exactly as in a spreadsheet: the first
        // character starts the edit instead of being swallowed.
        if (e.key.length === 1 && !e.altKey) startEdit(active.r, active.c, e.key);
        else return;
    }
    e.preventDefault();
  };

  return (
    <div
      className="grid"
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
    >
      <div className="grid-scroll">
        <table style={{ width: columns.reduce((w, c) => w + c.width, 44) + (rowAction ? 32 : 0) }}>
          <thead>
            <tr>
              <th className="rownum" />
              {columns.map((column) => (
                <th
                  key={column.key}
                  style={{ width: column.width }}
                  title={column.hint}
                  className={column.attr ? 'attrcol' : ''}
                >
                  <span>{column.label}</span>
                  {column.required && <em title="required">*</em>}
                  {column.attr && <i>{column.attr.type}</i>}
                </th>
              ))}
              {rowAction && <th className="rowaction" />}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, r) => (
              <tr key={r}>
                <td className="rownum">{r + 1}</td>
                {columns.map((column, c) => {
                  const isActive = active.r === r && active.c === c;
                  const isEditing = editing?.r === r && editing?.c === c;
                  const isCorner = r === selection.bottom && c === selection.right;
                  const usable = allowed(r, c);
                  const value = at(r, column.key);
                  const bad = usable ? errorAt?.(r, column) ?? null : null;
                  return (
                    <td
                      key={column.key}
                      title={bad ? `${column.label} ${bad}` : undefined}
                      className={[
                        inSelection(r, c) ? 'sel' : '',
                        isActive ? 'active' : '',
                        inFillPreview(r, c) ? 'fillpreview' : '',
                        column.kind === 'timestamp' ? 'ts' : '',
                        usable ? '' : 'unavailable',
                        bad ? 'bad' : '',
                      ].filter(Boolean).join(' ')}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (editing) commitEdit('none');
                        setActive({ r, c });
                        if (!e.shiftKey) setAnchor({ r, c });
                        setDragging('select');
                        root.current?.focus();
                      }}
                      // `onMouseOver`, not `onMouseEnter`: a cell is a leaf, so
                      // the two are equivalent while dragging, and this one is
                      // a real bubbling DOM event — which keeps the drag paths
                      // (range select, fill) reachable from a test that
                      // dispatches events rather than owning a physical mouse.
                      onMouseOver={() => {
                        if (dragging === 'select') setActive({ r, c });
                        if (dragging === 'fill') setFillTo(Math.max(selection.bottom, r));
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {isEditing
                        ? (
                          <div className="editwrap">
                            <input
                              ref={editor}
                              value={editing.value}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value, pick: -1 })}
                              onBlur={() => commitEdit('none')}
                            />
                            {completions.length > 0 && (
                              <ul className="complete">
                                {completions.map((option, i) => (
                                  <li
                                    key={option}
                                    className={i === editing.pick ? 'on' : ''}
                                    // mousedown, not click: the editor's blur
                                    // would commit and unmount the list first.
                                    onMouseDown={(e) => { e.preventDefault(); acceptCompletion(option, 'down'); }}
                                  >
                                    {option}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )
                        : <span className="val">{value}</span>}
                      {isCorner && !isEditing && (
                        <span
                          className="handle"
                          title="Drag to fill — continues a pattern (o1, o2, o3…)"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setDragging('fill');
                            setFillTo(selection.bottom);
                          }}
                        />
                      )}
                    </td>
                  );
                })}
                {rowAction && <td className="rowaction">{rowAction(r)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
