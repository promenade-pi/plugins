import { useEffect, useState } from 'react';
import {
  addE2O, addO2O, addObjectRow, cell, declarationsOf, objectIdExists, objectsList,
  relationsForEvent, relationsForObject, removeRelationRow, setRelationQualifier, suggestObjectId,
  suggestionsOf, type Doc,
} from './model';

/**
 * The "+ relation" dialog opened from an Events or Objects row.
 *
 * The grid is where a log's *own* rows live; a relation is a fact about two
 * rows at once (an event and an object, or two objects), which a spreadsheet
 * cell cannot hold. Rather than making the user find the E2O or O2O sheet and
 * type both ids there — the id of the row they just came from, and the id of
 * whatever they mean to link it to — this starts from the row already in
 * hand and asks only for the other side: an existing object, picked, or a new
 * one, typed and created in the same step.
 *
 * Deliberately not a data-entry replacement for the E2O/O2O sheets — it
 * writes exactly one relation at a time and shows only what this one row is
 * already linked to. Bulk relation entry (many events to a handful of
 * objects) is still faster as a grid with copy/paste and a fill handle, which
 * is what those sheets remain for.
 */

const OBJ_DATALIST = 'ocel-builder-objects';
const QUAL_DATALIST = 'ocel-builder-qualifiers';

export function RelationDialog({ doc, kind, ownerId, onChange, onClose, onGoToTypes }: {
  doc: Doc;
  kind: 'event' | 'object';
  ownerId: string;
  onChange: (doc: Doc) => void;
  onClose: () => void;
  onGoToTypes: () => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [pickText, setPickText] = useState('');
  const [newType, setNewType] = useState('');
  const [newId, setNewId] = useState('');
  const [qualifier, setQualifier] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const relations = kind === 'event' ? relationsForEvent(doc, ownerId) : relationsForObject(doc, ownerId);
  const relKey = kind === 'event' ? 'e2o' as const : 'o2o' as const;
  const objectTypes = declarationsOf(doc, 'object').filter((d) => d.name.trim());
  const qualifiers = suggestionsOf(doc).qualifier;

  const ownerLabel = (() => {
    if (kind === 'event') {
      const row = doc.sheets.events.rows.find((r) => cell(r, 'event_id').trim() === ownerId);
      return row ? `${ownerId} · ${cell(row, 'activity')}` : ownerId;
    }
    const row = doc.sheets.objects.rows.find((r) => cell(r, 'object_id').trim() === ownerId);
    return row ? `${ownerId} · ${cell(row, 'object_type')}` : ownerId;
  })();

  const canAdd = mode === 'existing' ? objectIdExists(doc, pickText) : !!(newType.trim() && newId.trim());

  const add = () => {
    setError(null);
    let next = doc;
    let targetId = pickText.trim();
    if (mode === 'new') {
      if (objectIdExists(next, newId)) { setError(`An object “${newId.trim()}” already exists.`); return; }
      next = addObjectRow(next, newId, newType);
      targetId = newId.trim();
    }
    next = kind === 'event' ? addE2O(next, ownerId, targetId, qualifier) : addO2O(next, ownerId, targetId, qualifier);
    onChange(next);
    setPickText(''); setQualifier(''); setMode('existing'); setNewType(''); setNewId('');
  };

  return (
    <div className="dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-label="Relations">
        <header>
          <h3>Relations for {ownerLabel}</h3>
          <button className="ghost" onClick={onClose}>×</button>
        </header>

        {relations.length > 0 && (
          <ul className="rellist">
            {relations.map((r) => (
              <li key={r.index}>
                <span className="relid">{r.otherId}{r.otherType && <i>{r.otherType}</i>}</span>
                <input
                  value={r.qualifier}
                  placeholder="qualifier"
                  list={QUAL_DATALIST}
                  onChange={(e) => onChange(setRelationQualifier(doc, relKey, r.index, e.target.value))}
                />
                <button className="ghost" title="Remove" onClick={() => onChange(removeRelationRow(doc, relKey, r.index))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {relations.length === 0 && <p className="empty">No relations yet.</p>}

        <div className="reladd">
          <div className="relmode">
            <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>Existing object</button>
            <button
              className={mode === 'new' ? 'on' : ''}
              disabled={objectTypes.length === 0}
              title={objectTypes.length === 0 ? 'Declare an object type first' : undefined}
              onClick={() => setMode('new')}
            >
              New object
            </button>
          </div>

          {objectTypes.length === 0 && mode === 'existing' && objectsList(doc).length === 0 && (
            <p className="empty">
              No objects to link yet — <button className="link" onClick={() => { onGoToTypes(); onClose(); }}>declare an object type</button>.
            </p>
          )}

          {mode === 'existing'
            ? (
              <input
                className="pick"
                value={pickText}
                placeholder="object id"
                list={OBJ_DATALIST}
                onChange={(e) => setPickText(e.target.value)}
              />
            )
            : (
              <div className="newobj">
                <select
                  value={newType}
                  onChange={(e) => { setNewType(e.target.value); setNewId(suggestObjectId(doc, e.target.value)); }}
                >
                  <option value="">object type…</option>
                  {objectTypes.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <input value={newId} placeholder="object id" onChange={(e) => setNewId(e.target.value)} />
              </div>
            )}

          <input
            className="qual"
            value={qualifier}
            placeholder="qualifier"
            list={QUAL_DATALIST}
            onChange={(e) => setQualifier(e.target.value)}
          />

          {error && <p className="err">{error}</p>}

          <button className="primary" disabled={!canAdd} onClick={add}>Add relation</button>
        </div>

        <datalist id={OBJ_DATALIST}>
          {objectsList(doc).map((o) => <option key={o.id} value={o.id}>{o.type}</option>)}
        </datalist>
        <datalist id={QUAL_DATALIST}>
          {qualifiers.map((q) => <option key={q} value={q} />)}
        </datalist>
      </div>
    </div>
  );
}
