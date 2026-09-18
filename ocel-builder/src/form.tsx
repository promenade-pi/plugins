import {
  attributesForRow, cell, declarationsOf, valueError,
  type AttrType, type Doc, type Row, type SheetSpec,
} from './model';

/**
 * The typed form for one row of a typed sheet.
 *
 * The grid is the fast way to enter many rows; this is the precise way to
 * enter one. It shows exactly the fields the row's declared type has — no
 * columns belonging to other types — with a control per declared value type: a
 * number field for an integer, a true/false choice for a boolean, a date-time
 * picker for a time. That is the part a grid of text cells cannot do, and the
 * reason declaring types is worth the keystrokes.
 */

function controlFor(type: AttrType, value: string, onChange: (v: string) => void) {
  switch (type) {
    case 'integer':
      return <input type="number" step={1} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'float':
      return <input type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'boolean':
      // A select, not a checkbox: an attribute can also be *unset*, and a
      // checkbox has no way to say that.
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case 'time':
      return (
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function RowForm({ doc, spec, rowIndex, defaults = {}, onRows, onGoToTypes }: {
  doc: Doc;
  spec: SheetSpec;
  rowIndex: number;
  /**
   * Filled into a row this form creates — the per-type tab's own type, so a
   * row added from the form belongs to the tab it was added in.
   */
  defaults?: Row;
  onRows: (rows: Row[]) => void;
  onGoToTypes: () => void;
}) {
  const rows = doc.sheets[spec.key].rows;
  const row = rows[rowIndex] ?? defaults;
  const typeColumn = spec.typedBy!.column;
  const typeName = cell(row, typeColumn).trim();
  const declared = declarationsOf(doc, spec.typedBy!.kind);
  const attributes = attributesForRow(doc, spec, row);

  const set = (key: string, value: string) => {
    const next = rows.map((r) => ({ ...r }));
    while (next.length <= rowIndex) next.push({ ...defaults });
    next[rowIndex][key] = value;
    while (next.length && Object.values(next[next.length - 1]).every((v) => !v?.trim())) next.pop();
    onRows(next);
  };

  return (
    <aside className="rowform">
      <header>
        <h3>Row {rowIndex + 1}</h3>
        <span className="hint">{typeName || 'no type yet'}</span>
      </header>

      {spec.columns.map((column) => (
        <label key={column.key}>
          <span>{column.label}{column.required && <em>*</em>}</span>
          {column.key === typeColumn
            ? (
              <select value={cell(row, column.key)} onChange={(e) => set(column.key, e.target.value)}>
                <option value="">—</option>
                {declared.filter((d) => d.name.trim()).map((d) => (
                  <option key={d.name} value={d.name}>{d.name}</option>
                ))}
              </select>
            )
            : column.kind === 'timestamp'
              ? <input type="datetime-local" value={cell(row, column.key)} onChange={(e) => set(column.key, e.target.value)} />
              : <input value={cell(row, column.key)} onChange={(e) => set(column.key, e.target.value)} />}
        </label>
      ))}

      {!typeName && (
        <p className="empty">
          Pick a type above to see its attributes.
          {declared.length === 0 && <> None are declared yet — <button className="link" onClick={onGoToTypes}>declare one</button>.</>}
        </p>
      )}

      {attributes.map((attr) => {
        const value = cell(row, attr.name);
        const bad = valueError(attr.type, value);
        return (
          <label key={attr.name} className={bad ? 'bad' : ''}>
            <span>{attr.name}<i>{attr.type}</i></span>
            {controlFor(attr.type, value, (v) => set(attr.name, v))}
            {bad && <small>{bad}</small>}
          </label>
        );
      })}

      {typeName && attributes.length === 0 && (
        <p className="empty">
          “{typeName}” declares no attributes.{' '}
          <button className="link" onClick={onGoToTypes}>Add some</button>.
        </p>
      )}
    </aside>
  );
}
