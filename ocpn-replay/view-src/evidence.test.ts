import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenSim } from './evidence.ts';
import type { OcpnPayload } from './types.ts';

/** order: src -> A -> p -> tau -> q -> B -> sink  (item shares A and B) */
function net(): OcpnPayload {
  const places: OcpnPayload['places'] = [];
  const transitions: OcpnPayload['transitions'] = [
    { id: 't:A', activity: 'A', objectTypes: ['order', 'item'] },
    { id: 't:B', activity: 'B', objectTypes: ['order', 'item'] },
  ];
  const arcs: OcpnPayload['arcs'] = [];
  for (const ot of ['order', 'item']) {
    const [s, p, q, k] = [`p:${ot}:src`, `p:${ot}:p`, `p:${ot}:q`, `p:${ot}:sink`];
    places.push(
      { id: s, objectType: ot, kind: 'source' },
      { id: p, objectType: ot, kind: 'normal' },
      { id: q, objectType: ot, kind: 'normal' },
      { id: k, objectType: ot, kind: 'sink' },
    );
    transitions.push({ id: `t:tau:${ot}`, activity: null, objectTypes: [ot] });
    const link = (a: string, b: string) => arcs.push({
      id: `a${arcs.length}`, objectType: ot, variable: false,
      source: { kind: a.startsWith('p:') ? 'place' : 'transition', id: a },
      target: { kind: b.startsWith('p:') ? 'place' : 'transition', id: b },
    });
    link(s, 't:A'); link('t:A', p); link(p, `t:tau:${ot}`); link(`t:tau:${ot}`, q); link(q, 't:B'); link('t:B', k);
  }
  return { objectTypes: ['order', 'item'], places, transitions, arcs, metadata: {} as any };
}

test('replays fire/silent steps against the net to reconstruct markings', () => {
  const sim = new TokenSim(net(), [
    { e: 'e1', t: 0, a: 'A', steps: [{ o: 'o1', ot: 'order', tr: 't:A', k: 'fire' }] },
    { e: 'e2', t: 1, a: 'B', steps: [
      { o: 'o1', ot: 'order', tr: 't:tau:order', k: 'silent' },
      { o: 'o1', ot: 'order', tr: 't:B', k: 'fire' },
    ] },
  ]);

  sim.seekTo(0);
  assert.equal(sim.placeTokens().size, 0, 'no object has entered yet');

  sim.seekTo(1);
  assert.equal(sim.placeTokens().get('p:order:p')?.count, 1, 'A moved the token to p');
  assert.deepEqual([...sim.effect.firedTransitions], ['t:A']);

  sim.seekTo(2);
  const m = sim.placeTokens();
  assert.equal(m.get('p:order:sink')?.count, 1, 'B left the token on the sink');
  assert.equal(m.get('p:order:p'), undefined);
  assert.deepEqual([...sim.effect.silentTransitions], ['t:tau:order']);

  // Scrubbing backwards reconstructs an earlier marking exactly.
  sim.seekTo(1);
  assert.equal(sim.placeTokens().get('p:order:p')?.count, 1);
});

test('a log move changes no marking but flags the activity', () => {
  const sim = new TokenSim(net(), [
    { e: 'e1', t: 0, a: 'B', steps: [{ o: 'o1', ot: 'order', k: 'logmove' }] },
  ]);
  sim.seekTo(1);
  assert.equal(sim.placeTokens().get('p:order:src')?.count, 1, 'token stays put');
  assert.deepEqual([...sim.effect.logMoveTransitions], ['t:B']);
});
