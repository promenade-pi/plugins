import { useEffect, useState } from 'react';
import { escapeLiteral, queryTables, debounce } from './sql';
import type { DeclaredType } from '../promenade';

/** Declared object types for the open artifact — instant, no query: the
 * same source ocelot's own Overview reads (`artifact().semantics`). Includes
 * a type with zero instances, which is deliberate (see ocelot's own
 * convention) — a type nobody has used yet is still worth being able to
 * pick and see "no data" for. */
export function useObjectTypes(): DeclaredType[] {
  return promenade.artifact().semantics?.objectTypes ?? [];
}

export function useActivities(): DeclaredType[] {
  return promenade.artifact().semantics?.eventTypes ?? [];
}

function Select({ value, onChange, options, placeholder, disabled }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select className="od-input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function ObjectTypeSelector({ value, onChange, placeholder = 'Select object type…' }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const types = useObjectTypes();
  return <Select value={value} onChange={onChange} placeholder={placeholder} options={types.map((t) => ({ value: t.name, label: t.name }))} />;
}

export function ActivitySelector({ value, onChange, placeholder = 'Select activity…', names, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  /** Overrides the full declared activity list with a caller-computed,
   * data-bound subset — e.g. Activity Timing scoping A to activities
   * actually observed on the selected object type. Omit for the plain,
   * unfiltered list every other caller uses. */
  names?: string[];
  disabled?: boolean;
}) {
  const declared = useActivities();
  const options = names ?? declared.map((t) => t.name);
  return <Select value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} options={options.map((n) => ({ value: n, label: n }))} />;
}

/** Multi-select checklist for activities — used where the spec calls for
 * "an activity or activities" (Attribute Distribution's event-attribute
 * mode). Deliberately a checklist, not a native multi-select: it stays
 * legible past a handful of activities and matches the rest of the family's
 * chip-based vocabulary. */
export function ActivityMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const activities = useActivities();
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  return (
    <div className="od-chip-cloud">
      {activities.map((a) => (
        <button key={a.name} type="button" className={`od-chip od-chip-clickable${value.includes(a.name) ? ' active' : ''}`} onClick={() => toggle(a.name)}>
          {a.name}
        </button>
      ))}
      {activities.length === 0 && <span className="od-muted">No activities declared.</span>}
    </div>
  );
}

/** A plain enum select for a fixed, small option list — attribute list,
 * duration unit, pairing strategy, chart mode: anything whose choices are
 * known ahead of time rather than data-bound. */
export function EnumSelect({ value, onChange, options, disabled }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; disabled?: boolean;
}) {
  return <Select value={value} onChange={onChange} options={options} disabled={disabled} />;
}

export const DURATION_UNITS = [
  { value: 'auto', label: 'Auto' },
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
] as const;
export type DurationUnit = typeof DURATION_UNITS[number]['value'];

export function DurationUnitSelector({ value, onChange }: { value: DurationUnit; onChange: (v: DurationUnit) => void }) {
  return <EnumSelect value={value} onChange={(v) => onChange(v as DurationUnit)} options={[...DURATION_UNITS]} />;
}

/** Attribute picker: single- or multi-select over a data-bound name list
 * supplied by the caller (from `objectState.ts`'s `getObjectAttributeNames`
 * / `getEventAttributeNames` — ground truth from the data, scoped to
 * whatever object type / activity is currently selected). */
export function AttributeSelector({ names, value, onChange, multiple, placeholder = 'Select attribute…' }: {
  names: string[]; value: string | string[]; onChange: (v: any) => void; multiple?: boolean; placeholder?: string;
}) {
  if (multiple) {
    const selected = value as string[];
    const toggle = (name: string) => onChange(selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name]);
    return (
      <div className="od-chip-cloud">
        {names.map((n) => (
          <button key={n} type="button" className={`od-chip od-chip-clickable${selected.includes(n) ? ' active' : ''}`} onClick={() => toggle(n)}>{n}</button>
        ))}
        {names.length === 0 && <span className="od-muted">No attributes recorded.</span>}
      </div>
    );
  }
  return <Select value={value as string} onChange={onChange} placeholder={placeholder} options={names.map((n) => ({ value: n, label: n }))} />;
}

/** Search-as-you-type object picker, scoped to one object type — the list of
 * objects itself can run into the thousands, so this never loads the full
 * set: each keystroke re-queries `{object}` with a `LIKE`/`LIMIT`, the same
 * discipline `ocelot`'s own paginated tables use. */
export function ObjectSelector({ objectType, value, onChange }: {
  objectType: string; value: string; onChange: (v: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    if (!objectType) { setOptions([]); return; }
    const run = debounce((q: string) => {
      const like = escapeLiteral(`%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`);
      queryTables<{ object_id: string }>(`
        SELECT object_id FROM {object} WHERE object_type = ${escapeLiteral(objectType)}
          ${q ? `AND object_id ILIKE ${like} ESCAPE '\\'` : ''}
        ORDER BY object_id LIMIT 50
      `).then((rows) => setOptions(rows.map((r) => r.object_id)));
    }, 140);
    run(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType, query]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="od-input"
        placeholder={objectType ? `Search ${objectType} objects…` : 'Select an object type first'}
        disabled={!objectType}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && options.length > 0 && (
        <div className="od-menu" style={{ left: 0, maxHeight: 220, overflowY: 'auto' }}>
          {options.map((id) => (
            <button key={id} type="button" onClick={() => { onChange(id); setQuery(id); setOpen(false); }}>{id}</button>
          ))}
        </div>
      )}
    </div>
  );
}
