// Drives the built kernels through the host's ABI, in Node, exactly the way
// `wasm-plugin-worker.ts` does — and checks the result's structure rather
// than eyeballing it. Mirrors `inductive-miner-rs/tools/wasmcheck.mjs`.
//
//   node tools/wasmcheck.mjs
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const glueUrl = pathToFileURL(new URL('../pkg/promenade_lpm.js', import.meta.url).pathname);
const mod = await import(glueUrl.href);
await mod.default({ module_or_path: await readFile(new URL('../pkg/promenade_lpm_bg.wasm', import.meta.url)) });

const DEFAULT_PARAMS = {
  numTransitions: 3, topK: 10, frequencyMinimum: 1,
  determinismMinimum: 0, languageFitMinimum: 0, confidenceMinimum: 0, coverageMinimum: 0,
  duplicateTransitions: false,
  useSeq: true, useXor: true, useAnd: true, useOr: false, useXorLoop: true,
  supportWeight: 0.1, confidenceWeight: 0.4, determinismWeight: 0.3, coverageWeight: 0,
  languageFitWeight: 0.1, avgNumFiringsWeight: 0.1, numTransitionsWeight: 0,
  maxSearchMillis: 5000, maxAlignStates: 20000, maxLoop: 3,
};

function validateResultSet(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!Array.isArray(r.entries)) return 'no entries array';
  for (const [i, e] of r.entries.entries()) {
    if (typeof e.rank !== 'number') return `entry ${i}: no rank`;
    if (!e.tree || typeof e.tree.op !== 'string') return `entry ${i}: no tree.op`;
    if (typeof e.pretty !== 'string') return `entry ${i}: no pretty`;
    if (!Array.isArray(e.activities) || e.activities.length === 0) return `entry ${i}: no activities`;
    const s = e.scores;
    for (const key of ['support', 'confidence', 'determinism', 'languageFit', 'coverage', 'weightedScore']) {
      if (typeof s[key] !== 'number' || Number.isNaN(s[key])) return `entry ${i}: scores.${key} is not a finite number`;
      if (s[key] < -1e-9 || s[key] > 1 + 1e-9) return `entry ${i}: scores.${key}=${s[key]} out of [0,1]`;
    }
  }
  if (!r.stats || typeof r.stats.totalCases !== 'number') return 'no stats.totalCases';
  return null;
}

function validateNet(n) {
  if (!n || typeof n !== 'object') return 'not an object';
  // Field names are snake_case — the contract `plugins/petrinet-layered`
  // actually reads (`AcceptingPetriNetPayload` in its `types.ts`), not this
  // crate's own camelCase convention. Caught a real bug once already.
  if (!Array.isArray(n.activities) || n.activities.length === 0) return 'no activities';
  if (!Array.isArray(n.labels) || n.labels.length === 0) return 'no labels';
  if (!Array.isArray(n.places) || n.places.length < 2) return 'fewer than 2 places';
  if (!Array.isArray(n.initial_marking) || n.initial_marking.length !== 1) return 'initial_marking must be exactly one place';
  if (!Array.isArray(n.final_marking) || n.final_marking.length !== 1) return 'final_marking must be exactly one place';
  const placeIds = new Set(n.places.map((p) => p.id));
  if (placeIds.size !== n.places.length) return 'duplicate place ids';
  for (const [place, transition] of n.place_to_transition) {
    if (place >= n.places.length) return `place_to_transition references unknown place ${place}`;
    if (transition >= n.labels.length) return `place_to_transition references unknown transition ${transition}`;
  }
  return null;
}

/** Runs a log through the full ABI, chunked, as the worker would. */
function discover(traces, params, chunkRows = 3) {
  const names = [];
  const id = (a) => {
    let i = names.indexOf(a);
    if (i < 0) { names.push(a); i = names.length - 1; }
    return i;
  };
  const cases = [], acts = [];
  traces.forEach((t, ti) => { t.forEach((a) => { cases.push(ti); acts.push(id(a)); }); });

  const k = new mod.LpmScan(names.length);
  k.setActivityNames(names);
  for (let o = 0; o < cases.length; o += chunkRows) {
    k.pushChunk(Int32Array.from(cases.slice(o, o + chunkRows)), Int32Array.from(acts.slice(o, o + chunkRows)));
  }
  k.finish();
  const r = k.finalize(params);
  const meta = { rows: k.rowCount(), cases: k.caseCount() };
  return { k, r, meta, names };
}

let failed = 0;

// 1. A clean sequential pattern (a then b) ranks Seq at the top.
{
  const traces = Array.from({ length: 6 }, () => ['a', 'b']);
  const { k, r } = discover(traces, DEFAULT_PARAMS);
  const err = validateResultSet(r);
  if (err) { failed++; console.log(`FAIL  sequence: ${err}`); }
  else if (!r.entries.length || r.entries[0].tree.op !== 'seq') {
    failed++; console.log(`FAIL  sequence: expected top entry to be seq, got ${r.entries[0]?.tree.op}`);
  } else {
    console.log(`ok    sequence      top: ${r.entries[0].pretty}  weightedScore=${r.entries[0].scores.weightedScore.toFixed(3)}`);
  }
  k.free();
}

// 2. Re-weighting (weights-only param change) must not re-run the search —
// the ranked order should respond to a weight flip without needing a new
// candidate to appear from nowhere.
{
  const traces = [['a'], ['b'], ['a'], ['b'], ['a'], ['b']]; // clean exclusive choice
  const { k } = discover(traces, DEFAULT_PARAMS);
  const first = k.finalize({ ...DEFAULT_PARAMS, supportWeight: 1, confidenceWeight: 0, determinismWeight: 0, languageFitWeight: 0, avgNumFiringsWeight: 0 });
  const second = k.finalize({ ...DEFAULT_PARAMS, supportWeight: 0, confidenceWeight: 1, determinismWeight: 0, languageFitWeight: 0, avgNumFiringsWeight: 0 });
  const errA = validateResultSet(first), errB = validateResultSet(second);
  if (errA || errB) { failed++; console.log(`FAIL  reweight: ${errA || errB}`); }
  else if (first.stats.candidatesScored !== second.stats.candidatesScored) {
    failed++; console.log('FAIL  reweight: candidatesScored changed on a weights-only param change — the cache was not reused');
  } else {
    console.log(`ok    reweight      candidatesScored stayed at ${first.stats.candidatesScored} across a weights-only change`);
  }
  k.free();
}

// 3. Empty log must still produce a legal (empty) result, not a crash.
{
  const { k, r } = discover([], DEFAULT_PARAMS);
  const err = validateResultSet(r);
  if (err) { failed++; console.log(`FAIL  empty log: ${err}`); }
  else console.log(`ok    empty log     ${r.entries.length} entries`);
  k.free();
}

// 4. `LpmToNet`: convert the top entry of the sequence case back into an
// AcceptingPetriNet-shaped net and check its structure.
{
  const traces = Array.from({ length: 6 }, () => ['a', 'b']);
  const { k, r } = discover(traces, DEFAULT_PARAMS);
  const setValue = { entries: r.entries };
  const conv = new mod.LpmToNet();
  const net = conv.finalize({ inputValue: setValue, index: 0 });
  const err = validateNet(net);
  if (err) { failed++; console.log(`FAIL  to-net: ${err}`); }
  else console.log(`ok    to-net        ${net.labels.length} transitions, ${net.places.length} places, ${net.stats.silentTransitions} silent`);
  conv.free();
  k.free();
}

// 5. `LpmToOcpn`: a merged, multi-type entry converts to a valid OCPN.
{
  const traces = Array.from({ length: 6 }, () => ['a', 'b']);
  const { k, r } = discover(traces, DEFAULT_PARAMS);
  const mergedEntry = {
    ...r.entries[0],
    objectTypes: ['Order', 'Item'],
    variableArcs: [{ activity: 'a', objectType: 'Item' }],
  };
  const conv = new mod.LpmToOcpn();
  const net = conv.finalize({ inputValue: { entries: [mergedEntry] }, index: 0 });
  if (!net || !Array.isArray(net.objectTypes) || net.objectTypes.length !== 2) {
    failed++; console.log('FAIL  to-ocpn: expected 2 object types');
  } else if (!Array.isArray(net.places) || net.places.length !== 6) { // 3 places * 2 types
    failed++; console.log(`FAIL  to-ocpn: expected 6 places, got ${net.places?.length}`);
  } else if (!net.arcs.some((a) => a.variable)) {
    failed++; console.log('FAIL  to-ocpn: expected at least one variable arc');
  } else {
    console.log(`ok    to-ocpn       ${net.places.length} places, ${net.transitions.length} transitions, ${net.arcs.filter((a) => a.variable).length} variable arc(s)`);
  }
  conv.free();
  k.free();
}

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
