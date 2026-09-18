import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAGE_SIZE, allowedAt, applyProjection, cellErrorAt, columnsOf, completionsAt, emptyDoc, exampleDoc,
  projectRows, publishRequest, sheetSpec, sheetTabs, suggestionsOf, validate, withRows,
  type Doc, type Row, type SheetTab,
} from '../src/model.ts';
import { docFromLog, inferAttrType, timestampText } from '../src/hydrate.ts';

const events = sheetSpec('events');
const objects = sheetSpec('objects');
const changes = sheetSpec('changes');

const tType = (name: string): SheetTab => ({ kind: 'type', name });
const tOther: SheetTab = { kind: 'other' };

// --- per-type tabs --------------------------------------------------------

test('sheetTabs offers one tab per declared type, plus Other when needed', () => {
  const doc = exampleDoc();
  assert.deepEqual(sheetTabs(doc, events), [tType('Place order'), tType('Pick item'), tType('Ship order')]);
  // Nothing is undeclared yet, so no Other tab.
  assert.equal(sheetTabs(doc, events).some((t) => t.kind === 'other'), false);

  const withStray = withRows(doc, 'events', [
    ...doc.sheets.events.rows, { event_id: 'e9', activity: 'Cancel order', ts: '' },
  ]);
  assert.deepEqual(sheetTabs(withStray, events),
    [tType('Place order'), tType('Pick item'), tType('Ship order'), tOther]);

  // Before anything is declared, "Other" is the only tab — the whole sheet.
  assert.deepEqual(sheetTabs(emptyDoc(), events), [tOther]);
});

test('a per-type tab shows only that type’s rows and columns', () => {
  const doc = exampleDoc();
  const all = projectRows(doc, events);
  assert.equal(all.indices.length, 3);

  const picking = projectRows(doc, events, { tab: tType('Pick item') });
  assert.deepEqual(picking.indices, [1]);
  assert.equal(picking.matched, 1);
  assert.equal(picking.total, 3);

  // The type column itself is dropped — it would be one repeated value — and
  // only that type's own attributes remain.
  assert.deepEqual(columnsOf(doc, events, tType('Pick item')).map((c) => c.key), ['event_id', 'ts', 'picker']);
  assert.deepEqual(columnsOf(doc, events, null).map((c) => c.key),
    ['event_id', 'activity', 'ts', 'channel', 'picker', 'express']);
  // "Other" behaves like the old unnarrowed view: heterogeneous rows, union columns.
  assert.deepEqual(columnsOf(doc, events, tOther).map((c) => c.key),
    columnsOf(doc, events, null).map((c) => c.key));
});

test('inside a per-type tab every attribute cell is editable', () => {
  const doc = exampleDoc();
  const spec = objects;
  const columns = columnsOf(doc, spec, tType('Item'));
  const row = doc.sheets.objects.rows[1];
  for (const column of columns) assert.equal(allowedAt(doc, spec, row, column), true);
  // Which is the difference from the unnarrowed view, where a row meets
  // columns belonging to other types.
  const unavailable = columnsOf(doc, spec, null).filter((c) => !allowedAt(doc, spec, row, c));
  assert.deepEqual(unavailable.map((c) => c.key), ['total', 'placed', 'status']);
});

test('a row typed in a per-type tab is appended with its type filled in', () => {
  const doc = exampleDoc();
  const projection = projectRows(doc, events, { tab: tType('Pick item') });
  const edited: Row[] = [
    doc.sheets.events.rows[1],
    { event_id: 'e4', ts: '2026-01-05T12:00', picker: 'Grace' },
  ];
  const rows = applyProjection(doc.sheets.events.rows, projection.indices, edited, { activity: 'Pick item' });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], { activity: 'Pick item', event_id: 'e4', ts: '2026-01-05T12:00', picker: 'Grace' });
  // Untouched rows of other types are exactly where they were.
  assert.deepEqual(rows.slice(0, 3), doc.sheets.events.rows);
});

test('editing a projected row writes back to the row it came from', () => {
  const doc = exampleDoc();
  const projection = projectRows(doc, events, { tab: tType('Ship order') });
  assert.deepEqual(projection.indices, [2]);
  const rows = applyProjection(doc.sheets.events.rows, projection.indices,
    [{ ...doc.sheets.events.rows[2], express: 'false' }]);
  assert.equal(rows[2].express, 'false');
  assert.equal(rows[0].channel, 'web');
});

test('a row cleared in a filtered view is removed, not left blank', () => {
  const doc = exampleDoc();
  const projection = projectRows(doc, events, { tab: tType('Pick item') });
  const rows = applyProjection(doc.sheets.events.rows, projection.indices, []);
  assert.deepEqual(rows.map((r) => r.event_id), ['e1', 'e3']);
});

// --- search and paging ----------------------------------------------------

test('search matches any cell, and paging walks the matches', () => {
  const rows: Row[] = Array.from({ length: 450 }, (_, i) => ({
    event_id: `e${i + 1}`, activity: i % 2 ? 'Pick item' : 'Place order', ts: '',
  }));
  const doc = withRows(exampleDoc(), 'events', rows);

  const first = projectRows(doc, events, {});
  assert.equal(first.indices.length, PAGE_SIZE);
  assert.equal(first.pages, 3);
  assert.equal(first.spare, false);

  const last = projectRows(doc, events, { page: 2 });
  assert.equal(last.indices.length, 50);
  assert.equal(last.spare, true);
  // A page beyond the end clamps rather than showing nothing.
  assert.equal(projectRows(doc, events, { page: 99 }).page, 2);

  const searched = projectRows(doc, events, { query: 'pick' });
  assert.equal(searched.matched, 225);
  assert.equal(searched.total, 450);
  assert.deepEqual(projectRows(doc, events, { query: 'e450' }).indices, [449]);
  // Tab filter and query compose.
  assert.equal(projectRows(doc, events, { tab: tType('Place order'), query: 'e1' }).matched,
    rows.filter((r) => r.activity === 'Place order' && r.event_id.includes('e1')).length);
});

// --- timed object attributes ---------------------------------------------

test('a timed value locks the static cell it replaces, and publishing drops it', () => {
  const doc = exampleDoc();
  const orderRow = doc.sheets.objects.rows[0];
  const statusColumn = columnsOf(doc, objects, tType('Order')).find((c) => c.key === 'status')!;
  // o1's `status` has a history, so its static cell is not where values live.
  assert.equal(allowedAt(doc, objects, orderRow, statusColumn), false);
  // `total` has no history and stays editable.
  assert.equal(allowedAt(doc, objects, orderRow, columnsOf(doc, objects, tType('Order')).find((c) => c.key === 'total')!), true);

  const withStatic = withRows(doc, 'objects', [{ ...orderRow, status: 'stale' }]);
  const request = publishRequest(withStatic);
  assert.equal('status' in request.objects[0], false);
  assert.deepEqual(request.objectChanges, [
    { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'placed' },
    { object_id: 'o1', name: 'status', ts: '2026-01-05T11:00', value: 'shipped' },
  ]);
  // And the user is told, with a way to clean it up.
  const warning = validate(withStatic).find((i) => /Timed values replace/.test(i.message))!;
  assert.equal(warning.level, 'warning');
  assert.equal('status' in warning.fix!.apply(withStatic).sheets.objects.rows[0], false);
});

test('a Changes row is typed by the attribute it names', () => {
  const doc = exampleDoc();
  const valueColumn = changes.columns.find((c) => c.key === 'value')!;
  const nameColumn = changes.columns.find((c) => c.key === 'name')!;
  const suggestions = suggestionsOf(doc);

  // `quantity` is an integer on Item, so a word is wrong *in this row* while
  // being fine in a row naming a string attribute.
  const intRow: Row = { object_id: 'i1', name: 'quantity', ts: '2026-01-05T09:00', value: 'two' };
  assert.match(cellErrorAt(doc, changes, intRow, valueColumn)!, /whole number/);
  const strRow: Row = { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'two' };
  assert.equal(cellErrorAt(doc, changes, strRow, valueColumn), null);

  // The attribute column completes to the row's own object type's attributes.
  assert.deepEqual(completionsAt(doc, changes, intRow, nameColumn, suggestions), ['quantity']);
  assert.deepEqual(completionsAt(doc, changes, { object_id: 'o1' }, nameColumn, suggestions),
    ['total', 'placed', 'status']);
  // With no object yet, everything declared anywhere is a candidate.
  assert.deepEqual(completionsAt(doc, changes, {}, nameColumn, suggestions),
    ['total', 'placed', 'status', 'quantity']);
  // An attribute the object's type does not have is flagged on the cell.
  assert.match(cellErrorAt(doc, changes, { object_id: 'i1', name: 'status' }, nameColumn)!, /not an attribute of Item/);
});

test('the Changes sheet is validated against the schema', () => {
  const doc = exampleDoc();
  const bad = withRows(doc, 'changes', [
    { object_id: 'i1', name: 'quantity', ts: '2026-01-05T09:00', value: 'two' },
    { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'a' },
    { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'b' },
    { object_id: 'i2', name: 'colour', ts: '2026-01-05T09:00', value: 'red' },
  ]);
  const messages = validate(bad).map((i) => i.message);
  assert.ok(messages.some((m) => /“two” for quantity expects a whole number/.test(m)));
  assert.ok(messages.some((m) => /two values at 2026-01-05T09:00/.test(m)));
  const undeclared = validate(bad).find((i) => /“colour” is not an attribute of Item/.test(i.message))!;
  // With the one-click declaration, that error is gone.
  assert.ok(!validate(undeclared.fix!.apply(bad)).some((i) => /not an attribute of Item/.test(i.message)));
});

// --- loading an existing log ---------------------------------------------

const loaded = {
  name: 'Imported',
  semantics: {
    eventTypes: [{ name: 'Place order', attributes: [{ name: 'channel', type: 'string' }] }],
    objectTypes: [{ name: 'Order', attributes: [{ name: 'total', type: 'float' }] }],
  },
  events: [
    { event_id: 'e1', activity: 'Place order', ts: Date.parse('2026-01-05T09:00:00Z') },
    { event_id: 'e2', activity: 'Ship order', ts: null },
  ],
  eventAttrs: [
    { owner: 'e1', name: 'channel', value: 'web' },
    { owner: 'e2', name: 'crate', value: '7' },
  ],
  objects: [{ object_id: 'o1', object_type: 'Order' }, { object_id: 'i1', object_type: 'Item' }],
  objectAttrs: [
    { owner: 'o1', name: 'total', value: '39.90', ts: null },
    { owner: 'o1', name: 'status', value: 'placed', ts: Date.parse('2026-01-05T09:00:00Z') },
    { owner: 'o1', name: 'status', value: 'shipped', ts: Date.parse('2026-01-05T11:00:00Z') },
  ],
  e2o: [{ a: 'e1', b: 'o1', qualifier: 'order' }],
  o2o: [{ a: 'o1', b: 'i1', qualifier: 'contains' }],
};

test('an existing log loads with nothing dropped', () => {
  const doc = docFromLog(loaded);
  assert.equal(doc.name, 'Imported');
  assert.equal(doc.sheets.events.rows.length, 2);
  assert.equal(doc.sheets.events.rows[0].channel, 'web');
  assert.equal(doc.sheets.events.rows[1].ts, '');
  assert.deepEqual(doc.sheets.e2o.rows, [{ event_id: 'e1', object_id: 'o1', qualifier: 'order' }]);
  assert.deepEqual(doc.sheets.o2o.rows, [{ source_id: 'o1', target_id: 'i1', qualifier: 'contains' }]);

  // A static value stays a cell; timestamped ones become a history.
  assert.equal(doc.sheets.objects.rows[0].total, '39.90');
  assert.equal('status' in doc.sheets.objects.rows[0], false);
  assert.deepEqual(doc.sheets.changes.rows.map((r) => r.value), ['placed', 'shipped']);

  // Types the log declared are kept; ones it only used are declared, and so
  // are attributes that appear in rows but in no declaration.
  assert.deepEqual(doc.eventTypes.map((t) => t.name), ['Place order', 'Ship order']);
  assert.deepEqual(doc.eventTypes[1].attributes, [{ name: 'crate', type: 'integer' }]);
  assert.deepEqual(doc.objectTypes.map((t) => t.name), ['Order', 'Item']);
  assert.deepEqual(doc.objectTypes[0].attributes.map((a) => a.name), ['total', 'status']);
});

test('a loaded log is publishable unchanged — the round trip is closed', () => {
  const doc = docFromLog(loaded);
  assert.deepEqual(validate(doc).filter((i) => i.level === 'error'), []);
  const request = publishRequest(doc, 'a_source');
  assert.equal(request.source, 'a_source');
  assert.equal(request.events.length, 2);
  assert.equal(request.objectChanges.length, 2);
  assert.equal(request.objects[0].total, '39.90');
  assert.deepEqual(request.semantics.objectTypes[0].attributes,
    [{ name: 'total', type: 'float' }, { name: 'status', type: 'string' }]);
});

test('an undeclared attribute gets the type its values are consistent with', () => {
  assert.equal(inferAttrType(['1', '2', '30']), 'integer');
  assert.equal(inferAttrType(['1.5', '2']), 'float');
  assert.equal(inferAttrType(['true', 'FALSE']), 'boolean');
  assert.equal(inferAttrType(['2026-01-05T09:00']), 'time');
  assert.equal(inferAttrType(['web', '2']), 'string');
  assert.equal(inferAttrType([]), 'string');
  assert.equal(inferAttrType(['', '  ']), 'string');
});

test('timestamps come back as editable local text, seconds only when real', () => {
  const noSeconds = timestampText(Date.parse('2026-01-05T09:00:00Z'));
  assert.match(noSeconds, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.match(timestampText(Date.parse('2026-01-05T09:00:07Z')), /:07$/);
  assert.equal(timestampText(null), '');
  assert.equal(timestampText(undefined), '');
  // And parses back to the instant it came from.
  assert.equal(Date.parse(noSeconds), Date.parse('2026-01-05T09:00:00Z'));
});

test('a document with nothing in it still projects cleanly', () => {
  const doc: Doc = docFromLog({
    name: 'Empty', events: [], eventAttrs: [], objects: [], objectAttrs: [], e2o: [], o2o: [],
  });
  const projection = projectRows(doc, events);
  assert.deepEqual(projection.indices, []);
  assert.equal(projection.pages, 1);
  assert.equal(projection.spare, true);
  assert.deepEqual(applyProjection([], [], []), []);
});

// --- relations (the "+ relation" dialog) -----------------------------------

import {
  addE2O, addO2O, addObjectRow, objectIdExists, objectsList, relationsForEvent, relationsForObject,
  removeRelationRow, setRelationQualifier, suggestObjectId,
} from '../src/model.ts';

test('suggestObjectId derives a prefix from the type and skips taken ids', () => {
  const doc = exampleDoc();
  assert.equal(suggestObjectId(doc, 'Order'), 'o2'); // o1 exists
  assert.equal(suggestObjectId(doc, 'Item'), 'i3'); // i1, i2 exist
  assert.equal(suggestObjectId(doc, 'Shipment'), 's1');
  assert.equal(suggestObjectId(doc, ''), 'o2'); // fallback prefix 'o' collides with the existing o1
});

test('addE2O/addO2O add a relation once, deduplicating the exact triple', () => {
  const doc = exampleDoc();
  const before = doc.sheets.e2o.rows.length;
  const once = addE2O(doc, 'e2', 'o1', 'order');
  assert.equal(once.sheets.e2o.rows.length, before + 1);
  const twice = addE2O(once, 'e2', 'o1', 'order');
  assert.equal(twice.sheets.e2o.rows.length, before + 1); // no duplicate
  // A different qualifier is a different relation.
  const different = addE2O(once, 'e2', 'o1', 'shipped-with');
  assert.equal(different.sheets.e2o.rows.length, before + 2);

  const o2o = addO2O(doc, 'o1', 'i1', 'contains');
  assert.equal(o2o.sheets.o2o.rows.length, doc.sheets.o2o.rows.length); // already exists in exampleDoc
  const newO2O = addO2O(doc, 'i1', 'i2', 'siblings');
  assert.equal(newO2O.sheets.o2o.rows.length, doc.sheets.o2o.rows.length + 1);
});

test('relationsForEvent/relationsForObject list what a row is already linked to', () => {
  const doc = exampleDoc();
  const forE1 = relationsForEvent(doc, 'e1');
  assert.deepEqual(forE1.map((r) => r.otherId), ['o1', 'i1', 'i2']);
  assert.equal(forE1[0].otherType, 'Order');

  const forO1 = relationsForObject(doc, 'o1');
  assert.deepEqual(forO1.map((r) => r.otherId), ['i1', 'i2']);
  assert.equal(forO1[0].otherType, 'Item');
  // O2O is asymmetric: i1 is a target here, not a source, so it has none.
  assert.deepEqual(relationsForObject(doc, 'i1'), []);
});

test('removing or requalifying a relation targets it by index', () => {
  const doc = exampleDoc();
  const [first] = relationsForEvent(doc, 'e1');
  const requalified = setRelationQualifier(doc, 'e2o', first.index, 'primary');
  assert.equal(requalified.sheets.e2o.rows[first.index].qualifier, 'primary');
  const removed = removeRelationRow(doc, 'e2o', first.index);
  assert.equal(removed.sheets.e2o.rows.length, doc.sheets.e2o.rows.length - 1);
  assert.equal(relationsForEvent(removed, 'e1').some((r) => r.otherId === first.otherId), false);
});

test('objectsList/objectIdExists back the relation dialog’s picker', () => {
  const doc = exampleDoc();
  assert.deepEqual(objectsList(doc), [
    { id: 'o1', type: 'Order' }, { id: 'i1', type: 'Item' }, { id: 'i2', type: 'Item' },
  ]);
  assert.equal(objectIdExists(doc, 'o1'), true);
  assert.equal(objectIdExists(doc, ' o1 '), true);
  assert.equal(objectIdExists(doc, 'ghost'), false);
});

test('creating a new object then linking it is one operation on the doc', () => {
  const doc = exampleDoc();
  const withObject = addObjectRow(doc, 'o9', 'Order');
  assert.equal(objectIdExists(withObject, 'o9'), true);
  const linked = addE2O(withObject, 'e2', 'o9', 'order');
  assert.deepEqual(relationsForEvent(linked, 'e2').map((r) => r.otherId), ['i1', 'o9']);
});

// --- Issue.rows: precise navigation without an "All" tab -------------------

test('validate() points errors at the rows they are actually about', () => {
  const doc = withRows(exampleDoc(), 'events', [
    ...exampleDoc().sheets.events.rows, { event_id: 'e9', activity: 'Cancel order', ts: '' },
  ]);
  const rows = doc.sheets.events.rows;
  const issue = validate(doc).find((i) => /not a declared event type/.test(i.message))!;
  assert.deepEqual(issue.rows, [3]);
  assert.equal(rows[3].activity, 'Cancel order');

  const dup = withRows(exampleDoc(), 'events', [
    { event_id: 'e1', activity: 'Pick item', ts: '' }, { event_id: 'e1', activity: 'Pick item', ts: '' },
  ]);
  const dupIssue = validate(dup).find((i) => /Duplicate event id/.test(i.message))!;
  assert.deepEqual(dupIssue.rows, [0, 1]);

  const badVal = withRows(exampleDoc(), 'objects', [{ object_id: 'i1', object_type: 'Item', quantity: 'two' }]);
  const valIssue = validate(badVal).find((i) => /whole number/.test(i.message))!;
  assert.deepEqual(valIssue.rows, [0]);
});

test('two changes at the same instant point at both offending rows', () => {
  const doc = withRows(exampleDoc(), 'changes', [
    { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'a' },
    { object_id: 'o1', name: 'status', ts: '2026-01-05T09:00', value: 'b' },
  ]);
  const issue = validate(doc).find((i) => /two values at/.test(i.message))!;
  assert.deepEqual(issue.rows, [0, 1]);
});
