import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/engine.js';

const engine = globalThis.InteractionAtlasEngine;
const base = [
  { eventId: 'e1', objectId: 'o1', objectType: 'Order', timestamp: 0, activity: 'create' },
  { eventId: 'e1', objectId: 'd1', objectType: 'Delivery', timestamp: 0, activity: 'create' },
  { eventId: 'e2', objectId: 'o1', objectType: 'Order', timestamp: 100, activity: 'ship' },
  { eventId: 'e2', objectId: 'd1', objectType: 'Delivery', timestamp: 200, activity: 'ship' },
];

function pair(result, a, b) { return result.pairs.find((p) => p.typeA === a && p.typeB === b); }
function mass(field) { return Array.from(field.bins).reduce((a, b) => a + b, 0); }

test('lifecycle phases, including phase 1.0, enter deterministic final bins', () => {
  const r = engine.compute(base, { binCount: 4, weighting: 'pair-mass' }, 'log');
  const p = pair(r, 'Delivery', 'Order');
  assert.equal(p.rawObservationCount, 2);
  assert.equal(mass(p), 2);
  assert.equal(p.bins[0], 1, 'the first interaction is in bin (0,0)');
  assert.equal(p.bins[15], 1, 'phase 1.0 belongs to the final bin');
});

test('equal event mass conserves one unit per participating object-type pair', () => {
  const rows = [
    { eventId: 'e', objectId: 'a1', objectType: 'A', timestamp: 0 },
    { eventId: 'e', objectId: 'a2', objectType: 'A', timestamp: 0 },
    { eventId: 'e', objectId: 'b1', objectType: 'B', timestamp: 0 },
    { eventId: 'e', objectId: 'b2', objectType: 'B', timestamp: 0 },
    { eventId: 'e', objectId: 'b3', objectType: 'B', timestamp: 0 },
  ];
  const r = engine.compute(rows, { binCount: 8, weighting: 'equal-event-mass' });
  const ab = pair(r, 'A', 'B'), aa = pair(r, 'A', 'A'), bb = pair(r, 'B', 'B');
  assert.equal(ab.rawObservationCount, 6); assert.ok(Math.abs(mass(ab) - 1) < 1e-12);
  assert.equal(aa.rawObservationCount, 1); assert.equal(mass(aa), 1);
  assert.equal(bb.rawObservationCount, 3); assert.equal(mass(bb), 1);
});

test('high-multiplicity events retain every observed pair while equal-event mass stays finite', () => {
  const rows = [];
  for (let i = 0; i < 96; i++) rows.push({ eventId: 'batch', objectId: 'a'+i, objectType: 'A', timestamp: i });
  for (let i = 0; i < 128; i++) rows.push({ eventId: 'batch', objectId: 'b'+i, objectType: 'B', timestamp: i });
  const equal = pair(engine.compute(rows, { binCount: 24, weighting: 'equal-event-mass' }), 'A', 'B');
  const raw = pair(engine.compute(rows, { binCount: 24, weighting: 'pair-mass' }), 'A', 'B');
  assert.equal(equal.rawObservationCount, 96 * 128);
  assert.equal(raw.rawObservationCount, 96 * 128);
  assert.ok(Math.abs(mass(equal) - 1) < 1e-10, 'one event contributes exactly one equal-event mass');
  assert.equal(mass(raw), 96 * 128, 'pair-mass retains the full multiplicity');
  assert.equal(equal.multiplicity['many-to-many'], 1);
});

test('same-type pairs are unordered, distinct, and counted once', () => {
  const rows = ['x1', 'x2', 'x3'].map((objectId) => ({ eventId: 'e', objectId, objectType: 'X', timestamp: 10 }));
  const r = engine.compute(rows, { weighting: 'pair-mass' });
  const xx = pair(r, 'X', 'X');
  assert.equal(xx.rawObservationCount, 3);
  assert.equal(mass(xx), 3);
});

test('transpose symmetry swaps axes and directional coverage', () => {
  const r = engine.compute(base, { binCount: 4, weighting: 'pair-mass' });
  const forward = pair(r, 'Delivery', 'Order');
  const backward = engine.transpose(forward, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assert.equal(backward.bins[y * 4 + x], forward.bins[x * 4 + y]);
  assert.equal(backward.coverageAToB, forward.coverageBToA);
});

test('filtered bounds, zero-duration lifecycles and missing timestamps are explicit', () => {
  const rows = base.concat([
    { eventId: 'e3', objectId: 'z', objectType: 'Zero', timestamp: 50 },
    { eventId: 'e3', objectId: 'o1', objectType: 'Order', timestamp: 50 },
    { eventId: 'bad', objectId: 'o1', objectType: 'Order', timestamp: null },
  ]);
  const r = engine.compute(rows, { lifecycleBounds: 'filtered', includeZeroDurationObjects: true });
  assert.equal(pair(r, 'Order', 'Zero').rawObservationCount, 1);
  assert.equal(r.objectTypes.find((x) => x.type === 'Zero').zeroDurationObjectCount, 1);
  assert.equal(r.warnings[0].code, 'excluded-timestamps');
});

test('selection and deterministic representatives use identities instead of fabricated records', () => {
  const r = engine.compute(base, { weighting: 'pair-mass' });
  const p = pair(r, 'Delivery', 'Order');
  const selected = engine.select(p, { minPhaseA: 0.9, maxPhaseA: 1, minPhaseB: 0.9, maxPhaseB: 1 });
  assert.equal(selected.length, 1);
  assert.equal(engine.representative(selected)[0].observation.eventId, 'e2');
});
