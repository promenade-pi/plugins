import assert from 'node:assert/strict';
import test from 'node:test';
import { EDIT_ROW_CAP, loadLogDoc } from '../src/load.ts';
import { validate } from '../src/model.ts';

const tables = {
  event: 'src__event', object: 'src__object', e2o: 'src__e2o', o2o: 'src__o2o',
  event_attr: 'src__event_attr', object_attr: 'src__object_attr',
};

/** A stub standing in for `promenade.sql`, answering by table name. */
function stub(answers: Record<string, { numRows: number; columns: Record<string, unknown[]> }>) {
  const asked: string[] = [];
  const sql = async (query: string) => {
    asked.push(query);
    for (const [key, result] of Object.entries(answers)) if (query.includes(key)) return result;
    return { numRows: 0, columns: {} };
  };
  return { sql, asked };
}

const counts = (events: number, objects: number) => ({
  numRows: 1, columns: { events: [events], objects: [objects] },
});

test('a log past the cap is refused, with the counts that made it too large', async () => {
  const { sql, asked } = stub({ 'COUNT(*)': counts(EDIT_ROW_CAP + 1, 12) });
  const outcome = await loadLogDoc({ name: 'Huge', tables }, sql);
  assert.equal(outcome.ok, false);
  assert.deepEqual((outcome as any).tooBig, { events: EDIT_ROW_CAP + 1, objects: 12, cap: EDIT_ROW_CAP });
  // And nothing was read: refusing costs one counting query, not a load.
  assert.equal(asked.length, 1);
});

test('objects alone can make a log too large', async () => {
  const { sql } = stub({ 'COUNT(*)': counts(10, EDIT_ROW_CAP * 2) });
  assert.equal((await loadLogDoc({ name: 'Wide', tables }, sql)).ok, false);
});

test('a log at the cap still loads', async () => {
  const { sql } = stub({
    'COUNT(*)': counts(EDIT_ROW_CAP, EDIT_ROW_CAP),
    'FROM src__event ': { numRows: 1, columns: { event_id: ['e1'], activity: ['A'], ts_ms: [0] } },
    'FROM src__object ': { numRows: 1, columns: { object_id: ['o1'], object_type: ['T'] } },
  });
  const outcome = await loadLogDoc({ name: 'At the cap', tables }, sql);
  assert.equal(outcome.ok, true);
});

test('a log missing its optional relations loads anyway', async () => {
  const { sql } = stub({
    'COUNT(*)': counts(1, 1),
    'FROM src__event ': { numRows: 1, columns: { event_id: ['e1'], activity: ['A'], ts_ms: [null] } },
    'FROM src__object ': { numRows: 1, columns: { object_id: ['o1'], object_type: ['T'] } },
  });
  // No attribute or relation tables at all — an OCEL log may have none.
  const outcome = await loadLogDoc({ name: 'Bare', tables: { event: tables.event, object: tables.object } }, sql);
  assert.ok(outcome.ok);
  const doc = (outcome as any).doc;
  assert.equal(doc.sheets.events.rows.length, 1);
  assert.deepEqual(doc.sheets.e2o.rows, []);
  assert.deepEqual(doc.eventTypes, [{ name: 'A', attributes: [] }]);
  // It is loadable but not yet publishable: an event relating to nothing is
  // reported the same way it would be for a hand-written log.
  assert.ok(validate(doc).some((i) => /relate to no object/.test(i.message)));
});

test('a log with no event table is a load error, not an empty document', async () => {
  const { sql } = stub({});
  await assert.rejects(() => loadLogDoc({ name: 'Broken', tables: {} }, sql), /no event or object table/);
});
