import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attributeColumns, attributesForRow, columnsOf, emptyDoc, exampleDoc, fillSeries, publishRequest,
  renameAttribute, renameType, sheetSpec, suggestionsOf, validate, valueError, withRows, withTypes,
} from '../src/model.ts';

const events = sheetSpec('events');
const objects = sheetSpec('objects');

test('fill continues an id series, keeping prefix and zero padding', () => {
  assert.deepEqual(fillSeries(['o1'], 3, 'text'), ['o2', 'o3', 'o4']);
  assert.deepEqual(fillSeries(['order-08'], 2, 'text'), ['order-09', 'order-10']);
  assert.deepEqual(fillSeries(['e1', 'e3'], 3, 'text'), ['e5', 'e7', 'e9']);
  assert.deepEqual(fillSeries(['7'], 2, 'text'), ['8', '9']);
});

test('fill repeats a non-numeric seed, cycling it', () => {
  assert.deepEqual(fillSeries(['Order'], 2, 'text'), ['Order', 'Order']);
  assert.deepEqual(fillSeries(['Order', 'Item'], 4, 'text'), ['Order', 'Item', 'Order', 'Item']);
  // Different prefixes are not one series, so they repeat rather than count.
  assert.deepEqual(fillSeries(['o1', 'i1'], 2, 'text'), ['o1', 'i1']);
});

test('fill respects a declared attribute type', () => {
  // A declared boolean is a two-value domain, not a counter.
  assert.deepEqual(
    fillSeries(['true'], 2, 'attr', { name: 'express', type: 'boolean' }),
    ['true', 'true'],
  );
  assert.deepEqual(
    fillSeries(['1'], 2, 'attr', { name: 'flag', type: 'boolean' }),
    ['1', '1'],
  );
  // An integer attribute still counts.
  assert.deepEqual(
    fillSeries(['1', '3'], 2, 'attr', { name: 'quantity', type: 'integer' }),
    ['5', '7'],
  );
  // A time attribute continues like the ts column.
  assert.deepEqual(
    fillSeries(['2026-01-05T09:00'], 1, 'attr', { name: 'placed', type: 'time' }),
    ['2026-01-05T10:00'],
  );
});

test('fill continues timestamps by their own step, in the seed’s own format', () => {
  assert.deepEqual(
    fillSeries(['2026-01-05T09:00', '2026-01-05T09:30'], 2, 'timestamp'),
    ['2026-01-05T10:00', '2026-01-05T10:30'],
  );
  assert.deepEqual(fillSeries(['2026-01-05T09:00'], 1, 'timestamp'), ['2026-01-05T10:00']);
  assert.deepEqual(fillSeries(['2026-01-05T09:00:00Z'], 1, 'timestamp'), ['2026-01-05T10:00:00Z']);
  assert.deepEqual(fillSeries(['2026-01-05T09:00Z'], 1, 'timestamp'), ['2026-01-05T10:00Z']);
  // Unparseable text is text, not a broken date.
  assert.deepEqual(fillSeries(['soon'], 1, 'timestamp'), ['soon']);
});

test('an empty seed fills blanks rather than inventing values', () => {
  assert.deepEqual(fillSeries([''], 2, 'text'), ['', '']);
  assert.deepEqual(fillSeries(['o1'], 0, 'text'), []);
});

test('typed values are checked against their declaration; blank is never wrong', () => {
  assert.equal(valueError('integer', '3'), null);
  assert.match(valueError('integer', '3.5')!, /whole number/);
  assert.equal(valueError('float', '39.90'), null);
  assert.match(valueError('float', 'cheap')!, /number/);
  assert.equal(valueError('boolean', 'TRUE'), null);
  assert.match(valueError('boolean', 'yes')!, /true or false/);
  assert.equal(valueError('time', '2026-01-05T09:00'), null);
  assert.match(valueError('time', 'soon')!, /date\/time/);
  for (const type of ['integer', 'float', 'boolean', 'time'] as const) {
    assert.equal(valueError(type, '  '), null);
  }
});

test('attribute columns are the union of the declared types’ attributes', () => {
  const doc = exampleDoc();
  assert.deepEqual(attributeColumns(doc, events).map((c) => c.key), ['channel', 'picker', 'express']);
  assert.deepEqual(attributeColumns(doc, objects).map((c) => c.key), ['total', 'placed', 'status', 'quantity']);
  assert.deepEqual(columnsOf(doc, objects).map((c) => c.key),
    ['object_id', 'object_type', 'total', 'placed', 'status', 'quantity']);

  // One column per attribute *name*, even when two types share it.
  const shared = withTypes(doc, 'object', [
    { name: 'Order', attributes: [{ name: 'total', type: 'float' }] },
    { name: 'Item', attributes: [{ name: 'total', type: 'float' }] },
  ]);
  assert.deepEqual(attributeColumns(shared, objects).map((c) => c.key), ['total']);
});

test('a row only has the attributes its own type declares', () => {
  const doc = exampleDoc();
  const order = doc.sheets.objects.rows[0];
  const item = doc.sheets.objects.rows[1];
  assert.deepEqual(attributesForRow(doc, objects, order).map((a) => a.name), ['total', 'placed', 'status']);
  assert.deepEqual(attributesForRow(doc, objects, item).map((a) => a.name), ['quantity']);
  // An undeclared or blank type has none — the grid then shows no editable
  // attribute cells for that row at all.
  assert.deepEqual(attributesForRow(doc, objects, { object_id: 'x', object_type: 'Ghost' }), []);
  assert.deepEqual(attributesForRow(doc, objects, { object_id: 'x' }), []);
});

test('the example log is publishable and states its own schema', () => {
  assert.deepEqual(validate(exampleDoc()).filter((i) => i.level === 'error'), []);
  const request = publishRequest(exampleDoc());
  assert.equal(request.events.length, 3);
  assert.equal(request.e2o.length, 5);
  assert.equal(request.o2o.length, 2);
  assert.deepEqual(request.semantics.objectTypes, [
    {
      name: 'Order',
      attributes: [
        { name: 'total', type: 'float' }, { name: 'placed', type: 'time' }, { name: 'status', type: 'string' },
      ],
    },
    { name: 'Item', attributes: [{ name: 'quantity', type: 'integer' }] },
  ]);
  assert.deepEqual(request.semantics.eventTypes.map((t) => t.name), ['Place order', 'Pick item', 'Ship order']);
  assert.equal(request.semantics.sourceFormat, 'json');
});

test('a row instantiating no declared type is an error with a one-click repair', () => {
  const doc = withRows(exampleDoc(), 'events', [
    ...exampleDoc().sheets.events.rows, { event_id: 'e4', activity: 'Cancel order', ts: '' },
  ]);
  const issue = validate(doc).find((i) => /not a declared event type/.test(i.message));
  assert.ok(issue && issue.level === 'error' && issue.fix);
  const repaired = issue!.fix!.apply(doc);
  assert.deepEqual(repaired.eventTypes.at(-1), { name: 'Cancel order', attributes: [] });
  assert.equal(validate(repaired).filter((i) => /not a declared/.test(i.message)).length, 0);
});

test('a value that contradicts its declaration blocks publishing', () => {
  const doc = withRows(exampleDoc(), 'objects', [
    { object_id: 'i1', object_type: 'Item', quantity: 'two' },
  ]);
  const issue = validate(doc).find((i) => /quantity/.test(i.message));
  assert.ok(issue && issue.level === 'error');
  assert.match(issue!.message, /whole number/);
});

test('two types cannot declare one attribute name with different types', () => {
  const doc = withTypes(exampleDoc(), 'object', [
    { name: 'Order', attributes: [{ name: 'total', type: 'float' }] },
    { name: 'Item', attributes: [{ name: 'total', type: 'integer' }] },
  ]);
  assert.ok(validate(doc).some((i) => /declared both float and integer/.test(i.message)));
});

test('an empty document reports what is missing, not everything at once', () => {
  const issues = validate(emptyDoc());
  assert.ok(issues.some((i) => /needs a name/.test(i.message)));
  assert.ok(issues.some((i) => /at least one event/.test(i.message)));
});

test('a dangling relation is an error with a one-click repair', () => {
  const doc = withRows(exampleDoc(), 'e2o', [
    ...exampleDoc().sheets.e2o.rows, { event_id: 'e9', object_id: 'o1', qualifier: 'order' },
  ]);
  const issue = validate(doc).find((i) => /do not exist/.test(i.message));
  assert.ok(issue && issue.level === 'error' && issue.fix);
  const after = validate(issue!.fix!.apply(doc));
  assert.equal(after.filter((i) => /do not exist/.test(i.message)).length, 0);
  assert.ok(after.some((i) => /no activity/.test(i.message)));
});

test('duplicate ids are caught in the sheet that declares them', () => {
  const doc = withRows(exampleDoc(), 'events', [
    { event_id: 'e1', activity: 'Pick item', ts: '' }, { event_id: 'e1', activity: 'Pick item', ts: '' },
  ]);
  assert.ok(validate(doc).some((i) => /Duplicate event id/.test(i.message)));
});

test('renaming a type carries its rows along', () => {
  const renamed = renameType(exampleDoc(), 'object', 1, 'Article');
  assert.equal(renamed.objectTypes[1].name, 'Article');
  assert.deepEqual(
    renamed.sheets.objects.rows.map((r) => r.object_type),
    ['Order', 'Article', 'Article'],
  );
  // And therefore leaves nothing undeclared behind.
  assert.equal(validate(renamed).filter((i) => /not a declared/.test(i.message)).length, 0);
});

test('renaming an attribute moves the values already typed under it', () => {
  const renamed = renameAttribute(exampleDoc(), 'object', 1, 0, 'count');
  assert.equal(renamed.objectTypes[1].attributes[0].name, 'count');
  assert.equal(renamed.sheets.objects.rows[1].count, '2');
  assert.equal('quantity' in renamed.sheets.objects.rows[1], false);
});

test('publishing drops blank cells and values no longer covered by a type', () => {
  const doc = withRows(exampleDoc(), 'objects', [
    // `quantity` belongs to Item, not Order: a leftover from a type change.
    { object_id: 'o1', object_type: 'Order', total: '', quantity: '9' },
  ]);
  const [published] = publishRequest(doc).objects;
  assert.deepEqual(Object.keys(published), ['object_id', 'object_type']);
});

test('suggestions offer declared types and existing ids', () => {
  const s = suggestionsOf(exampleDoc());
  assert.deepEqual(s.objectId, ['o1', 'i1', 'i2']);
  assert.deepEqual(s.objectType, ['Order', 'Item']);
  assert.deepEqual(s.eventType, ['Place order', 'Pick item', 'Ship order']);
  assert.deepEqual(s.qualifier, ['order', 'item', 'contains']);
  // A type declared but not yet used still completes — that is the point of
  // declaring it before typing rows.
  const declaredOnly = withTypes(emptyDoc(), 'event', [{ name: 'Only', attributes: [] }]);
  assert.deepEqual(suggestionsOf(declaredOnly).eventType, ['Only']);
});
