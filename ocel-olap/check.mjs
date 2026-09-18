#!/usr/bin/env node
/**
 * Offline invariant checks for the four OLAP programs.
 *
 * Run by `package.sh` before anything is packaged, and standalone with
 * `node check.mjs`. There is no Rust in this plugin and no kernel — the
 * operations *are* the SQL — so this is where its correctness lives.
 *
 * Two layers, and the second is the point:
 *
 *   1. Each program is parsed and validated by the host's own SQL Profile v1
 *      modules (`app/src/host/relational/`), then compiled by the host's own
 *      compiler. A forbidden call, a forward reference or a statement naming a
 *      relation the input type does not have fails here rather than at install
 *      time on someone else's machine.
 *
 *   2. The compiled SQL is then *executed*, against real DuckDB (the same
 *      duckdb-wasm the app runs), over hand-built logs. Reading SQL is not
 *      the same as knowing what it does: the LIKE pattern that decides a
 *      roll-up, the QUALIFY that picks one value out of an attribute history,
 *      and the bound parameter inside a string concatenation are each things
 *      that behave differently from how they read.
 *
 * What is asserted:
 *
 *   1. Every program declares all six OCEL relations, so what it produces is
 *      a complete log rather than a fragment nothing downstream can mount.
 *   2. Drilling down splits exactly the named type, by the named attribute,
 *      and leaves objects with no value on the parent type.
 *   3. A time-dependent attribute is read at its earliest value.
 *   4. **Rolling up undoes drilling down, exactly** — the whole log, not just
 *      the objects table.
 *   5. Unfolding splits exactly the named activity, and only the events that
 *      touch the named object type, honouring the qualifier when given.
 *   6. **Folding undoes unfolding, exactly.**
 *   7. Nothing but the one renamed column ever changes: no operation adds,
 *      removes or reorders an event, an object or a relation.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { parseProgram } from '../../app/src/host/relational/sqlProfile.ts';
import { compileProgram } from '../../app/src/host/relational/compileProgram.ts';
import { schemaFor } from '../../app/src/host/relational/schemas.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '../../app/package.json'));
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');

const RELATIONS = ['events', 'objects', 'event_object', 'object_object', 'event_attributes', 'object_attributes'];
/** The physical table each logical relation is read from, as the host maps them. */
const PHYSICAL = {
  events: 'event', objects: 'object', event_object: 'e2o',
  object_object: 'o2o', event_attributes: 'event_attr', object_attributes: 'object_attr',
};

let failures = 0;
function check(what, condition, detail) {
  if (condition) return;
  failures++;
  console.error(`✗ ${what}${detail ? `\n    ${detail}` : ''}`);
}
function equal(what, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(what, a === b, a === b ? '' : `got      ${a}\n    wanted   ${b}`);
}

// --- the host's own parsing and compilation ----------------------------

const PROGRAMS = {
  'drill-down': { file: 'sql/drill-down.sql', params: { objectType: 'string', attribute: 'string' } },
  'roll-up': { file: 'sql/roll-up.sql', params: { objectType: 'string' } },
  unfold: { file: 'sql/unfold.sql', params: { activity: 'string', objectType: 'string', qualifier: 'string' } },
  fold: { file: 'sql/fold.sql', params: { activity: 'string' } },
};

function compile(name, params) {
  const { file, params: declared } = PROGRAMS[name];
  const program = parseProgram(readFileSync(join(HERE, file), 'utf8'));
  const declaredParams = Object.fromEntries(
    Object.entries(declared).map(([key, type]) => [key, { type }]),
  );
  return compileProgram(
    program,
    [{ role: 'log', artifactId: 'a_test', artifactType: 'ObjectCentricEventLog' }],
    params,
    undefined,
    { physicalTableOf: (_id, logical) => PHYSICAL[logical] ?? logical, declaredParams },
  );
}

for (const [name, { file }] of Object.entries(PROGRAMS)) {
  const program = parseProgram(readFileSync(join(HERE, file), 'utf8'));
  const outputs = program.statements.filter((s) => s.kind === 'output').map((s) => s.name);
  const schema = schemaFor('ObjectCentricEventLog');
  equal(`${name}: declares every relation of an OCEL`, [...outputs].sort(), [...RELATIONS].sort());
  check(
    `${name}: every output is a relation the schema declares`,
    outputs.every((o) => schema.relations.some((r) => r.name === o)),
  );
}

// --- real DuckDB -------------------------------------------------------

const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB(
  {
    mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'), mainWorker: join(DIST, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: join(DIST, 'duckdb-eh.wasm'), mainWorker: join(DIST, 'duckdb-node-eh.worker.cjs') },
  },
  new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR),
  duckdb.NODE_RUNTIME,
);
await db.instantiate(() => {});
const conn = db.connect();

/**
 * One DuckDB value as a comparable string.
 *
 * Timestamps arrive from Arrow as epoch milliseconds, and this harness feeds
 * results back in as literals for the round-trip checks — so they are printed
 * the way DuckDB reads them back. Harness-local: nothing about the programs
 * themselves depends on it.
 */
function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) > 1e11) {
    return new Date(v).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  return String(v);
}

/** A log as six lists of rows, loaded into the physical tables the host would mount. */
function load(log) {
  const ddl = {
    event: 'event_id VARCHAR, activity VARCHAR, ts TIMESTAMP',
    object: 'object_id VARCHAR, object_type VARCHAR',
    e2o: 'event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR',
    o2o: 'source_id VARCHAR, target_id VARCHAR, qualifier VARCHAR',
    event_attr: 'event_id VARCHAR, name VARCHAR, value VARCHAR',
    object_attr: 'object_id VARCHAR, name VARCHAR, value VARCHAR, ts TIMESTAMP',
  };
  for (const [table, columns] of Object.entries(ddl)) {
    conn.query(`CREATE OR REPLACE TABLE ${table} (${columns})`);
    for (const row of log[table] ?? []) {
      const values = row.map((v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)).join(', ');
      conn.query(`INSERT INTO ${table} VALUES (${values})`);
    }
  }
}

/** Runs one operation and returns its six output relations as arrays of plain rows. */
function run(name, params) {
  const compiled = compile(name, params);
  const out = {};
  for (const statement of compiled.statements) {
    if (statement.kind !== 'output') continue;
    const prepared = conn.prepare(statement.sql);
    try {
      out[statement.name] = prepared.query(...statement.values).toArray()
        .map((r) => Object.values(r.toJSON()).map(cell));
    } finally {
      prepared.close();
    }
  }
  return out;
}

const sorted = (rows) => [...rows].map((r) => r.join('')).sort();

/** Every physical table as plain rows — the log as DuckDB currently holds it.
 *  Comparisons go value-to-value through the same reader the results use, so a
 *  timestamp is never compared against the way a JS literal happens to print. */
function snapshot() {
  return Object.fromEntries(RELATIONS.map((relation) => [
    relation,
    conn.query(`SELECT * FROM ${PHYSICAL[relation]}`).toArray()
      .map((r) => Object.values(r.toJSON()).map(cell)),
  ]));
}

// A small log with two object types, an attribute with a gap in it, and one
// object whose attribute changes over time.
const LOG = {
  event: [
    ['e1', 'place order', '2025-01-01 09:00:00'],
    ['e2', 'pay', '2025-01-01 10:00:00'],
    ['e3', 'pay', '2025-01-02 10:00:00'],
    ['e4', 'ship', '2025-01-03 10:00:00'],
  ],
  object: [
    ['o1', 'Order'],
    ['o2', 'Order'],
    ['o3', 'Order'],
    ['c1', 'Customer'],
    ['s1', 'Supplier'],
  ],
  e2o: [
    ['e1', 'o1', 'places'],
    ['e2', 'o1', 'for'],
    ['e2', 'c1', 'by'],
    ['e3', 's1', 'to'],
    ['e4', 'o2', 'ships'],
  ],
  o2o: [['o1', 'c1', 'belongs to']],
  event_attr: [['e1', 'channel', 'web']],
  object_attr: [
    ['o1', 'priority', 'gold', null],
    ['o2', 'priority', 'standard', null],
    // o3 has no priority at all, and a value for a different attribute.
    ['o3', 'region', 'north', null],
    // c1's priority changes: the earliest value is the one drilling down uses.
    ['c1', 'priority', 'silver', '2025-01-01 00:00:00'],
    ['c1', 'priority', 'gold', '2025-06-01 00:00:00'],
  ],
};

load(LOG);

// 2 + 3. Drilling down splits the named type only, by the named attribute.
const drilled = run('drill-down', { objectType: 'Order', attribute: 'priority' });
equal(
  'drill down: splits the named type and leaves the valueless object on the parent',
  sorted(drilled.objects),
  sorted([
    ['o1', '(Order, gold)'],
    ['o2', '(Order, standard)'],
    ['o3', 'Order'],
    ['c1', 'Customer'],
    ['s1', 'Supplier'],
  ]),
);

const drilledCustomer = run('drill-down', { objectType: 'Customer', attribute: 'priority' });
equal(
  'drill down: a time-dependent attribute is read at its earliest value',
  drilledCustomer.objects.find((r) => r[0] === 'c1'),
  ['c1', '(Customer, silver)'],
);

// 7. Nothing else moves.
const before = snapshot();
for (const relation of RELATIONS.filter((r) => r !== 'objects')) {
  equal(`drill down: ${relation} passes through untouched`, sorted(drilled[relation]), sorted(before[relation]));
}

// 4. Roll-up undoes drill-down, over the whole log.
load({ ...LOG, object: drilled.objects });
const rolled = run('roll-up', { objectType: 'Order' });
for (const relation of RELATIONS) {
  equal(`roll up: ${relation} is exactly what drilling down was given`, sorted(rolled[relation]), sorted(before[relation]));
}

// 5. Unfolding splits exactly the events that touch the named object type.
load(LOG);
const unfolded = run('unfold', { activity: 'pay', objectType: 'Customer', qualifier: '' });
equal(
  'unfold: only the matching events of the named activity are renamed',
  sorted(unfolded.events.map((r) => [r[0], r[1]])),
  sorted([
    ['e1', 'place order'],
    ['e2', '(pay, Customer)'],
    ['e3', 'pay'],
    ['e4', 'ship'],
  ]),
);

const byQualifier = run('unfold', { activity: 'pay', objectType: 'Customer', qualifier: 'for' });
equal(
  'unfold: a qualifier restricts which relations count',
  byQualifier.events.find((r) => r[0] === 'e2').slice(0, 2),
  ['e2', 'pay'],
);

for (const relation of RELATIONS.filter((r) => r !== 'events')) {
  equal(`unfold: ${relation} passes through untouched`, sorted(unfolded[relation]), sorted(before[relation]));
}

// 6. Folding undoes unfolding.
load({ ...LOG, event: unfolded.events });
const folded = run('fold', { activity: 'pay' });
equal('fold: undoes unfolding exactly', sorted(folded.events), sorted(before.events));

// A log that has nothing to fold or roll up is returned unchanged rather than
// mangled — the operations are total, not conditional on having been preceded
// by their inverse.
load(LOG);
const foldNothing = run('fold', { activity: 'pay' });
equal('fold: a log with no unfolded events is unchanged', sorted(foldNothing.events), sorted(before.events));

const rollNothing = run('roll-up', { objectType: 'Order' });
equal('roll up: a log with no sub-types is unchanged', sorted(rollNothing.objects), sorted(before.objects));

conn.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('all OCEL OLAP checks passed');
