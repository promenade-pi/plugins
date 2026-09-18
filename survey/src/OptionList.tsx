import { useCallback, useEffect, useRef, useState } from 'react';
import { moveItem } from './model';

/**
 * The options of a choice, multi-choice or ordering question.
 *
 * This was a textarea taking one option per line, and it was broken in a way
 * worth remembering: the change handler dropped empty lines, so pressing Enter
 * produced a line that the very next render deleted. A controlled input whose
 * handler cannot represent the intermediate state the user is typing through
 * is unusable, and no amount of care in the handler fixes it — the fix is a
 * control where each option is its own field and "add" is its own action.
 *
 * Rows are draggable by the handle on the left, and movable with the arrow
 * keys while that handle has focus. Both, not either: drag is the obvious
 * gesture, and it is also the one that does not work from a keyboard, in a
 * screen reader, or on a trackpad someone is fighting.
 */

interface Row {
  /** Stable across reorders, so React keeps focus in the field being typed in. */
  id: number;
  text: string;
}

let nextRowId = 1;
const rowsOf = (options: string[]): Row[] => options.map((text) => ({ id: nextRowId++, text }));

export function OptionList({ options, onChange, addLabel }: {
  options: string[];
  onChange: (options: string[]) => void;
  addLabel: string;
}) {
  /**
   * The rows are local state, not derived from the prop on every render.
   *
   * An option being typed can be empty or a duplicate, and both are states the
   * parent's array cannot distinguish — keying off the strings would collapse
   * two blank rows into one and move the caret. The component is mounted with
   * `key={step.id}` by the editor, so switching steps rebuilds it from props;
   * in between, this owns the list and reports every change upward.
   */
  const [rows, setRows] = useState<Row[]>(() => rowsOf(options));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fieldRefs = useRef<Array<HTMLInputElement | null>>([]);
  const handleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Set when a row was just added, so the new field can take focus. */
  const focusRow = useRef<number | null>(null);

  const commit = useCallback((next: Row[]) => {
    setRows(next);
    // Blank rows are a typing state, not an option: they are kept on screen and
    // left out of what the survey stores, so the validator's "at least two
    // options" reflects what will actually be asked.
    onChange(next.map((r) => r.text.trim()).filter(Boolean));
  }, [onChange]);

  useEffect(() => {
    if (focusRow.current == null) return;
    fieldRefs.current[focusRow.current]?.focus();
    focusRow.current = null;
  });

  const add = (at: number) => {
    const next = [...rows];
    next.splice(at, 0, { id: nextRowId++, text: '' });
    focusRow.current = at;
    commit(next);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    commit(moveItem(rows, from, to));
    // Keep the handle under the same item after it moves, so a second arrow
    // press continues the move instead of grabbing whatever slid into place.
    requestAnimationFrame(() => handleRefs.current[to]?.focus());
  };

  // Dragging is tracked on the window: a pointer that leaves the row mid-drag
  // (which it does, immediately) must not end it.
  useEffect(() => {
    if (dragging == null) return;
    const onMove = (e: MouseEvent) => {
      const items = Array.from(listRef.current?.querySelectorAll('li') ?? []);
      let target = items.length;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { target = i; break; }
      }
      setOver(target);
    };
    const onUp = () => {
      setDragging((from) => {
        setOver((to) => {
          if (from != null && to != null) {
            // The insertion index counts slots *before* removal, so dropping
            // below the dragged row means one slot back once it is gone.
            commit(moveItem(rows, from, to > from ? to - 1 : to));
          }
          return null;
        });
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, rows, commit]);

  return (
    <div className="sv-optlist">
      <ul ref={listRef} className={dragging != null ? 'dragging' : ''}>
        {rows.map((row, i) => (
          <li
            key={row.id}
            className={`${dragging === i ? 'is-dragging' : ''}${over === i && dragging != null ? ' drop-before' : ''}`}
          >
            <button
              type="button"
              className="sv-grab"
              ref={(el) => { handleRefs.current[i] = el; }}
              aria-label={`Reorder option ${i + 1}. Use the arrow keys to move it.`}
              onMouseDown={(e) => { e.preventDefault(); setDragging(i); setOver(i); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
              }}
            >
              <span aria-hidden="true">⠿</span>
            </button>
            <input
              ref={(el) => { fieldRefs.current[i] = el; }}
              value={row.text}
              placeholder={`Option ${i + 1}`}
              onChange={(e) => commit(rows.map((r) => (r.id === row.id ? { ...r, text: e.target.value } : r)))}
              onKeyDown={(e) => {
                // Enter is what the old textarea's newline was reaching for.
                if (e.key === 'Enter') { e.preventDefault(); add(i + 1); }
                // Backspace in an empty field removes it, so a row added by
                // mistake goes away the way an extra line would have.
                if (e.key === 'Backspace' && !row.text && rows.length > 1) {
                  e.preventDefault();
                  focusRow.current = Math.max(0, i - 1);
                  commit(rows.filter((r) => r.id !== row.id));
                }
              }}
            />
            <button
              type="button" className="sv-optdel" aria-label={`Remove option ${i + 1}`}
              onClick={() => commit(rows.filter((r) => r.id !== row.id))}
            >
              ✕
            </button>
          </li>
        ))}
        {over === rows.length && dragging != null && <li className="drop-end" aria-hidden="true" />}
      </ul>
      <button type="button" className="sv-btn quiet" onClick={() => add(rows.length)}>
        + {addLabel}
      </button>
    </div>
  );
}
