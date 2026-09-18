// Drives the built kernel through the host's ABI, in Node, exactly the way
// `wasm-plugin-worker.ts` does — and checks the result against the host's own
// `ProcessTree` contract rather than eyeballing it.
//
//   node tools/wasmcheck.mjs
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const glueUrl = pathToFileURL(new URL('../pkg/promenade_inductive_miner.js', import.meta.url).pathname);
const mod = await import(glueUrl.href);
await mod.default({ module_or_path: await readFile(new URL('../pkg/promenade_inductive_miner_bg.wasm', import.meta.url)) });

/** The check `validateProcessTree` performs at the host boundary. */
function validateProcessTree(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) return 'no nodes';
  if (typeof p.root !== 'number' || !p.nodes[p.root]) return 'root out of range';
  for (let i = 0; i < p.nodes.length; i++) {
    const n = p.nodes[i];
    if (!n || typeof n !== 'object') return `node ${i} is not an object`;
    if (!Array.isArray(n.children)) return `node ${i} has no children array`;
    for (const c of n.children) {
      if (typeof c !== 'number' || !p.nodes[c]) return `node ${i} references node ${c}`;
      if (c === i) return `node ${i} is its own child`;
    }
    if (n.operator == null && n.children.length > 0) return `leaf ${i} has children`;
  }
  const seen = new Set();
  const stack = [p.root];
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) return 'cycle in the tree';
    seen.add(i);
    stack.push(...p.nodes[i].children);
  }
  return null;
}

const SYM = { sequence: '→', xor: '×', parallel: '∧', loop: '↻' };
const fmt = (p, at = p.root) => {
  const n = p.nodes[at];
  if (n.operator == null) return n.label == null ? 'tau' : `'${n.label}'`;
  return `${SYM[n.operator]}( ${n.children.map((c) => fmt(p, c)).join(', ')} )`;
};

/** Runs a log through the full ABI, chunked, as the worker would. */
function mine(traces, params, chunkRows = 3) {
  const names = [];
  const id = (a) => {
    let i = names.indexOf(a);
    if (i < 0) { names.push(a); i = names.length - 1; }
    return i;
  };
  const cases = [], acts = [];
  traces.forEach((t, ti) => {
    // Mirrors the host: an empty case still gets one row, carrying -1.
    if (t.length === 0) { cases.push(ti); acts.push(-1); return; }
    t.forEach((a) => { cases.push(ti); acts.push(id(a)); });
  });

  const k = new mod.InductiveScan(names.length);
  k.setActivityNames(names);
  // Chunked on purpose: a case straddling a chunk boundary is the one thing
  // the streaming interface can quietly get wrong.
  for (let o = 0; o < cases.length; o += chunkRows) {
    k.pushChunk(Int32Array.from(cases.slice(o, o + chunkRows)),
                Int32Array.from(acts.slice(o, o + chunkRows)));
  }
  k.finish();
  const r = k.finalize(params);
  const meta = { rows: k.rowCount(), cases: k.caseCount() };
  k.free();
  return { r, meta };
}

const cases = [
  ['sequence', [['a', 'b', 'c'], ['a', 'b', 'c']], { variant: 'IM' }],
  ['parallel', [['a', 'b'], ['b', 'a']], { variant: 'IM' }],
  ['xor', [['a'], ['b']], { variant: 'IM' }],
  ['loop', [['a', 'b', 'a'], ['a']], { variant: 'IM' }],
  ['empty trace', [[], ['a']], { variant: 'IM' }],
  ['nested', [['a', 'b', 'e'], ['a', 'c', 'd', 'e'], ['a', 'd', 'c', 'e']], { variant: 'IM' }],
  ['IMf noise 0.2', [...Array(19).fill(['a', 'b', 'c']), ['a', 'x', 'b', 'c']],
    { variant: 'IMf', noiseThreshold: 0.2 }],
];

let failed = 0;
for (const [name, traces, params] of cases) {
  const { r, meta } = mine(traces, params);
  const err = validateProcessTree(r);
  if (err) { failed++; console.log(`FAIL  ${name}: ${err}`); continue; }
  console.log(`ok    ${name.padEnd(14)} ${fmt(r)}`);
  console.log(`      ${meta.cases} cases / ${meta.rows} events, ` +
              `${r.stats.nodes} nodes, variants ${r.stats.traceVariants}, ` +
              `recursion ${r.stats.recursionNodes}`);
}

// An empty log must still produce a legal artifact rather than a crash.
const { r: empty } = mine([], { variant: 'IMf', noiseThreshold: 0.2 });
const emptyErr = validateProcessTree(empty);
if (emptyErr) { failed++; console.log(`FAIL  empty log: ${emptyErr}`); }
else console.log(`ok    ${'empty log'.padEnd(14)} ${fmt(empty)}`);

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
