/**
 * The compilers are the part of this plugin with a contract: whatever the
 * canvas does, what it publishes has to satisfy the host's own validators.
 * So the test compiles nets and runs the *real* host validators over the
 * result, rather than asserting on a shape this file also made up.
 */
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const APP = path.resolve(__dirname, '../../../app');
const OUT = path.join(__dirname, '.build');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const esbuild = path.join(__dirname, '../node_modules/.bin/esbuild');
for (const [src, out] of [
  [path.join(__dirname, '../src/model.ts'), path.join(OUT, 'model.mjs')],
  [path.join(APP, 'src/host/artifact/petri-net.ts'), path.join(OUT, 'petri-net.mjs')],
  [path.join(APP, 'src/host/artifact/ocpn.ts'), path.join(OUT, 'ocpn.mjs')],
]) execFileSync(esbuild, [src, '--format=esm', `--outfile=${out}`], { stdio: 'pipe' });

(async () => {
  const M = await import(path.join(OUT, 'model.mjs'));
  const { validateAcceptingPetriNet } = await import(path.join(OUT, 'petri-net.mjs'));
  const { validateOcpn } = await import(path.join(OUT, 'ocpn.mjs'));

  const place = (id, over = {}) => ({ id, kind: 'place', name: id, objectType: null, marking: 'none', x: 0, y: 0, ...over });
  const trans = (id, over = {}) => ({ id, kind: 'transition', name: id, silent: false, x: 0, y: 0, ...over });
  const arc = (id, source, target, over = {}) => ({ id, source, target, objectType: null, variable: false, ...over });

  test('a plain net compiles to a valid AcceptingPetriNet', () => {
    const doc = {
      name: 'n', objectTypes: [],
      nodes: [place('p0', { marking: 'initial' }), trans('t0'), place('p1', { marking: 'final' }), trans('tau', { silent: true })],
      arcs: [arc('a0', 'p0', 't0'), arc('a1', 't0', 'p1')],
    };
    assert.deepEqual(M.validateDoc(doc), []);
    assert.equal(M.targetType(doc), 'AcceptingPetriNet');
    const payload = M.compile(doc);
    assert.equal(validateAcceptingPetriNet(payload), null);
    assert.deepEqual(payload.initial_marking, [0]);
    assert.deepEqual(payload.final_marking, [1]);
    assert.deepEqual(payload.labels, ['t0', null]);
    assert.deepEqual(payload.activities, [0], 'a silent transition is not an activity');
    assert.equal(payload.stats.silent_transitions, 1);
  });

  test('declaring an object type switches the target to an OCPN', () => {
    const doc = {
      name: 'n',
      objectTypes: [{ name: 'order', color: '#0072B2' }],
      nodes: [place('p0', { objectType: 'order', marking: 'initial' }), trans('t0'), place('p1', { objectType: 'order', marking: 'final' })],
      arcs: [arc('a0', 'p0', 't0', { objectType: 'order' }), arc('a1', 't0', 'p1', { objectType: 'order', variable: true })],
    };
    assert.deepEqual(M.validateDoc(doc), []);
    assert.equal(M.targetType(doc), 'ObjectCentricPetriNet');
    const payload = M.compile(doc);
    assert.equal(validateOcpn(payload), null);
    assert.deepEqual(payload.places.map((p) => p.kind), ['source', 'sink']);
    assert.deepEqual(payload.transitions[0].objectTypes, ['order'], 'a transition takes its types from its arcs');
    assert.equal(payload.arcs.filter((a) => a.variable).length, 1);
  });

  test('validation catches what the canvas can express but a net cannot', () => {
    const bipartite = {
      name: 'n', objectTypes: [],
      nodes: [place('p0'), place('p1')],
      arcs: [arc('a0', 'p0', 'p1')],
    };
    assert.match(M.validateDoc(bipartite)[0].message, /joins two places/);

    const untyped = {
      name: 'n', objectTypes: [{ name: 'order', color: '#0072B2' }],
      nodes: [place('p0'), trans('t0')],
      arcs: [arc('a0', 'p0', 't0')],
    };
    const messages = M.validateDoc(untyped).map((p) => p.message).join(' | ');
    assert.match(messages, /has no object type/);

    const unnamed = {
      name: 'n', objectTypes: [],
      nodes: [trans('t0', { name: '' })], arcs: [],
    };
    assert.match(M.validateDoc(unnamed)[0].message, /no activity name/);

    assert.match(M.validateDoc({ name: 'n', objectTypes: [], nodes: [], arcs: [] })[0].message, /empty/);
  });

  test('a dangling arc never reaches the payload', () => {
    const doc = {
      name: 'n', objectTypes: [],
      nodes: [place('p0'), trans('t0')],
      arcs: [arc('a0', 'p0', 't0'), arc('a1', 'p0', 'gone')],
    };
    assert.match(M.validateDoc(doc).map((p) => p.message).join(' '), /loose end/);
    // Even so, compiling must not emit an arc to a node that is not there —
    // the host validator would reject the whole publish for it.
    assert.equal(validateAcceptingPetriNet(M.compile(doc)), null);
  });
})();

/* ------------------------------------------------------------------ *
 * Decompiling: opening a published net for editing.
 * ------------------------------------------------------------------ */
(async () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(path.join(__dirname, '../node_modules/.bin/esbuild'),
    [path.join(__dirname, '../src/decompile.ts'), '--bundle', '--format=esm',
     `--outfile=${path.join(OUT, 'decompile.mjs')}`], { stdio: 'pipe' });
  const D = await import(path.join(OUT, 'decompile.mjs'));
  const M = await import(path.join(OUT, 'model.mjs'));
  const { validateAcceptingPetriNet } = await import(path.join(OUT, 'petri-net.mjs'));
  const { validateOcpn } = await import(path.join(OUT, 'ocpn.mjs'));

  /** What survives a trip through the catalog. Positions do not, by design,
   *  and internal ids do not either — the payload addresses nodes by name. */
  const shape = (doc) => ({
    objectTypes: doc.objectTypes.map((t) => t.name),
    places: doc.nodes.filter((n) => n.kind === 'place')
      .map((p) => ({ name: p.name, objectType: p.objectType, marking: p.marking }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    transitions: doc.nodes.filter((n) => n.kind === 'transition')
      .map((t) => ({ name: t.name, silent: t.silent }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    arcs: doc.arcs.map((a) => {
      const from = doc.nodes.find((n) => n.id === a.source);
      const to = doc.nodes.find((n) => n.id === a.target);
      return `${from.name}->${to.name}:${a.objectType ?? ''}${a.variable ? '*' : ''}`;
    }).sort(),
  });

  test('a published Petri net opens as the net that was published', () => {
    const doc = {
      name: 'Round trip', objectTypes: [],
      nodes: [
        { id: 'p0', kind: 'place', name: 'start', objectType: null, marking: 'initial', x: 0, y: 0 },
        { id: 't0', kind: 'transition', name: 'Check in', silent: false, x: 0, y: 0 },
        { id: 't1', kind: 'transition', name: '', silent: true, x: 0, y: 0 },
        { id: 'p1', kind: 'place', name: 'end', objectType: null, marking: 'final', x: 0, y: 0 },
      ],
      arcs: [
        { id: 'a0', source: 'p0', target: 't0', objectType: null, variable: false },
        { id: 'a1', source: 't0', target: 'p1', objectType: null, variable: false },
        { id: 'a2', source: 'p0', target: 't1', objectType: null, variable: false },
      ],
    };
    const payload = M.compile(doc);
    assert.equal(validateAcceptingPetriNet(payload), null);
    const { doc: back, notes } = D.decompile('AcceptingPetriNet', payload, 'Round trip');
    assert.deepEqual(notes, []);
    assert.deepEqual(shape(back), shape(doc));
    // And what comes back must itself be publishable, or an edit is a one-way
    // trip that fails at the far end.
    assert.equal(validateAcceptingPetriNet(M.compile(back)), null);
  });

  test('a published OCPN opens with its types, markings and variable arcs', () => {
    const doc = {
      name: 'OC round trip',
      objectTypes: [{ name: 'order', color: '#0072B2' }, { name: 'item', color: '#E69F00' }],
      nodes: [
        { id: 'p0', kind: 'place', name: 'ordered', objectType: 'order', marking: 'initial', x: 0, y: 0 },
        { id: 't0', kind: 'transition', name: 'pick', silent: false, x: 0, y: 0 },
        { id: 'p1', kind: 'place', name: 'picked', objectType: 'item', marking: 'final', x: 0, y: 0 },
      ],
      arcs: [
        { id: 'a0', source: 'p0', target: 't0', objectType: 'order', variable: false },
        { id: 'a1', source: 't0', target: 'p1', objectType: 'item', variable: true },
      ],
    };
    const payload = M.compile(doc);
    assert.equal(validateOcpn(payload), null);
    const { doc: back } = D.decompile('ObjectCentricPetriNet', payload, 'OC round trip');
    assert.deepEqual(shape(back), shape(doc));
    assert.equal(M.targetType(back), 'ObjectCentricPetriNet');
    assert.equal(validateOcpn(M.compile(back)), null);
    assert.deepEqual(M.validateDoc(back), []);
  });

  test('every node gets a position, cycles included', () => {
    // A loop has no longest path, which is the case a naive ranking drops.
    const { doc } = D.decompile('AcceptingPetriNet', {
      labels: ['a', 'b'],
      places: [{ id: 'p1', inputs: [1], outputs: [0] }, { id: 'p2', inputs: [0], outputs: [1] }],
      place_to_transition: [[0, 0], [1, 1]],
      transition_to_place: [[0, 1], [1, 0]],
      initial_marking: [], final_marking: [],
    }, 'Loop');
    assert.equal(doc.nodes.length, 4);
    for (const n of doc.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.name} has a position`);
    }
    assert.equal(new Set(doc.nodes.map((n) => `${n.x},${n.y}`)).size, 4, 'no two nodes share a spot');
  });

  test('an edited net keeps the ids it was published under', () => {
    // A miner's transition id is routinely not its activity, and things that
    // compare or replay nets correlate by id — so an edit that renamed every
    // transition would silently make the edited net a different net.
    const mined = {
      objectTypes: ['order'],
      places: [
        { id: 'p:order:src', objectType: 'order', kind: 'source' },
        { id: 'p:order:0', objectType: 'order', kind: 'sink' },
      ],
      transitions: [{ id: 't:Pick', activity: 'Pick', objectTypes: ['order'] }],
      arcs: [
        { id: 'a0', source: { kind: 'place', id: 'p:order:src' }, target: { kind: 'transition', id: 't:Pick' }, objectType: 'order', variable: false },
        { id: 'a1', source: { kind: 'transition', id: 't:Pick' }, target: { kind: 'place', id: 'p:order:0' }, objectType: 'order', variable: false },
      ],
      metadata: { perObjectType: {}, skippedObjectTypes: [], parameters: { variant: 'IM', noiseThreshold: 0, objectTypes: ['order'] } },
    };
    const { doc } = D.decompile('ObjectCentricPetriNet', mined, 'Mined');
    const back = M.compile(doc);
    assert.equal(validateOcpn(back), null);
    assert.deepEqual(back.transitions.map((t) => t.id), ['t:Pick'], 'the transition id survives');
    assert.deepEqual(back.places.map((p) => p.id).sort(), ['p:order:0', 'p:order:src']);
    assert.deepEqual(
      back.arcs.map((a) => `${a.source.id}->${a.target.id}`).sort(),
      ['p:order:src->t:Pick', 't:Pick->p:order:0'],
      'and the arcs still name it',
    );

    // Renaming the activity is a rename: the old id named the old thing.
    const renamed = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.kind === 'transition' ? { ...n, name: 'Pick item', publishedId: undefined } : n)),
    };
    assert.deepEqual(M.compile(renamed).transitions.map((t) => t.id), ['Pick item']);
  });

  test('a rename that collides with a kept id is caught before the host sees it', () => {
    const doc = {
      name: 'n', objectTypes: [],
      nodes: [
        { id: 'p0', kind: 'place', name: 'a', publishedId: 'a', objectType: null, marking: 'none', x: 0, y: 0 },
        { id: 'p1', kind: 'place', name: 'a', objectType: null, marking: 'none', x: 0, y: 0 },
      ],
      arcs: [],
    };
    assert.match(M.validateDoc(doc).map((p) => p.message).join(' '), /Two places would be published as “a”/);
  });

  test('a net the editor cannot open says so', () => {
    assert.throws(() => D.decompile('ProcessTree', {}, 'x'), /cannot open a ProcessTree/);
  });
})();

/* ------------------------------------------------------------------ *
 * PNML, against the real OCPN Studio file rather than a fixture I wrote.
 * ------------------------------------------------------------------ */
(async () => {
  const { execFileSync } = require('node:child_process');
  const esbuild2 = path.join(__dirname, '../node_modules/.bin/esbuild');
  // Bundle model.ts in: the external stub would need a .mjs extension the
  // source does not write, and the two are one unit anyway.
  execFileSync(esbuild2, [path.join(__dirname, '../src/pnml.ts'), '--bundle', '--format=esm',
    `--outfile=${path.join(OUT, 'pnml.mjs')}`], { stdio: 'pipe' });
  const P = await import(path.join(OUT, 'pnml.mjs'));
  const M = await import(path.join(OUT, 'model.mjs'));
  const { validateOcpn } = await import(path.join(OUT, 'ocpn.mjs'));

  // The plugin runs in a browser; give the test a DOMParser.
  const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
  if (!JSDOM) { console.log('ℹ jsdom not installed — PNML tests skipped'); return; }
  global.DOMParser = new JSDOM().window.DOMParser;

  const studio = path.join(process.env.HOME, 'Downloads/Airport_Ground_Handling.pnml');
  if (fs.existsSync(studio)) {
    test('reads an OCPN Studio export', () => {
      const { doc, notes } = P.fromPnml(fs.readFileSync(studio, 'utf8'));
      assert.ok(doc.nodes.filter((n) => n.kind === 'place').length >= 14, 'places imported');
      assert.ok(doc.nodes.filter((n) => n.kind === 'transition').length >= 12, 'transitions imported');
      assert.ok(doc.arcs.length >= 30, 'arcs imported');
      assert.ok(doc.objectTypes.some((t) => t.name === 'Aircraft'), 'colour sets adopted as object types');
      assert.ok(doc.nodes.some((n) => n.x !== 0 && n.y !== 0), 'positions preserved');
      assert.ok(notes.some((n) => /pages/.test(n)), 'the second page is reported, not silently dropped');
      assert.ok(notes.some((n) => /guard|subpage/i.test(n)), 'guards are reported');

      // A CPN types its *places*; the arcs carry expressions. Importing that
      // as dozens of untyped arcs would hand the author an unpublishable net
      // and a lot of clicking, so an arc takes the type of the place it
      // touches — the same rule the canvas applies when one is drawn.
      const typed = doc.arcs.filter((a) => a.objectType);
      assert.equal(typed.length, doc.arcs.length, 'every arc inherits its place’s object type');
      for (const arc of doc.arcs) {
        const place = doc.nodes.find((n) => n.kind === 'place' && (n.id === arc.source || n.id === arc.target));
        assert.equal(arc.objectType, place.objectType, `arc ${arc.id} agrees with its place`);
      }
    });
  }

  test('our own PNML round-trips', () => {
    const doc = {
      name: 'Round trip',
      objectTypes: [{ name: 'order', color: '#0072B2' }, { name: 'item', color: '#E69F00' }],
      nodes: [
        { id: 'p0', kind: 'place', name: 'start', objectType: 'order', marking: 'initial', x: 10, y: 20 },
        { id: 't0', kind: 'transition', name: 'pick', silent: false, x: 120, y: 20 },
        { id: 't1', kind: 'transition', name: '', silent: true, x: 220, y: 20 },
        { id: 'p2', kind: 'place', name: 'mid', objectType: 'item', marking: 'none', x: 430, y: 20 },
        { id: 'p1', kind: 'place', name: 'end', objectType: 'item', marking: 'final', x: 330, y: 20 },
      ],
      arcs: [
        { id: 'a0', source: 'p0', target: 't0', objectType: 'order', variable: false },
        { id: 'a1', source: 't0', target: 'p1', objectType: 'item', variable: true },
        { id: 'a2', source: 'p1', target: 't1', objectType: 'item', variable: false },
        { id: 'a3', source: 't1', target: 'p2', objectType: 'item', variable: false },
      ],
    };
    const back = P.fromPnml(P.toPnml(doc)).doc;
    assert.equal(back.name, doc.name);
    assert.deepEqual(back.objectTypes, doc.objectTypes);
    assert.deepEqual(
      back.nodes.map((n) => [n.id, n.kind, n.name, n.objectType ?? null, n.marking ?? null, n.silent ?? null, n.x, n.y]).sort(),
      doc.nodes.map((n) => [n.id, n.kind, n.name, n.objectType ?? null, n.marking ?? null, n.silent ?? null, n.x, n.y]).sort()
    );
    assert.deepEqual(back.arcs.sort((a, b) => a.id < b.id ? -1 : 1), doc.arcs);
    assert.equal(validateOcpn(M.compile(back)), null, 'and the round-tripped net still publishes');
  });
})();

(async () => {
  const M = await import(path.join(OUT, 'model.mjs'));
  const { validateOcpn } = await import(path.join(OUT, 'ocpn.mjs'));
  const T = (name, over = {}) => ({ id: name, kind: 'transition', name, silent: false, x: 0, y: 0, ...over });
  const P2 = (name, objectType, over = {}) => ({ id: name, kind: 'place', name, objectType, marking: 'none', x: 0, y: 0, ...over });
  const A = (id, s, t, objectType, variable = false) => ({ id, source: s, target: t, objectType, variable });

  test('the editor refuses what validateOcpn would refuse', () => {
    const types = [{ name: 'order', color: '#0072B2' }, { name: 'item', color: '#E69F00' }];

    const lonelyTau = { name: 'n', objectTypes: types, nodes: [T('t', { silent: true })], arcs: [] };
    assert.match(M.validateDoc(lonelyTau).map((p) => p.message).join(' '), /exactly one object type/);

    const sharedTau = {
      name: 'n', objectTypes: types,
      nodes: [P2('p0', 'order'), P2('p1', 'item'), T('t', { silent: true })],
      arcs: [A('a0', 'p0', 't', 'order'), A('a1', 't', 'p1', 'item')],
    };
    assert.match(M.validateDoc(sharedTau).map((p) => p.message).join(' '), /several object types/);

    const mismatch = {
      name: 'n', objectTypes: types,
      nodes: [P2('p0', 'order'), T('t')],
      arcs: [A('a0', 'p0', 't', 'item')],
    };
    assert.match(M.validateDoc(mismatch).map((p) => p.message).join(' '), /which holds/);
    // And the host agrees about the payload the editor would have sent.
    assert.notEqual(validateOcpn(M.compile(mismatch)), null);
  });

  test('a clean OCPN passes both', () => {
    const doc = {
      name: 'n',
      objectTypes: [{ name: 'order', color: '#0072B2' }],
      nodes: [P2('p0', 'order', { marking: 'initial' }), T('t'), P2('p1', 'order', { marking: 'final' }),
              T('tau', { silent: true }), P2('p2', 'order')],
      arcs: [A('a0', 'p0', 't', 'order'), A('a1', 't', 'p1', 'order'),
             A('a2', 'p1', 'tau', 'order'), A('a3', 'tau', 'p2', 'order', true)],
    };
    assert.deepEqual(M.validateDoc(doc), []);
    assert.equal(validateOcpn(M.compile(doc)), null);
  });
})();
