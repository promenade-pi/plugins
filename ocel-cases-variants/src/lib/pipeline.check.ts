/**
 * Executable invariants for the extraction pipeline.
 *
 * Two things here are easy to break by accident and impossible to eyeball:
 *
 *  1. **The variant partition.** `areIsomorphicPrepared` replaced a
 *     string-keyed implementation for speed (~23x on Logistics). "Still
 *     passes" is not the bar — the grouping must be *identical*, so the old
 *     implementation is kept below, verbatim, and both are run on the same
 *     executions and compared as canonicalised partitions.
 *  2. **Responsiveness.** The whole point of `pipeline.ts` is that no single
 *     stretch of main-thread work is long enough for the browser to offer to
 *     kill the page. That is a property of the *driver*, so it is measured:
 *     the gap between consecutive progress callbacks is one uninterrupted
 *     stretch, and the longest one is asserted.
 *
 * Runs on a synthetic log by default so it works anywhere; pass OCEL 2.0 JSON
 * paths to check real ones too (that is how the Logistics numbers were got).
 *
 *   node check.js [log.json ...]
 */
import { readFileSync } from 'node:fs';
import { buildCompactGraph, leadingTypeExecutions, type Edge } from './objectGraph';
import { PHASE_LABEL } from './pipeline';
import {
  computeVariants, nodeLabel, VERIFY_NODE_CAP,
  type ExecEvent, type ExecutionGraph,
} from './isomorphism';
import {
  buildExecution, computeAllowedEventsByRoot, computeExecutions, summarizeVariants, type RawData,
} from './executions';
import { runPipeline } from './pipeline';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanceledNotice, LoadingChevrons } from './LoadingState';

const SEP = String.fromCharCode(0);

// ---- the implementation as it stood before the rewrite, verbatim ----------
function labelKeyLegacy(tc: Array<[string, number]>): string {
  return tc.map(([t, n]) => `${t}:${n}`).join(',');
}
function buildEdgeIndexLegacy(g: ExecutionGraph): Map<string, string> {
  const index = new Map<string, string>();
  for (const e of g.edges) index.set(`${e.from}|${e.to}`, labelKeyLegacy(e.typeCounts));
  return index;
}
function areIsomorphicLegacy(a: ExecutionGraph, b: ExecutionGraph): boolean {
  if (a.events.length !== b.events.length || a.edges.length !== b.edges.length) return false;
  const aByLabel = new Map<string, ExecEvent[]>();
  for (const ev of a.events) { const l = nodeLabel(ev); if (!aByLabel.has(l)) aByLabel.set(l, []); aByLabel.get(l)!.push(ev); }
  const bByLabel = new Map<string, ExecEvent[]>();
  for (const ev of b.events) { const l = nodeLabel(ev); if (!bByLabel.has(l)) bByLabel.set(l, []); bByLabel.get(l)!.push(ev); }
  if (aByLabel.size !== bByLabel.size) return false;
  for (const [label, group] of aByLabel) {
    const other = bByLabel.get(label);
    if (!other || other.length !== group.length) return false;
  }
  const aEdgeIndex = buildEdgeIndexLegacy(a);
  const bEdgeIndex = buildEdgeIndexLegacy(b);
  const order = [...a.events].sort((x, y) => aByLabel.get(nodeLabel(x))!.length - aByLabel.get(nodeLabel(y))!.length);
  const mapping = new Map<string, string>();
  const usedB = new Set<string>();
  function consistent(av: ExecEvent, bv: ExecEvent): boolean {
    for (const [aid, bid] of mapping) {
      if ((aEdgeIndex.get(`${aid}|${av.id}`) ?? null) !== (bEdgeIndex.get(`${bid}|${bv.id}`) ?? null)) return false;
      if ((aEdgeIndex.get(`${av.id}|${aid}`) ?? null) !== (bEdgeIndex.get(`${bv.id}|${bid}`) ?? null)) return false;
    }
    return true;
  }
  function backtrack(i: number): boolean {
    if (i === order.length) return true;
    const av = order[i];
    for (const bv of bByLabel.get(nodeLabel(av)) ?? []) {
      if (usedB.has(bv.id)) continue;
      if (!consistent(av, bv)) continue;
      mapping.set(av.id, bv.id);
      usedB.add(bv.id);
      if (backtrack(i + 1)) return true;
      mapping.delete(av.id);
      usedB.delete(bv.id);
    }
    return false;
  }
  return backtrack(0);
}

/** `computeVariants` as it stood before: re-index both graphs, every pair. */
function computeVariantsLegacy<T extends { graph: ExecutionGraph }>(executions: T[]) {
  const buckets = new Map<string, T[]>();
  for (const ex of executions) {
    // Reuse the current canonical hash: it is unchanged by the rewrite, and
    // this check is about the verification step, not the bucketing.
    const h = (require('./isomorphism') as any).canonicalHash(ex.graph);
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h)!.push(ex);
  }
  const groups: Array<{ variantId: string; executions: T[] }> = [];
  for (const [hash, bucket] of buckets) {
    if (bucket.length === 1 || bucket.some((ex) => ex.graph.events.length > VERIFY_NODE_CAP)) {
      groups.push({ variantId: `${hash}#0`, executions: bucket });
      continue;
    }
    const classes: T[][] = [];
    for (const ex of bucket) {
      const cls = classes.find((c) => areIsomorphicLegacy(c[0].graph, ex.graph));
      if (cls) cls.push(ex); else classes.push([ex]);
    }
    classes.forEach((cls, i) => groups.push({ variantId: `${hash}#${i}`, executions: cls }));
  }
  return groups;
}

function rawFromOcel(path: string): RawData {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const typeOf = new Map<string, string>();
  for (const o of doc.objects) typeOf.set(o.id, o.type);
  const eventById = new Map<string, { activity: string; ts: number }>();
  const eventsByObject = new Map<string, Array<{ event_id: string; ts: number }>>();
  const objectsByEvent = new Map<string, string[]>();
  const edgeSet = new Set<string>();
  for (const e of doc.events) {
    const ts = Date.parse(e.time);
    eventById.set(e.id, { activity: e.type, ts });
    const objs = [...new Set<string>((e.relationships ?? []).map((r: any) => r.objectId))];
    objectsByEvent.set(e.id, objs);
    for (const oid of objs) {
      if (!eventsByObject.has(oid)) eventsByObject.set(oid, []);
      eventsByObject.get(oid)!.push({ event_id: e.id, ts });
    }
    const sorted = [...objs].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) edgeSet.add(sorted[i] + SEP + sorted[j]);
    }
  }
  for (const list of eventsByObject.values()) list.sort((a, b) => a.ts - b.ts || a.event_id.localeCompare(b.event_id));
  const edges: Edge[] = [...edgeSet].map((k) => { const [a, b] = k.split(SEP); return { a, b }; });
  return { typeOf, eventById, eventsByObject, objectsByEvent, edges };
}


/**
 * A small object-centric log with deliberate structure: repeated shapes (so
 * buckets have several members and classification actually runs), a shared
 * hub object (so executions overlap), and some variety (so the partition is
 * not trivially one class).
 */
function syntheticRaw(orders: number): RawData {
  const typeOf = new Map<string, string>();
  const eventById = new Map<string, { activity: string; ts: number }>();
  const eventsByObject = new Map<string, Array<{ event_id: string; ts: number }>>();
  const objectsByEvent = new Map<string, string[]>();
  const edgeSet = new Set<string>();
  typeOf.set('hub', 'Employee');
  let clock = 0;
  const touch = (eventId: string, activity: string, objects: string[]) => {
    const ts = (clock += 60_000);
    eventById.set(eventId, { activity, ts });
    objectsByEvent.set(eventId, objects);
    for (const o of objects) {
      if (!eventsByObject.has(o)) eventsByObject.set(o, []);
      eventsByObject.get(o)!.push({ event_id: eventId, ts });
    }
    const sorted = [...objects].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) edgeSet.add(sorted[i] + SEP + sorted[j]);
    }
  };
  for (let i = 0; i < orders; i++) {
    const order = `o${i}`;
    typeOf.set(order, 'Order');
    const items = [`i${i}a`, `i${i}b`, ...(i % 3 === 0 ? [`i${i}c`] : [])];
    for (const it of items) typeOf.set(it, 'Item');
    touch(`e${i}_place`, 'Place Order', [order, ...items, 'hub']);
    for (const it of items) touch(`e${i}_${it}_pick`, 'Pick Item', [order, it]);
    if (i % 4 !== 0) touch(`e${i}_pay`, 'Pay', [order]);
    touch(`e${i}_ship`, 'Ship', [order, ...items]);
  }
  for (const list of eventsByObject.values()) list.sort((a, b) => a.ts - b.ts || a.event_id.localeCompare(b.event_id));
  const edges: Edge[] = [...edgeSet].map((k) => { const [a, b] = k.split(SEP); return { a, b }; });
  return { typeOf, eventById, eventsByObject, objectsByEvent, edges };
}

/** A partition, canonicalised so two groupings compare equal iff identical. */
function signature(groups: Array<{ executions: Array<{ caseId: string }> }>): string {
  return groups.map((g) => g.executions.map((e) => e.caseId).sort().join(',')).sort().join('\n');
}

function executionsFor(raw: RawData, leadingType: string) {
  const nodes = [...raw.typeOf.keys()].filter((o) => raw.eventsByObject.has(o));
  const graph = buildCompactGraph(nodes, raw.typeOf, raw.edges);
  const leadingObjects = nodes.filter((id) => raw.typeOf.get(id) === leadingType);
  if (!leadingObjects.length) return [];
  const objectSets = leadingTypeExecutions(leadingObjects, graph);
  const allowed = computeAllowedEventsByRoot(
    leadingObjects.map((root, i) => ({ root, objectIds: objectSets[i] })), raw,
  );
  return leadingObjects.map((root, i) => buildExecution(root, objectSets[i], raw, 300, allowed?.get(root) ?? null));
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

async function inspect(label: string, raw: RawData) {
  console.log('');
  console.log(label);
  const counts = new Map<string, number>();
  for (const ty of raw.typeOf.values()) counts.set(ty, (counts.get(ty) ?? 0) + 1);
  const byFreq = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // --- 1. the rewritten isomorphism must not change the partition ----------
  for (const [leadingType] of byFreq) {
    const executions = executionsFor(raw, leadingType);
    if (!executions.length) continue;
    const now = signature(computeVariants(executions));
    const before = signature(computeVariantsLegacy(executions));
    check(now === before, `${leadingType}: ${executions.length} executions -> ${now.split('\n').length} variants, partition unchanged`);
  }

  // --- 2. the sliced driver: same answer, no long block, cancel works ------
  const leadingType = byFreq[0][0];
  const args = { extraction: 'leadingType' as const, leadingType, raw, maxEvents: 300, scopeSharedObjects: true };
  const syncSummaries = summarizeVariants(computeExecutions('leadingType', leadingType, raw, 300, true));

  let lastAt = performance.now();
  let maxGap = 0;
  let slices = 0;
  let monotonic = true;
  let lastOverall = 0;
  const result = await runPipeline(args, {
    isCanceled: () => false,
    onProgress: (p) => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastAt);
      lastAt = now;
      slices++;
      if (p.overall < lastOverall - 1e-9) monotonic = false;
      lastOverall = p.overall;
    },
  });
  check(!!result && signature(result.variantSummaries) === signature(syncSummaries), 'sliced driver agrees with the synchronous path');
  check(monotonic, 'progress never goes backwards');
  // The gap between two progress callbacks is one uninterrupted stretch of
  // main-thread work; browsers start warning in the tens of seconds.
  check(maxGap < 250, `longest unbroken block ${maxGap.toFixed(0)}ms over ${slices} slices (< 250ms)`);

  let ticks = 0;
  const canceled = await runPipeline(args, { isCanceled: () => ticks > 5, onProgress: () => { ticks++; } });
  check(canceled === null, 'cancellation stops the run and yields no result');
}

/** The waiting states are the only thing a user sees during a long run, so
 * assert they actually say something rather than trusting they do. */
function checkWaitingStates() {
  console.log('');
  console.log('waiting states');

  const idle = renderToStaticMarkup(LoadingChevrons({ label: 'Extracting process executions' }) as never);
  check(idle.includes('Extracting process executions'), 'idle state names what it is doing');
  check(!idle.includes('oc-progress'), 'no progress bar before the first slice reports');
  check(!idle.includes('oc-cancel'), 'no Cancel offered when no run is cancellable');

  const running = renderToStaticMarkup(LoadingChevrons({
    label: 'ignored',
    progress: { phase: 'classify', fraction: 0.5, done: 5277, total: 10553, overall: 0.74 },
    onCancel: () => {},
  }) as never);
  check(running.includes(PHASE_LABEL.classify), 'running state names the current phase');
  check(running.includes('74%'), 'running state shows the overall percentage');
  check(running.includes('5,277') && running.includes('10,553'), 'running state shows the real item counts');
  check(running.includes('width:74%'), 'the bar width matches the reported progress');
  check(running.includes('oc-cancel'), 'Cancel is offered while a run is in flight');

  const canceled = renderToStaticMarkup(CanceledNotice({ onRetry: () => {} }) as never);
  check(canceled.toLowerCase().includes('canceled'), 'canceled state says so rather than showing an empty result');
  check(canceled.includes('oc-cancel'), 'canceled state offers a way to run it again');
}

async function main() {
  checkWaitingStates();
  await inspect('synthetic (600 orders)', syntheticRaw(600));
  for (const path of process.argv.slice(2)) {
    await inspect(path.split('/').pop() ?? path, rawFromOcel(path));
  }
  console.log('');
  if (failures.length) {
    console.error(`FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log('All pipeline checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
