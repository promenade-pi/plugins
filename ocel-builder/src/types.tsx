import {
  ATTR_TYPES, declarationsOf, renameAttribute, renameType, withTypes,
  type AttrType, type Doc, type TypeDecl,
} from './model';

/**
 * The schema editor: OCEL 2.0's event types and object types, each with its
 * typed attributes.
 *
 * This is a form, not a grid, because a type is not a row: it has a name and a
 * *list* of attributes, and a spreadsheet cannot nest. It also comes first in
 * the tab strip, because everything the other sheets offer — which activities
 * autocomplete, which attribute columns exist, what counts as a legal value —
 * is decided here.
 */

function TypeCard({ decl, onChange, onRemove, onRenameName, onRenameAttr, kindLabel }: {
  decl: TypeDecl;
  kindLabel: string;
  onChange: (next: TypeDecl) => void;
  onRemove: () => void;
  onRenameName: (name: string) => void;
  onRenameAttr: (attrIndex: number, name: string) => void;
}) {
  return (
    <div className="typecard">
      <div className="typehead">
        <input
          className="typename"
          value={decl.name}
          placeholder={`${kindLabel} type name`}
          onChange={(e) => onRenameName(e.target.value)}
        />
        <button className="ghost" title="Remove this type" onClick={onRemove}>×</button>
      </div>

      {decl.attributes.length > 0 && (
        <div className="attrs">
          {decl.attributes.map((attr, i) => (
            <div className="attrrow" key={i}>
              <input
                value={attr.name}
                placeholder="attribute"
                onChange={(e) => onRenameAttr(i, e.target.value)}
              />
              <select
                value={attr.type}
                onChange={(e) => onChange({
                  ...decl,
                  attributes: decl.attributes.map((a, j) =>
                    (j === i ? { ...a, type: e.target.value as AttrType } : a)),
                })}
              >
                {ATTR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                className="ghost"
                title="Remove this attribute"
                onClick={() => onChange({ ...decl, attributes: decl.attributes.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        className="ghost addattr"
        onClick={() => onChange({ ...decl, attributes: [...decl.attributes, { name: '', type: 'string' }] })}
      >
        + attribute
      </button>
    </div>
  );
}

export function TypesPanel({ doc, onChange }: { doc: Doc; onChange: (doc: Doc) => void }) {
  const column = (kind: 'event' | 'object', title: string, hint: string) => {
    const decls = declarationsOf(doc, kind);
    return (
      <section className="typecol">
        <header>
          <h3>{title}<em>{decls.length}</em></h3>
          <button
            onClick={() => onChange(withTypes(doc, kind, [...decls, { name: '', attributes: [] }]))}
          >
            + type
          </button>
        </header>
        <p className="hint">{hint}</p>
        {decls.length === 0 && <p className="empty">None yet.</p>}
        {decls.map((decl, i) => (
          <TypeCard
            key={i}
            decl={decl}
            kindLabel={kind === 'event' ? 'Event' : 'Object'}
            onChange={(next) => onChange(withTypes(doc, kind, decls.map((d, j) => (j === i ? next : d))))}
            onRemove={() => onChange(withTypes(doc, kind, decls.filter((_, j) => j !== i)))}
            // Renaming carries the rows along — see `renameType` /
            // `renameAttribute`: a rename that orphaned every row naming the
            // old value would be a trap rather than an edit.
            onRenameName={(name) => onChange(renameType(doc, kind, i, name))}
            onRenameAttr={(attrIndex, name) => onChange(renameAttribute(doc, kind, i, attrIndex, name))}
          />
        ))}
      </section>
    );
  };

  return (
    <div className="types">
      {column('event', 'Event types', 'An event type is an activity. Its attributes become the Events sheet’s columns.')}
      {column('object', 'Object types', 'Its attributes become the Objects sheet’s columns.')}
    </div>
  );
}
