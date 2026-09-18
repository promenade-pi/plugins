import {
  ATTR_TYPES, emptyDoc, formatLocalTimestamp, valueError,
  type AttrType, type Doc, type Row, type TypeDecl,
} from './model.ts';

/**
 * Turning an existing log back into an editable document.
 *
 * Kept pure and separate from the SQL that fetches the rows (`load.ts`), for
 * the usual reason: this is where the fidelity decisions live — what happens
 * to an attribute the log's declared schema never mentioned, how a millisecond
 * timestamp becomes text a person can edit, which object attributes are a
 * history rather than a value — and those are exactly the things worth
 * testing without a database in the room.
 *
 * The guiding rule is that nothing may vanish. A log opened for editing and
 * published again unchanged must still be the same log: every attribute
 * present in the rows becomes part of the schema even if the log never
 * declared it, because an attribute the editor does not know about is an
 * attribute the editor would quietly drop.
 */

export interface LogEventRow { event_id: string; activity: string; ts: number | null }
export interface LogAttrRow { owner: string; name: string; value: string; ts?: number | null }
export interface LogObjectRow { object_id: string; object_type: string }
export interface LogRelationRow { a: string; b: string; qualifier: string }

export interface LoadedLogRows {
  name: string;
  /** `meta.semantics` as the host hands it to the frame, when the log has it. */
  semantics?: {
    eventTypes?: Array<{ name: string; attributes?: Array<{ name: string; type?: string }> }>;
    objectTypes?: Array<{ name: string; attributes?: Array<{ name: string; type?: string }> }>;
  } | null;
  events: LogEventRow[];
  eventAttrs: LogAttrRow[];
  objects: LogObjectRow[];
  objectAttrs: LogAttrRow[];
  e2o: LogRelationRow[];
  o2o: LogRelationRow[];
}

/** A declared type name the log used, or `string` when it used something else. */
function attrType(raw: string | undefined): AttrType {
  const name = (raw ?? '').trim().toLowerCase();
  return (ATTR_TYPES as string[]).includes(name) ? (name as AttrType) : 'string';
}

/**
 * The value type a column of text is *consistent with*, for a log that never
 * declared one (an XES or CSV import, or a log written before schemas).
 *
 * Deliberately conservative and in this order: a column of `1`s is an
 * integer, not a boolean, and anything with a single value that does not fit
 * falls back to `string` — mistyping an attribute would put a red underline
 * under data that was already in the log, which is worse than calling it text.
 */
export function inferAttrType(values: string[]): AttrType {
  const present = values.map((v) => (v ?? '').trim()).filter(Boolean);
  if (!present.length) return 'string';
  for (const candidate of ['integer', 'float', 'boolean', 'time'] as AttrType[]) {
    if (present.every((v) => valueError(candidate, v) === null)) return candidate;
  }
  return 'string';
}

/**
 * Epoch milliseconds as text the editor and a `datetime-local` control both
 * accept, in local time — the same form `fillSeries` produces, so an edited
 * column and an untouched one read alike. Seconds appear only when the
 * instant has any, so a log of round minutes does not grow `:00` everywhere.
 */
export function timestampText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return formatLocalTimestamp(ms, ms % 60_000 !== 0);
}

function mergeAttributes(declared: TypeDecl[], observed: Map<string, Map<string, string[]>>): TypeDecl[] {
  const byName = new Map<string, TypeDecl>();
  for (const decl of declared) {
    byName.set(decl.name, { name: decl.name, attributes: decl.attributes.map((a) => ({ ...a })) });
  }
  for (const [typeName, attrs] of observed) {
    const decl = byName.get(typeName) ?? { name: typeName, attributes: [] };
    for (const [attrName, values] of attrs) {
      if (decl.attributes.some((a) => a.name === attrName)) continue;
      // Present in the rows but never declared: infer a type from the values
      // rather than dropping the attribute.
      decl.attributes.push({ name: attrName, type: inferAttrType(values) });
    }
    byName.set(typeName, decl);
  }
  return [...byName.values()];
}

/**
 * An existing log as an editable document.
 *
 * Object attributes split here: a value with no timestamp is static and
 * becomes a cell on the Objects sheet, while any value that carries one is
 * part of a history and becomes a Changes row. That is the same distinction
 * the host writes back out, so the round trip is closed.
 */
export function docFromLog(input: LoadedLogRows): Doc {
  const doc = emptyDoc();
  doc.name = input.name;

  const eventAttrsById = new Map<string, LogAttrRow[]>();
  for (const attr of input.eventAttrs) {
    const list = eventAttrsById.get(attr.owner) ?? [];
    list.push(attr);
    eventAttrsById.set(attr.owner, list);
  }

  const observedEvent = new Map<string, Map<string, string[]>>();
  doc.sheets.events.rows = input.events.map((event) => {
    const row: Row = { event_id: event.event_id, activity: event.activity, ts: timestampText(event.ts) };
    for (const attr of eventAttrsById.get(event.event_id) ?? []) {
      if (!attr.name) continue;
      row[attr.name] = attr.value ?? '';
      const perType = observedEvent.get(event.activity) ?? new Map<string, string[]>();
      perType.set(attr.name, [...(perType.get(attr.name) ?? []), attr.value ?? '']);
      observedEvent.set(event.activity, perType);
    }
    return row;
  });

  const typeById = new Map(input.objects.map((o) => [o.object_id, o.object_type]));
  const staticAttrs = new Map<string, LogAttrRow[]>();
  const changes: Row[] = [];
  const observedObject = new Map<string, Map<string, string[]>>();
  for (const attr of input.objectAttrs) {
    if (!attr.name) continue;
    const typeName = typeById.get(attr.owner) ?? '';
    const perType = observedObject.get(typeName) ?? new Map<string, string[]>();
    perType.set(attr.name, [...(perType.get(attr.name) ?? []), attr.value ?? '']);
    observedObject.set(typeName, perType);

    if (attr.ts == null) {
      const list = staticAttrs.get(attr.owner) ?? [];
      list.push(attr);
      staticAttrs.set(attr.owner, list);
    } else {
      changes.push({
        object_id: attr.owner, name: attr.name, ts: timestampText(attr.ts), value: attr.value ?? '',
      });
    }
  }

  doc.sheets.objects.rows = input.objects.map((object) => {
    const row: Row = { object_id: object.object_id, object_type: object.object_type };
    for (const attr of staticAttrs.get(object.object_id) ?? []) row[attr.name] = attr.value ?? '';
    return row;
  });
  // Sorted so one attribute's history reads as a history, in order.
  doc.sheets.changes.rows = changes.sort((a, b) =>
    a.object_id.localeCompare(b.object_id) || a.name.localeCompare(b.name) || a.ts.localeCompare(b.ts));

  doc.sheets.e2o.rows = input.e2o.map((r) => ({ event_id: r.a, object_id: r.b, qualifier: r.qualifier ?? '' }));
  doc.sheets.o2o.rows = input.o2o.map((r) => ({ source_id: r.a, target_id: r.b, qualifier: r.qualifier ?? '' }));

  const declaredEvent = (input.semantics?.eventTypes ?? []).map((t) => ({
    name: t.name,
    attributes: (t.attributes ?? []).map((a) => ({ name: a.name, type: attrType(a.type) })),
  }));
  const declaredObject = (input.semantics?.objectTypes ?? []).map((t) => ({
    name: t.name,
    attributes: (t.attributes ?? []).map((a) => ({ name: a.name, type: attrType(a.type) })),
  }));

  // Types the rows use but the log never declared are declared here: a row
  // instantiating no declared type is an error the user did not make.
  for (const activity of new Set(input.events.map((e) => e.activity).filter(Boolean))) {
    if (!observedEvent.has(activity)) observedEvent.set(activity, new Map());
  }
  for (const type of new Set(input.objects.map((o) => o.object_type).filter(Boolean))) {
    if (!observedObject.has(type)) observedObject.set(type, new Map());
  }
  observedEvent.delete('');
  observedObject.delete('');

  doc.eventTypes = mergeAttributes(declaredEvent, observedEvent);
  doc.objectTypes = mergeAttributes(declaredObject, observedObject);
  return doc;
}
