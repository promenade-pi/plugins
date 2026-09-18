/**
 * The document being edited, and every rule that is about the data rather
 * than about the DOM: what the sheets are, what a fill-handle drag continues,
 * what a declared type means for the cells beneath it, what makes a log
 * invalid and how to fix it.
 *
 * Kept apart from the components so the parts with real invariants are
 * ordinary functions over ordinary values — a fill pattern, a typed-value
 * check and a referential check are exactly the kind of thing that is easy to
 * get subtly wrong and impossible to eyeball in a screenshot.
 *
 * The schema comes first here, as it does in OCEL 2.0 itself: a log declares
 * its event types and object types with their *typed* attributes, and the rows
 * are instances of those declarations. So the attribute columns of the Events
 * and Objects sheets are not something the user adds to a grid — they are what
 * the declared types say they are, and a cell whose row belongs to a type that
 * does not declare that attribute is not editable at all.
 */

export type SheetKey = 'events' | 'objects' | 'e2o' | 'o2o' | 'changes';

/** OCEL 2.0's attribute value types. */
export type AttrType = 'string' | 'integer' | 'float' | 'boolean' | 'time';

export const ATTR_TYPES: AttrType[] = ['string', 'integer', 'float', 'boolean', 'time'];

export interface AttrDecl {
  name: string;
  type: AttrType;
}

/** A declared event type (an activity) or object type, with its attributes. */
export interface TypeDecl {
  name: string;
  attributes: AttrDecl[];
}

/** Which known values a column offers as completions. */
export type Suggest = 'eventType' | 'objectType' | 'eventId' | 'objectId' | 'qualifier'
  /** Attribute names — narrowed to the row's own object type where known. */
  | 'objectAttr';

export interface ColumnSpec {
  key: string;
  label: string;
  kind: 'text' | 'timestamp' | 'attr';
  /** Set for an attribute column: the declaration it renders. */
  attr?: AttrDecl;
  suggest?: Suggest;
  required?: boolean;
  width: number;
  hint?: string;
}

export interface SheetSpec {
  key: SheetKey;
  label: string;
  columns: ColumnSpec[];
  /** The sheet's rows are instances of a declared type named by this column. */
  typedBy?: { column: string; kind: 'event' | 'object' };
  /**
   * A sheet whose rows are values *of* an attribute rather than instances of
   * a type: the declaration that types a cell is named by another cell in the
   * same row, not by the column. Only the Changes sheet is like this.
   */
  valuesAttribute?: { owner: string; name: string; value: string };
  hint: string;
}

export type Row = Record<string, string>;

export interface Doc {
  name: string;
  eventTypes: TypeDecl[];
  objectTypes: TypeDecl[];
  sheets: Record<SheetKey, { rows: Row[] }>;
}

export const SHEETS: SheetSpec[] = [
  {
    key: 'events',
    label: 'Events',
    typedBy: { column: 'activity', kind: 'event' },
    hint: 'One row per event. Its event type decides which attribute cells it has.',
    columns: [
      { key: 'event_id', label: 'event_id', kind: 'text', required: true, width: 130 },
      { key: 'activity', label: 'activity', kind: 'text', suggest: 'eventType', required: true, width: 180 },
      { key: 'ts', label: 'ts', kind: 'timestamp', width: 170, hint: 'ISO 8601, e.g. 2026-01-05T09:00' },
    ],
  },
  {
    key: 'objects',
    label: 'Objects',
    typedBy: { column: 'object_type', kind: 'object' },
    hint: 'One row per object. Its object type decides which attribute cells it has.',
    columns: [
      { key: 'object_id', label: 'object_id', kind: 'text', required: true, width: 130 },
      { key: 'object_type', label: 'object_type', kind: 'text', suggest: 'objectType', required: true, width: 180 },
    ],
  },
  {
    key: 'changes',
    label: 'Changes',
    valuesAttribute: { owner: 'object_id', name: 'name', value: 'value' },
    hint: 'A value an object attribute took, and when. Objects with no row here keep the static value from their own sheet.',
    columns: [
      { key: 'object_id', label: 'object_id', kind: 'text', suggest: 'objectId', required: true, width: 130 },
      { key: 'name', label: 'attribute', kind: 'text', suggest: 'objectAttr', required: true, width: 150 },
      { key: 'ts', label: 'ts', kind: 'timestamp', required: true, width: 170, hint: 'When the attribute took this value' },
      { key: 'value', label: 'value', kind: 'text', required: true, width: 150 },
    ],
  },
  {
    key: 'e2o',
    label: 'E2O',
    hint: 'Which objects each event touches, and in which role.',
    columns: [
      { key: 'event_id', label: 'event_id', kind: 'text', suggest: 'eventId', required: true, width: 130 },
      { key: 'object_id', label: 'object_id', kind: 'text', suggest: 'objectId', required: true, width: 130 },
      { key: 'qualifier', label: 'qualifier', kind: 'text', suggest: 'qualifier', width: 150 },
    ],
  },
  {
    key: 'o2o',
    label: 'O2O',
    hint: 'Relations between objects themselves.',
    columns: [
      { key: 'source_id', label: 'source_id', kind: 'text', suggest: 'objectId', required: true, width: 130 },
      { key: 'target_id', label: 'target_id', kind: 'text', suggest: 'objectId', required: true, width: 130 },
      { key: 'qualifier', label: 'qualifier', kind: 'text', suggest: 'qualifier', width: 150 },
    ],
  },
];

export function sheetSpec(key: SheetKey): SheetSpec {
  return SHEETS.find((s) => s.key === key)!;
}

export function declarationsOf(doc: Doc, kind: 'event' | 'object'): TypeDecl[] {
  return kind === 'event' ? doc.eventTypes : doc.objectTypes;
}

/**
 * The attribute columns a typed sheet shows: every attribute any of its
 * declared types names, in declaration order, deduplicated by name.
 *
 * One column per attribute *name*, not per (type, attribute) pair, because two
 * types sharing an attribute name are describing the same field — a `price` on
 * two object types belongs in one column, or the grid becomes unreadable the
 * moment a log has more than a couple of types. Where two declarations
 * disagree about the value type, `validate` says so rather than this silently
 * picking one.
 */
export function attributeColumns(doc: Doc, spec: SheetSpec): ColumnSpec[] {
  if (!spec.typedBy) return [];
  const seen = new Map<string, AttrDecl>();
  for (const decl of declarationsOf(doc, spec.typedBy.kind)) {
    for (const attr of decl.attributes) {
      const name = attr.name.trim();
      if (!name || seen.has(name)) continue;
      seen.set(name, { name, type: attr.type });
    }
  }
  return [...seen.values()].map((attr) => ({
    key: attr.name,
    label: attr.name,
    kind: 'attr' as const,
    attr,
    width: 140,
    hint: `${attr.name} · ${attr.type}`,
  }));
}

// --- tabs -------------------------------------------------------------

/**
 * A tab under Events or Objects: one declared type, or "Other" — rows whose
 * type is blank or not (yet) declared.
 *
 * There is no "All" tab. A table holding every type at once was the thing
 * that made the sheet confusing in the first place: the type column repeats
 * itself down the whole sheet, and most cells belong to a type other than the
 * row in front of you. "Other" exists only so that a row nothing recognizes
 * — the case `validate` calls "not a declared type" — still has somewhere to
 * be seen and fixed, rather than becoming invisible the moment "All" is gone.
 */
export type SheetTab = { kind: 'type'; name: string } | { kind: 'other' };

/** A stable string for comparing/keying tabs — object identity is not enough. */
export function tabKey(tab: SheetTab): string {
  return tab.kind === 'type' ? `type:${tab.name}` : 'other';
}

/**
 * The tabs a typed sheet offers: one per declared type, in declaration order,
 * plus "Other" whenever a row exists that no declared type matches — or when
 * nothing has been declared yet, so a brand-new sheet still has somewhere to
 * type before its first type exists.
 */
export function sheetTabs(doc: Doc, spec: SheetSpec): SheetTab[] {
  if (!spec.typedBy) return [];
  const decls = declarationsOf(doc, spec.typedBy.kind).filter((d) => d.name.trim());
  const declaredNames = new Set(decls.map((d) => d.name.trim()));
  const tabs: SheetTab[] = decls.map((d) => ({ kind: 'type', name: d.name.trim() }));
  const hasOther = doc.sheets[spec.key].rows.some((r) =>
    !isBlankRow(r) && !declaredNames.has(cell(r, spec.typedBy!.column).trim()));
  if (hasOther || tabs.length === 0) tabs.push({ kind: 'other' });
  return tabs;
}

/** Whether a row belongs on a given tab. */
export function rowMatchesTab(doc: Doc, spec: SheetSpec, row: Row, tab: SheetTab): boolean {
  if (!spec.typedBy) return true;
  const value = cell(row, spec.typedBy.column).trim();
  if (tab.kind === 'type') return value === tab.name;
  const declaredNames = new Set(declarationsOf(doc, spec.typedBy.kind)
    .filter((d) => d.name.trim()).map((d) => d.name.trim()));
  return !declaredNames.has(value);
}

/** The cells a row typed on a given tab starts with — its type, already known. */
export function tabDefaults(spec: SheetSpec, tab: SheetTab | null | undefined): Row {
  return spec.typedBy && tab?.kind === 'type' ? { [spec.typedBy.column]: tab.name } : {};
}

/**
 * The columns of a sheet, optionally narrowed to one tab.
 *
 * On a type's own tab — narrowed — the sheet shows that type's own attributes
 * and nothing else, so there are no columns belonging to other types to skip
 * over and no unavailable cells at all. Unnarrowed (used only for the "Other"
 * tab and for sheets with no type of their own, like Changes) it keeps the
 * union, because a row on "Other" does not have one settled type to narrow to.
 */
export function columnsOf(doc: Doc, spec: SheetSpec, tab?: SheetTab | null): ColumnSpec[] {
  if (!tab || tab.kind !== 'type' || !spec.typedBy) return [...spec.columns, ...attributeColumns(doc, spec)];
  const decl = declarationsOf(doc, spec.typedBy.kind).find((d) => d.name.trim() === tab.name.trim());
  const attrs = (decl?.attributes ?? []).filter((a) => a.name.trim());
  return [
    // The type column itself is fixed for every row in a per-type tab, so it
    // would be a column of the same repeated value.
    ...spec.columns.filter((c) => c.key !== spec.typedBy!.column),
    ...attrs.map((attr) => ({
      key: attr.name, label: attr.name, kind: 'attr' as const, attr, width: 140,
      hint: `${attr.name} · ${attr.type}`,
    })),
  ];
}

/** The attributes a row actually has, given the type named in its type cell. */
export function attributesForRow(doc: Doc, spec: SheetSpec, row: Row | undefined): AttrDecl[] {
  if (!spec.typedBy) return [];
  const typeName = cell(row, spec.typedBy.column).trim();
  if (!typeName) return [];
  const decl = declarationsOf(doc, spec.typedBy.kind).find((d) => d.name.trim() === typeName);
  return decl?.attributes.filter((a) => a.name.trim()) ?? [];
}

/** The object type of an object id, for the sheets that reference objects. */
export function objectTypeOf(doc: Doc, objectId: string): string {
  const id = objectId.trim();
  if (!id) return '';
  const row = doc.sheets.objects.rows.find((r) => cell(r, 'object_id').trim() === id);
  return cell(row, 'object_type').trim();
}

/** The declaration behind an attribute name, for a given declared type. */
export function attrDeclOf(
  doc: Doc, kind: 'event' | 'object', typeName: string, attrName: string,
): AttrDecl | undefined {
  const decl = declarationsOf(doc, kind).find((d) => d.name.trim() === typeName.trim());
  return decl?.attributes.find((a) => a.name.trim() === attrName.trim());
}

/** Every object attribute declared anywhere, for completions with no type in hand. */
function allObjectAttrNames(doc: Doc): string[] {
  return [...new Set(doc.objectTypes.flatMap((t) => t.attributes.map((a) => a.name.trim())).filter(Boolean))];
}

/**
 * The (object, attribute) pairs whose value is a history rather than a single
 * value — the Changes sheet's own content, read back as a lookup.
 *
 * The Objects sheet uses it to lock the static cell for such a pair: an
 * attribute is either static or timed, never both (see the host's
 * `objectChanges` contract), so a leftover static value would be a value the
 * published log silently drops.
 */
export function timedAttributeKeys(doc: Doc): Set<string> {
  const keys = new Set<string>();
  for (const row of doc.sheets.changes.rows) {
    const owner = cell(row, 'object_id').trim();
    const name = cell(row, 'name').trim();
    if (owner && name) keys.add(`${owner}\u0000${name}`);
  }
  return keys;
}

/**
 * Whether a cell may be edited at all: an attribute cell needs its row's type
 * to declare it, and a static value whose (object, attribute) has a history in
 * the Changes sheet is not where that attribute's values live any more.
 */
export function allowedAt(doc: Doc, spec: SheetSpec, row: Row | undefined, column: ColumnSpec): boolean {
  if (!column.attr || !spec.typedBy) return true;
  if (!attributesForRow(doc, spec, row).some((a) => a.name.trim() === column.attr!.name)) return false;
  if (spec.key === 'objects') {
    const owner = cell(row, 'object_id').trim();
    if (owner && timedAttributeKeys(doc).has(`${owner}\u0000${column.attr.name}`)) return false;
  }
  return true;
}

/**
 * The declaration that types one cell — the Changes sheet's `value` column
 * takes its type from the attribute *named in the same row*, not from the
 * column, which is why this is per cell rather than per column.
 */
export function declAt(doc: Doc, spec: SheetSpec, row: Row | undefined, column: ColumnSpec): AttrDecl | undefined {
  if (column.attr) return column.attr;
  if (spec.valuesAttribute && column.key === spec.valuesAttribute.value) {
    const type = objectTypeOf(doc, cell(row, spec.valuesAttribute.owner));
    if (!type) return undefined;
    return attrDeclOf(doc, 'object', type, cell(row, spec.valuesAttribute.name));
  }
  return undefined;
}

/** What a cell's editor offers as completions, given the row it is in. */
export function completionsAt(
  doc: Doc, spec: SheetSpec, row: Row | undefined, column: ColumnSpec, suggestions: Suggestions,
): string[] {
  const decl = declAt(doc, spec, row, column);
  if (decl?.type === 'boolean') return BOOLEAN_LITERALS;
  if (column.suggest === 'objectAttr') {
    const type = objectTypeOf(doc, cell(row, spec.valuesAttribute?.owner ?? 'object_id'));
    const declared = type
      ? (declarationsOf(doc, 'object').find((d) => d.name.trim() === type)?.attributes ?? [])
        .map((a) => a.name.trim()).filter(Boolean)
      : [];
    // With no object in the row yet, every declared object attribute is a
    // candidate; with one, only what its type actually has.
    return declared.length ? declared : allObjectAttrNames(doc);
  }
  return column.suggest ? suggestions[column.suggest] : [];
}

/** What is wrong with one cell's text, if anything — the red underline. */
export function cellErrorAt(doc: Doc, spec: SheetSpec, row: Row | undefined, column: ColumnSpec): string | null {
  const value = cell(row, column.key);
  if (!value.trim()) return null;
  if (column.kind === 'timestamp') {
    return Number.isFinite(Date.parse(value.trim())) ? null : 'is not a date/time';
  }
  const decl = declAt(doc, spec, row, column);
  if (!decl) {
    // The Changes sheet's own referential check: a value cannot be typed
    // against an attribute the row's object type does not declare.
    if (spec.valuesAttribute && column.key === spec.valuesAttribute.name) {
      const type = objectTypeOf(doc, cell(row, spec.valuesAttribute.owner));
      if (type && !attrDeclOf(doc, 'object', type, value)) return `is not an attribute of ${type}`;
    }
    return null;
  }
  const complaint = valueError(decl.type, value);
  return complaint ? `${complaint} (${decl.type})` : null;
}

export function emptyDoc(): Doc {
  return {
    name: '',
    eventTypes: [],
    objectTypes: [],
    sheets: {
      events: { rows: [] },
      objects: { rows: [] },
      changes: { rows: [] },
      e2o: { rows: [] },
      o2o: { rows: [] },
    },
  };
}

export function cell(row: Row | undefined, key: string): string {
  return row?.[key] ?? '';
}

export function isBlankRow(row: Row): boolean {
  return Object.values(row).every((v) => !v || !v.trim());
}

/** Rows with anything in them — what publishing and validation look at. */
export function filledRows(doc: Doc, key: SheetKey): Row[] {
  return doc.sheets[key].rows.filter((r) => !isBlankRow(r));
}

// --- typed values ---------------------------------------------------------

export const BOOLEAN_LITERALS = ['true', 'false'];

/**
 * Whether a cell's text is a legal value for its declared type — the reason
 * declaring a type is worth the keystrokes rather than just documentation.
 * Returns the complaint, or null when the value is fine (blank always is: a
 * missing attribute value is missing, not wrong).
 */
export function valueError(type: AttrType, raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  switch (type) {
    case 'integer':
      return /^-?\d+$/.test(text) ? null : 'expects a whole number';
    case 'float':
      return Number.isFinite(Number(text)) ? null : 'expects a number';
    case 'boolean':
      return BOOLEAN_LITERALS.includes(text.toLowerCase()) ? null : 'expects true or false';
    case 'time':
      return Number.isFinite(Date.parse(text)) ? null : 'expects a date/time';
    default:
      return null;
  }
}

// --- autofill -------------------------------------------------------------

/**
 * The trailing-number split a fill pattern works on: `order-7` is
 * (`order-`, 7, 1 digit), so the series keeps the prefix and the zero
 * padding (`order-08` continues `order-09`, not `order-9`).
 */
function splitTrailingNumber(text: string): { prefix: string; n: number; pad: number } | null {
  const m = /^(.*?)(\d+)$/.exec(text);
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]), pad: m[2].length };
}

function formatNumbered(prefix: string, n: number, pad: number): string {
  const digits = String(Math.max(0, Math.round(n)));
  return prefix + (digits.length >= pad ? digits : '0'.repeat(pad - digits.length) + digits);
}

const HOUR_MS = 3600_000;

/**
 * What dragging the fill handle produces, given the cells that were selected
 * as the seed and how many cells to fill.
 *
 * Excel's behaviour, minus the parts that need a locale database:
 *  - a numeric (or `name<number>`) seed continues the series, taking its step
 *    from the seed when the seed has two or more values, otherwise +1;
 *  - a timestamp seed continues by its own step, or by an hour from a single
 *    cell (a hand-made log's events are minutes or hours apart, and a
 *    same-instant copy is the one continuation nobody wants);
 *  - anything else repeats, cycling the seed — which is what makes dragging
 *    a two-cell "Order / Item" seed down a column the fast way to type it.
 */
export function fillSeries(seed: string[], count: number, kind: ColumnSpec['kind'], attr?: AttrDecl): string[] {
  const out: string[] = [];
  const nonEmpty = seed.filter((s) => s.trim() !== '');
  if (nonEmpty.length === 0 || count <= 0) return new Array(Math.max(0, count)).fill('');

  const temporal = kind === 'timestamp' || attr?.type === 'time';
  if (temporal) {
    const times = nonEmpty.map((s) => Date.parse(s));
    if (times.every(Number.isFinite)) {
      const step = times.length > 1
        ? Math.round((times[times.length - 1] - times[0]) / (times.length - 1))
        : HOUR_MS;
      const last = times[times.length - 1];
      const pattern = nonEmpty[nonEmpty.length - 1];
      for (let i = 1; i <= count; i++) out.push(formatTimestamp(last + step * i, pattern));
      return out;
    }
  }

  // A declared boolean is a two-value domain, never a counter: `1` filled
  // down would produce `2`, which is not a boolean at all.
  if (attr?.type !== 'boolean') {
    const parts = nonEmpty.map(splitTrailingNumber);
    if (parts.every((p) => p !== null)) {
      const series = parts as Array<{ prefix: string; n: number; pad: number }>;
      const samePrefix = series.every((p) => p.prefix === series[0].prefix);
      if (samePrefix) {
        const step = series.length > 1
          ? Math.round((series[series.length - 1].n - series[0].n) / (series.length - 1)) || 1
          : 1;
        const last = series[series.length - 1];
        for (let i = 1; i <= count; i++) out.push(formatNumbered(last.prefix, last.n + step * i, last.pad));
        return out;
      }
    }
  }

  for (let i = 0; i < count; i++) out.push(nonEmpty[i % nonEmpty.length]);
  return out;
}

/**
 * Formats a filled timestamp the way its seed was written — a seed with no
 * seconds keeps having none, and one written without a zone stays local, so
 * a filled column reads as if it had been typed by the same hand.
 */
export function formatTimestamp(ms: number, pattern: string): string {
  const utc = /z$|[+-]\d\d:?\d\d$/i.test(pattern);
  const withSeconds = (pattern.match(/:/g) ?? []).length >= 2;
  if (utc) {
    const iso = new Date(ms).toISOString();
    return withSeconds ? iso.replace(/\.\d+Z$/, 'Z') : iso.slice(0, 16) + 'Z';
  }
  return formatLocalTimestamp(ms, withSeconds);
}

/**
 * Local wall-clock text, the form both this editor and a `datetime-local`
 * control accept. Seconds are opt-in so a log of round minutes does not grow
 * a `:00` on every row it did not have before.
 */
export function formatLocalTimestamp(ms: number, withSeconds: boolean): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

// --- suggestions ----------------------------------------------------------

export type Suggestions = Record<Suggest, string[]>;

/**
 * The known values behind every autocomplete column. Ids come from the sheet
 * that declares them (so an E2O row can only complete to an object that
 * exists); the type columns complete from the *declared* types, which is what
 * makes declaring one pay for itself immediately; qualifiers complete from
 * whatever has already been typed, since OCEL declares no qualifier
 * vocabulary.
 */
export function suggestionsOf(doc: Doc): Suggestions {
  const uniq = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  return {
    eventId: uniq(doc.sheets.events.rows.map((r) => cell(r, 'event_id'))),
    objectId: uniq(doc.sheets.objects.rows.map((r) => cell(r, 'object_id'))),
    eventType: uniq(doc.eventTypes.map((t) => t.name)),
    objectType: uniq(doc.objectTypes.map((t) => t.name)),
    qualifier: uniq([
      ...doc.sheets.e2o.rows.map((r) => cell(r, 'qualifier')),
      ...doc.sheets.o2o.rows.map((r) => cell(r, 'qualifier')),
    ]),
    // Narrowed per row by `completionsAt`; this is the fallback with no
    // object in hand yet.
    objectAttr: allObjectAttrNames(doc),
  };
}

/** Completions offered inside one column, including a declared enum-like domain. */
export function completionsFor(column: ColumnSpec, suggestions: Suggestions): string[] {
  if (column.attr?.type === 'boolean') return BOOLEAN_LITERALS;
  return column.suggest ? suggestions[column.suggest] : [];
}

// --- projection: per-type tabs, search, paging ----------------------------

export interface Projection {
  /** Indices into the sheet's own rows, in display order. */
  indices: number[];
  /** Rows the sheet holds in total. */
  total: number;
  /** Rows left after the type filter and the query. */
  matched: number;
  page: number;
  pages: number;
  /** Whether new rows may be typed below this page (only the last one). */
  spare: boolean;
}

export const PAGE_SIZE = 200;

/**
 * Which of a sheet's rows a tab shows, and where they are.
 *
 * Everything the UI does to narrow a sheet — the per-type tabs, the search
 * box, the pager — is this one function, returning *indices* rather than
 * rows. Editing a filtered view has to write back to the row the user
 * actually sees, and a copy of the rows cannot say which that was; a large
 * log makes both mistakes easy and expensive.
 */
export function projectRows(doc: Doc, spec: SheetSpec, options: {
  tab?: SheetTab | null;
  query?: string;
  page?: number;
  pageSize?: number;
} = {}): Projection {
  const rows = doc.sheets[spec.key].rows;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const query = (options.query ?? '').trim().toLowerCase();

  const matching: number[] = [];
  rows.forEach((row, i) => {
    if (options.tab && !rowMatchesTab(doc, spec, row, options.tab)) return;
    if (query && !Object.values(row).some((v) => (v ?? '').toLowerCase().includes(query))) return;
    matching.push(i);
  });

  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(Math.max(0, options.page ?? 0), pages - 1);
  return {
    indices: matching.slice(page * pageSize, page * pageSize + pageSize),
    total: rows.length,
    matched: matching.length,
    page,
    pages,
    // Typing a new row is only meaningful where the sheet actually ends —
    // otherwise a row appended "below page 3" would jump somewhere else.
    spare: page === pages - 1,
  };
}

/**
 * Writes a projected, edited copy back into the sheet's own rows.
 *
 * Rows beyond the projection are new — the blank rows the grid keeps below
 * the data — and are appended with the tab's defaults filled in, which is
 * what makes a per-type tab worth using: the type is already known, so it is
 * not retyped once per row. Rows emptied by the edit are dropped, so a
 * cleared row does not linger as an invisible blank.
 */
export function applyProjection(
  rows: Row[], indices: number[], edited: Row[], defaults: Row = {},
): Row[] {
  const next = rows.map((r) => ({ ...r }));
  indices.forEach((target, i) => {
    if (i < edited.length) next[target] = { ...edited[i] };
    else next[target] = {}; // the grid dropped this row from its own copy
  });
  for (const extra of edited.slice(indices.length)) {
    if (isBlankRow(extra)) continue;
    next.push({ ...defaults, ...extra });
  }
  return next.filter((row) => !isBlankRow(row));
}

// --- validation -----------------------------------------------------------

export interface Issue {
  level: 'error' | 'warning';
  sheet: SheetKey | 'types' | null;
  message: string;
  /**
   * Indices into `doc.sheets[sheet].rows` this issue is actually about, where
   * that is knowable cheaply. Without an "All" tab to fall back on, this is
   * how "Go" finds the right per-type tab instead of guessing, and how a tab
   * gets its own error dot.
   */
  rows?: number[];
  /** A one-click repair for the mistakes that have exactly one sane repair. */
  fix?: { label: string; apply: (doc: Doc) => Doc };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

function listed(values: string[]): string {
  return `${values.slice(0, 4).join(', ')}${values.length > 4 ? '…' : ''}`;
}

/**
 * Everything wrong with the document, in the order a person would want to fix
 * it. Errors block publishing; warnings are shapes that are legal OCEL but
 * almost certainly a slip (an event nothing relates to, say).
 */
export function validate(doc: Doc): Issue[] {
  const issues: Issue[] = [];
  const events = filledRows(doc, 'events');
  const objects = filledRows(doc, 'objects');
  const e2o = filledRows(doc, 'e2o');

  if (!doc.name.trim()) issues.push({ level: 'error', sheet: null, message: 'The log needs a name.' });

  // --- the schema itself
  for (const [kind, label] of [['event', 'Event'], ['object', 'Object']] as const) {
    const decls = declarationsOf(doc, kind);
    const unnamed = decls.filter((d) => !d.name.trim()).length;
    if (unnamed) {
      issues.push({ level: 'error', sheet: 'types', message: `${label} types: ${unnamed} without a name.` });
    }
    const dup = duplicates(decls.map((d) => d.name.trim()));
    if (dup.length) {
      issues.push({ level: 'error', sheet: 'types', message: `${label} types declared twice: ${listed(dup)}.` });
    }
    for (const decl of decls) {
      const attrDup = duplicates(decl.attributes.map((a) => a.name.trim()));
      if (attrDup.length) {
        issues.push({
          level: 'error', sheet: 'types',
          message: `${label} type “${decl.name || '?'}” declares ${listed(attrDup)} twice.`,
        });
      }
      if (decl.attributes.some((a) => !a.name.trim())) {
        issues.push({
          level: 'error', sheet: 'types',
          message: `${label} type “${decl.name || '?'}” has an attribute with no name.`,
        });
      }
    }
    // One column per attribute name: two types disagreeing about a name's
    // value type would make that column mean two things at once.
    const byName = new Map<string, AttrType>();
    for (const decl of decls) {
      for (const attr of decl.attributes) {
        const name = attr.name.trim();
        if (!name) continue;
        const seen = byName.get(name);
        if (seen && seen !== attr.type) {
          issues.push({
            level: 'error', sheet: 'types',
            message: `${label} attribute “${name}” is declared both ${seen} and ${attr.type}.`,
          });
        }
        byName.set(name, attr.type);
      }
    }
  }

  if (events.length === 0) issues.push({ level: 'error', sheet: 'events', message: 'Add at least one event.' });

  // --- required cells
  for (const spec of SHEETS) {
    for (const column of spec.columns) {
      if (!column.required) continue;
      const rows = doc.sheets[spec.key].rows;
      const badRows = rows.map((r, i) => i).filter((i) => !isBlankRow(rows[i]) && !cell(rows[i], column.key).trim());
      if (badRows.length > 0) {
        issues.push({
          level: 'error', sheet: spec.key, rows: badRows,
          message: `${spec.label}: ${badRows.length} row${badRows.length === 1 ? '' : 's'} with no ${column.label}.`,
        });
      }
    }
  }

  // --- ids
  for (const [key, column, label] of [
    ['events', 'event_id', 'event id'], ['objects', 'object_id', 'object id'],
  ] as const) {
    const rows = doc.sheets[key].rows;
    const dup = duplicates(filledRows(doc, key).map((r) => cell(r, column).trim()));
    if (dup.length) {
      const dupSet = new Set(dup);
      const badRows = rows.map((r, i) => i).filter((i) => !isBlankRow(rows[i]) && dupSet.has(cell(rows[i], column).trim()));
      issues.push({
        level: 'error', sheet: key, rows: badRows,
        message: `Duplicate ${label}${dup.length === 1 ? '' : 's'}: ${listed(dup)}.`,
      });
    }
  }

  // --- rows must instantiate a declared type
  for (const spec of SHEETS) {
    if (!spec.typedBy) continue;
    const rows = doc.sheets[spec.key].rows;
    const declared = new Set(declarationsOf(doc, spec.typedBy.kind).map((d) => d.name.trim()));
    const undeclared = [...new Set(filledRows(doc, spec.key)
      .map((r) => cell(r, spec.typedBy!.column).trim())
      .filter((name) => name && !declared.has(name)))];
    if (undeclared.length) {
      const kind = spec.typedBy.kind;
      const undeclaredSet = new Set(undeclared);
      const badRows = rows.map((r, i) => i)
        .filter((i) => !isBlankRow(rows[i]) && undeclaredSet.has(cell(rows[i], spec.typedBy!.column).trim()));
      issues.push({
        level: 'error', sheet: spec.key, rows: badRows,
        message: `${spec.label}: ${listed(undeclared)} ${undeclared.length === 1 ? 'is not a declared' : 'are not declared'} ${kind} type${undeclared.length === 1 ? '' : 's'}.`,
        fix: {
          label: `Declare ${undeclared.length} ${kind} type${undeclared.length === 1 ? '' : 's'}`,
          apply: (d) => withTypes(d, kind, [
            ...declarationsOf(d, kind),
            ...undeclared.map((name) => ({ name, attributes: [] })),
          ]),
        },
      });
    }
  }

  // --- typed attribute values
  for (const spec of SHEETS) {
    if (!spec.typedBy) continue;
    doc.sheets[spec.key].rows.forEach((row, i) => {
      if (isBlankRow(row)) return;
      for (const attr of attributesForRow(doc, spec, row)) {
        const complaint = valueError(attr.type, cell(row, attr.name));
        if (complaint) {
          issues.push({
            level: 'error', sheet: spec.key, rows: [i],
            message: `${spec.label}: “${cell(row, attr.name).trim()}” in ${attr.name} ${complaint} (${attr.type}).`,
          });
        }
      }
    });
  }

  {
    const rows = doc.sheets.events.rows;
    for (let i = 0; i < rows.length; i++) {
      if (isBlankRow(rows[i])) continue;
      const ts = cell(rows[i], 'ts').trim();
      if (ts && !Number.isFinite(Date.parse(ts))) {
        issues.push({
          level: 'error', sheet: 'events', rows: [i],
          message: `“${ts}” is not a date/time (event ${cell(rows[i], 'event_id') || '?'}).`,
        });
        break;
      }
    }
  }

  // --- timed attribute values
  {
    const spec = sheetSpec('changes');
    const rows = doc.sheets.changes.rows;
    const firstIndexOf = new Map<string, number>();
    rows.forEach((row, i) => {
      if (isBlankRow(row)) return;
      const owner = cell(row, 'object_id').trim();
      const name = cell(row, 'name').trim();
      const ts = cell(row, 'ts').trim();
      const type = objectTypeOf(doc, owner);
      if (owner && name && type && !attrDeclOf(doc, 'object', type, name)) {
        issues.push({
          level: 'error', sheet: 'changes', rows: [i],
          message: `Changes: “${name}” is not an attribute of ${type} (object ${owner}).`,
          fix: {
            label: `Declare ${name} on ${type}`,
            apply: (d) => withTypes(d, 'object', declarationsOf(d, 'object').map((decl) => (decl.name.trim() === type
              ? { ...decl, attributes: [...decl.attributes, { name, type: 'string' as AttrType }] }
              : decl))),
          },
        });
      }
      const decl = type ? attrDeclOf(doc, 'object', type, name) : undefined;
      if (decl) {
        const complaint = valueError(decl.type, cell(row, 'value'));
        if (complaint) {
          issues.push({
            level: 'error', sheet: 'changes', rows: [i],
            message: `Changes: “${cell(row, 'value').trim()}” for ${name} ${complaint} (${decl.type}).`,
          });
        }
      }
      if (ts && !Number.isFinite(Date.parse(ts))) {
        issues.push({ level: 'error', sheet: 'changes', rows: [i], message: `Changes: “${ts}” is not a date/time.` });
      }
      const key = `${owner}\u0000${name}\u0000${ts}`;
      if (owner && name && ts) {
        const first = firstIndexOf.get(key);
        if (first !== undefined) {
          issues.push({
            level: 'error', sheet: 'changes', rows: [first, i],
            message: `Changes: ${name} of ${owner} has two values at ${ts}.`,
          });
        } else {
          firstIndexOf.set(key, i);
        }
      }
    });
    // A value history that shadows a static value the user cannot see any
    // more is worth saying out loud, since publishing drops the static one.
    const shadowed = filledRows(doc, 'objects').flatMap((row) => {
      const owner = cell(row, 'object_id').trim();
      return attributesForRow(doc, sheetSpec('objects'), row)
        .filter((a) => cell(row, a.name).trim() && timedAttributeKeys(doc).has(`${owner}\u0000${a.name}`))
        .map((a) => `${a.name} of ${owner}`);
    });
    if (shadowed.length) {
      issues.push({
        level: 'warning', sheet: 'changes',
        message: `Timed values replace the static value of ${listed(shadowed)} — the static one is not published.`,
        fix: {
          label: 'Clear the static values',
          apply: (d) => withRows(d, 'objects', d.sheets.objects.rows.map((row) => {
            const owner = cell(row, 'object_id').trim();
            const out = { ...row };
            for (const attr of attributesForRow(d, sheetSpec('objects'), row)) {
              if (timedAttributeKeys(d).has(`${owner}\u0000${attr.name}`)) delete out[attr.name];
            }
            return out;
          })),
        },
      });
    }
    void spec;
  }

  // --- referential integrity
  const knownEvents = new Set(events.map((r) => cell(r, 'event_id').trim()));
  const knownObjects = new Set(objects.map((r) => cell(r, 'object_id').trim()));

  const unknownEvents = [...new Set(e2o.map((r) => cell(r, 'event_id').trim())
    .filter((id) => id && !knownEvents.has(id)))];
  if (unknownEvents.length) {
    const unknownEventSet = new Set(unknownEvents);
    const e2oRows = doc.sheets.e2o.rows;
    issues.push({
      level: 'error', sheet: 'e2o',
      rows: e2oRows.map((r, i) => i).filter((i) => unknownEventSet.has(cell(e2oRows[i], 'event_id').trim())),
      message: `E2O refers to ${unknownEvents.length} event${unknownEvents.length === 1 ? '' : 's'} that do not exist: ${listed(unknownEvents)}.`,
      fix: {
        label: `Add ${unknownEvents.length} event${unknownEvents.length === 1 ? '' : 's'}`,
        apply: (d) => withRows(d, 'events', [
          ...d.sheets.events.rows,
          ...unknownEvents.map((id) => ({ event_id: id, activity: '', ts: '' })),
        ]),
      },
    });
  }

  const unknownObjects = [...new Set([
    ...e2o.map((r) => cell(r, 'object_id').trim()),
    ...filledRows(doc, 'o2o').flatMap((r) => [cell(r, 'source_id').trim(), cell(r, 'target_id').trim()]),
  ].filter((id) => id && !knownObjects.has(id)))];
  if (unknownObjects.length) {
    issues.push({
      level: 'error', sheet: 'objects',
      message: `Relations refer to ${unknownObjects.length} object${unknownObjects.length === 1 ? '' : 's'} that do not exist: ${listed(unknownObjects)}.`,
      fix: {
        label: `Add ${unknownObjects.length} object${unknownObjects.length === 1 ? '' : 's'}`,
        apply: (d) => withRows(d, 'objects', [
          ...d.sheets.objects.rows,
          ...unknownObjects.map((id) => ({ object_id: id, object_type: '' })),
        ]),
      },
    });
  }

  if (objects.length === 0 && events.length > 0) {
    issues.push({ level: 'error', sheet: 'objects', message: 'An object-centric log needs at least one object.' });
  }

  // --- warnings
  const relatedEvents = new Set(e2o.map((r) => cell(r, 'event_id').trim()));
  const eventRows = doc.sheets.events.rows;
  const orphanEventRows = eventRows.map((r, i) => i)
    .filter((i) => !isBlankRow(eventRows[i]) && !relatedEvents.has(cell(eventRows[i], 'event_id').trim()));
  if (orphanEventRows.length > 0) {
    issues.push({
      level: 'warning', sheet: 'events', rows: orphanEventRows,
      message: `${orphanEventRows.length} event${orphanEventRows.length === 1 ? '' : 's'} relate to no object — most object-centric algorithms will ignore ${orphanEventRows.length === 1 ? 'it' : 'them'}.`,
    });
  }

  const relatedObjects = new Set(e2o.map((r) => cell(r, 'object_id').trim()));
  const objectRows = doc.sheets.objects.rows;
  const orphanObjectRows = objectRows.map((r, i) => i)
    .filter((i) => !isBlankRow(objectRows[i]) && !relatedObjects.has(cell(objectRows[i], 'object_id').trim()));
  if (orphanObjectRows.length > 0) {
    issues.push({
      level: 'warning', sheet: 'objects', rows: orphanObjectRows,
      message: `${orphanObjectRows.length} object${orphanObjectRows.length === 1 ? '' : 's'} appear in no event.`,
    });
  }

  const unusedTypes = doc.eventTypes.map((t) => t.name.trim()).filter((name) =>
    name && !events.some((r) => cell(r, 'activity').trim() === name));
  if (unusedTypes.length) {
    issues.push({
      level: 'warning', sheet: 'types',
      message: `Declared but unused event type${unusedTypes.length === 1 ? '' : 's'}: ${listed(unusedTypes)}.`,
    });
  }

  return issues;
}

// --- edits ----------------------------------------------------------------

export function withRows(doc: Doc, key: SheetKey, rows: Row[]): Doc {
  return { ...doc, sheets: { ...doc.sheets, [key]: { rows } } };
}

export function withTypes(doc: Doc, kind: 'event' | 'object', types: TypeDecl[]): Doc {
  return kind === 'event' ? { ...doc, eventTypes: types } : { ...doc, objectTypes: types };
}

/**
 * Renames a declared type and carries the rows that instantiate it along.
 * Editing a type's name in the schema and silently orphaning every row that
 * named it would make renaming a trap rather than an edit.
 */
export function renameType(doc: Doc, kind: 'event' | 'object', index: number, name: string): Doc {
  const decls = declarationsOf(doc, kind);
  const previous = decls[index]?.name.trim() ?? '';
  const next = decls.map((d, i) => (i === index ? { ...d, name } : d));
  let out = withTypes(doc, kind, next);
  if (previous && previous !== name.trim()) {
    const spec = SHEETS.find((s) => s.typedBy?.kind === kind)!;
    const column = spec.typedBy!.column;
    out = withRows(out, spec.key, out.sheets[spec.key].rows.map((row) =>
      (cell(row, column).trim() === previous ? { ...row, [column]: name } : row)));
  }
  return out;
}

/** Renames an attribute, moving the values already typed under it. */
export function renameAttribute(
  doc: Doc, kind: 'event' | 'object', typeIndex: number, attrIndex: number, name: string,
): Doc {
  const decls = declarationsOf(doc, kind);
  const previous = decls[typeIndex]?.attributes[attrIndex]?.name.trim() ?? '';
  const next = decls.map((d, i) => (i === typeIndex
    ? { ...d, attributes: d.attributes.map((a, j) => (j === attrIndex ? { ...a, name } : a)) }
    : d));
  let out = withTypes(doc, kind, next);
  if (previous && previous !== name.trim()) {
    const spec = SHEETS.find((s) => s.typedBy?.kind === kind)!;
    out = withRows(out, spec.key, out.sheets[spec.key].rows.map((row) => {
      if (!(previous in row)) return row;
      const { [previous]: value, ...rest } = row;
      return name.trim() ? { ...rest, [name]: value } : rest;
    }));
  }
  return out;
}

// --- relations (the "+ relation" dialog on an Events/Objects row) ---------

/** Every object as `{id, type}`, for a picker that lets you choose one. */
export function objectsList(doc: Doc): Array<{ id: string; type: string }> {
  return filledRows(doc, 'objects')
    .map((r) => ({ id: cell(r, 'object_id').trim(), type: cell(r, 'object_type').trim() }))
    .filter((o) => o.id);
}

export function objectIdExists(doc: Doc, id: string): boolean {
  const target = id.trim();
  return !!target && doc.sheets.objects.rows.some((r) => cell(r, 'object_id').trim() === target);
}

/**
 * A starting point for a new object's id — the declared type's own initial,
 * lowercased, followed by the smallest number not already taken (`Order`
 * suggests `o1`, then `o2`). Always shown in an editable field before the
 * object is created: a starting point, not a naming scheme imposed on anyone.
 */
export function suggestObjectId(doc: Doc, typeName: string): string {
  const prefix = (typeName.trim().match(/[A-Za-z]/)?.[0] ?? 'o').toLowerCase();
  const existing = new Set(doc.sheets.objects.rows.map((r) => cell(r, 'object_id').trim()));
  let n = 1;
  while (existing.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Appends a new object row of the given type. Caller checks `objectIdExists` first. */
export function addObjectRow(doc: Doc, objectId: string, objectType: string): Doc {
  return withRows(doc, 'objects', [
    ...doc.sheets.objects.rows,
    { object_id: objectId.trim(), object_type: objectType.trim() },
  ]);
}

export interface RelationRow {
  /** Index into the e2o/o2o sheet — what a remove or a qualifier edit targets. */
  index: number;
  otherId: string;
  otherType: string;
  qualifier: string;
}

/** This event's E2O relations, for the relation dialog. */
export function relationsForEvent(doc: Doc, eventId: string): RelationRow[] {
  const id = eventId.trim();
  const types = new Map(objectsList(doc).map((o) => [o.id, o.type]));
  return doc.sheets.e2o.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => cell(row, 'event_id').trim() === id)
    .map(({ row, index }) => ({
      index,
      otherId: cell(row, 'object_id').trim(),
      otherType: types.get(cell(row, 'object_id').trim()) ?? '',
      qualifier: cell(row, 'qualifier'),
    }));
}

/** This object's outgoing O2O relations (as source), for the relation dialog. */
export function relationsForObject(doc: Doc, objectId: string): RelationRow[] {
  const id = objectId.trim();
  const types = new Map(objectsList(doc).map((o) => [o.id, o.type]));
  return doc.sheets.o2o.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => cell(row, 'source_id').trim() === id)
    .map(({ row, index }) => ({
      index,
      otherId: cell(row, 'target_id').trim(),
      otherType: types.get(cell(row, 'target_id').trim()) ?? '',
      qualifier: cell(row, 'qualifier'),
    }));
}

/** Adds an E2O row, unless the exact (event, object, qualifier) triple already exists. */
export function addE2O(doc: Doc, eventId: string, objectId: string, qualifier: string): Doc {
  const e = eventId.trim();
  const o = objectId.trim();
  const q = qualifier.trim();
  const exists = doc.sheets.e2o.rows.some((r) =>
    cell(r, 'event_id').trim() === e && cell(r, 'object_id').trim() === o && cell(r, 'qualifier').trim() === q);
  if (exists) return doc;
  return withRows(doc, 'e2o', [...doc.sheets.e2o.rows, { event_id: e, object_id: o, qualifier: q }]);
}

/** Adds an O2O row, unless the exact (source, target, qualifier) triple already exists. */
export function addO2O(doc: Doc, sourceId: string, targetId: string, qualifier: string): Doc {
  const s = sourceId.trim();
  const t = targetId.trim();
  const q = qualifier.trim();
  const exists = doc.sheets.o2o.rows.some((r) =>
    cell(r, 'source_id').trim() === s && cell(r, 'target_id').trim() === t && cell(r, 'qualifier').trim() === q);
  if (exists) return doc;
  return withRows(doc, 'o2o', [...doc.sheets.o2o.rows, { source_id: s, target_id: t, qualifier: q }]);
}

export function removeRelationRow(doc: Doc, key: 'e2o' | 'o2o', index: number): Doc {
  return withRows(doc, key, doc.sheets[key].rows.filter((_, i) => i !== index));
}

export function setRelationQualifier(doc: Doc, key: 'e2o' | 'o2o', index: number, qualifier: string): Doc {
  return withRows(doc, key, doc.sheets[key].rows.map((r, i) => (i === index ? { ...r, qualifier } : r)));
}

// --- publishing -----------------------------------------------------------

export interface PublishRequest {
  type: 'ObjectCentricEventLog';
  name: string;
  events: Row[];
  objects: Row[];
  e2o: Row[];
  o2o: Row[];
  /** Time-dependent object attribute values: the Changes sheet. */
  objectChanges: Row[];
  /** Set when this log was edited from an existing one, for provenance. */
  source?: string;
  semantics: {
    eventTypes: TypeDecl[];
    objectTypes: TypeDecl[];
    sourceFormat: 'json';
  };
}

/**
 * The document as the host's `promenade.publishLog()` wants it: trimmed, blank
 * rows dropped, blank cells omitted entirely rather than sent as empty strings
 * (an omitted attribute is not an attribute with an empty value), and every
 * attribute cell that its row's type does not declare dropped as well — a
 * value left behind by a type change is not part of the log.
 *
 * `semantics` carries the declared types the way an OCEL 2.0 import does, so
 * a hand-written log states its schema rather than having it inferred back out
 * of its own rows.
 */
export function publishRequest(doc: Doc, source?: string): PublishRequest {
  const timed = timedAttributeKeys(doc);
  const clean = (key: SheetKey): Row[] => {
    const spec = sheetSpec(key);
    const fixed = new Set(spec.columns.map((c) => c.key));
    return filledRows(doc, key).map((row) => {
      const owner = cell(row, 'object_id').trim();
      const allowed = new Set(attributesForRow(doc, spec, row)
        // A static value whose (object, attribute) has a history is not part
        // of the log — see the host's `objectChanges` contract.
        .filter((a) => !(key === 'objects' && timed.has(`${owner}\u0000${a.name.trim()}`)))
        .map((a) => a.name.trim()));
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) {
        if (!fixed.has(k) && !allowed.has(k)) continue;
        const value = (v ?? '').trim();
        if (value) out[k] = value;
      }
      return out;
    });
  };
  const declared = (types: TypeDecl[]): TypeDecl[] => types
    .filter((t) => t.name.trim())
    .map((t) => ({
      name: t.name.trim(),
      attributes: t.attributes.filter((a) => a.name.trim()).map((a) => ({ name: a.name.trim(), type: a.type })),
    }));

  return {
    type: 'ObjectCentricEventLog',
    name: doc.name.trim(),
    events: clean('events'),
    objects: clean('objects'),
    e2o: clean('e2o'),
    o2o: clean('o2o'),
    objectChanges: clean('changes'),
    ...(source ? { source } : {}),
    semantics: {
      eventTypes: declared(doc.eventTypes),
      objectTypes: declared(doc.objectTypes),
      sourceFormat: 'json',
    },
  };
}

/** A three-event order/item log — the "hello world" this editor exists for. */
export function exampleDoc(): Doc {
  return {
    name: 'Hello OCEL',
    eventTypes: [
      { name: 'Place order', attributes: [{ name: 'channel', type: 'string' }] },
      { name: 'Pick item', attributes: [{ name: 'picker', type: 'string' }] },
      { name: 'Ship order', attributes: [{ name: 'express', type: 'boolean' }] },
    ],
    objectTypes: [
      {
        name: 'Order',
        attributes: [
          { name: 'total', type: 'float' },
          { name: 'placed', type: 'time' },
          { name: 'status', type: 'string' },
        ],
      },
      { name: 'Item', attributes: [{ name: 'quantity', type: 'integer' }] },
    ],
    sheets: {
      events: {
        rows: [
          { event_id: 'e1', activity: 'Place order', ts: '2026-01-05T09:00', channel: 'web' },
          { event_id: 'e2', activity: 'Pick item', ts: '2026-01-05T10:00', picker: 'Ada' },
          { event_id: 'e3', activity: 'Ship order', ts: '2026-01-05T11:00', express: 'true' },
        ],
      },
      objects: {
        rows: [
          { object_id: 'o1', object_type: 'Order', total: '39.90', placed: '2026-01-05T09:00' },
          { object_id: 'i1', object_type: 'Item', quantity: '2' },
          { object_id: 'i2', object_type: 'Item', quantity: '1' },
        ],
      },
      e2o: {
        rows: [
          { event_id: 'e1', object_id: 'o1', qualifier: 'order' },
          { event_id: 'e1', object_id: 'i1', qualifier: 'item' },
          { event_id: 'e1', object_id: 'i2', qualifier: 'item' },
          { event_id: 'e2', object_id: 'i1', qualifier: 'item' },
          { event_id: 'e3', object_id: 'o1', qualifier: 'order' },
        ],
      },
      o2o: {
        rows: [
          { source_id: 'o1', target_id: 'i1', qualifier: 'contains' },
          { source_id: 'o1', target_id: 'i2', qualifier: 'contains' },
        ],
      },
      // `status` is time-dependent: it has values, not a value.
      changes: {
        rows: [
          { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'placed' },
          { object_id: 'o1', name: 'status', ts: '2026-01-05T11:00', value: 'shipped' },
        ],
      },
    },
  };
}
