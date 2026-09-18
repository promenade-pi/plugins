// WASM-side numbers for the report: module size, init cost, and the split
// between the cached scan and the parameter-dependent discovery.
//
//   node tools/wasmbench.mjs
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const wasmPath = new URL('../pkg/promenade_inductive_miner_bg.wasm', import.meta.url);
const gluePath = new URL('../pkg/promenade_inductive_miner.js', import.meta.url);

const wasmBytes = await readFile(wasmPath);
const glueBytes = await readFile(gluePath);
console.log(`wasm      ${(wasmBytes.length / 1024).toFixed(1)} KB raw, ` +
            `${(gzipSync(wasmBytes).length / 1024).toFixed(1)} KB gzip`);
console.log(`glue      ${(glueBytes.length / 1024).toFixed(1)} KB raw, ` +
            `${(gzipSync(glueBytes).length / 1024).toFixed(1)} KB gzip`);

const t0 = performance.now();
const mod = await import(pathToFileURL(gluePath.pathname).href);
await mod.default({ module_or_path: wasmBytes });
console.log(`init      ${(performance.now() - t0).toFixed(1)} ms (compile + instantiate)\n`);

function makeLog(nTraces, nActs, len, variantSeed) {
  let s = variantSeed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cases = [], acts = [];
  for (let t = 0; t < nTraces; t++) {
    const k = 3 + Math.floor(rnd() * len);
    for (let i = 0; i < k; i++) { cases.push(t); acts.push(Math.floor(rnd() * nActs)); }
  }
  return { cases: Int32Array.from(cases), acts: Int32Array.from(acts) };
}

function sequential(nTraces, nActs) {
  const cases = [], acts = [];
  for (let t = 0; t < nTraces; t++) {
    for (let i = 0; i < nActs; i++) { cases.push(t); acts.push(i); }
  }
  return { cases: Int32Array.from(cases), acts: Int32Array.from(acts) };
}

const shapes = [
  ['many traces, few variants', sequential(200_000, 8), 8],
  ['many variants', makeLog(20_000, 8, 10, 7), 8],
  ['many activities (200)', makeLog(20_000, 200, 15, 11), 200],
  ['deep recursion (60)', sequential(5_000, 60), 60],
];

console.log(`${'shape'.padEnd(28)}${'events'.padStart(11)}${'scan'.padStart(10)}${'discover'.padStart(11)}`);
console.log('-'.repeat(60));

for (const [name, data, nActs] of shapes) {
  const names = Array.from({ length: nActs }, (_, i) => `a${i}`);

  const t1 = performance.now();
  const k = new mod.InductiveScan(nActs);
  k.setActivityNames(names);
  // Chunked exactly as the host chunks it, so the measurement includes the
  // per-chunk boundary cost rather than pretending the log arrives at once.
  const CHUNK = 250_000;
  for (let o = 0; o < data.cases.length; o += CHUNK) {
    k.pushChunk(data.cases.slice(o, o + CHUNK), data.acts.slice(o, o + CHUNK));
  }
  k.finish();
  const scanMs = performance.now() - t1;

  const t2 = performance.now();
  const r = k.finalize({ variant: 'IMf', noiseThreshold: 0.2 });
  const discoverMs = performance.now() - t2;
  k.free();

  console.log(`${name.padEnd(28)}${data.cases.length.toLocaleString().padStart(11)}` +
              `${scanMs.toFixed(0).padStart(8)}ms${discoverMs.toFixed(0).padStart(9)}ms` +
              `   ${r.stats.nodes} nodes, ${r.stats.traceVariants} variants`);
}
