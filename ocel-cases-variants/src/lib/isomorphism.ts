/**
 * Object-centric variant equivalence (paper §V): two process executions are
 * the same variant iff their activity-labelled directly-follows graphs are
 * isomorphic — same node labels (activity + the per-type object count
 * touching that event), same edge labels (per-type object count shared by
 * both endpoints), same DAG shape, regardless of which concrete
 * events/objects realize it.
 *
 * Exact graph isomorphism has no known polynomial algorithm, so — exactly
 * as the paper does — this is a two-step technique: a Weisfeiler-Lehman-style
 * canonical hash first buckets executions that are *likely* equivalent, then
 * a small backtracking matcher verifies isomorphism within each bucket
 * (bucket sizes are typically tiny — the paper reports the same). A bucket
 * whose members are unexpectedly large skips verification and is trusted as
 * one variant outright, the same scalability concession the paper makes.
 */

export interface ExecEvent {
  id: string;
  activity: string;
  /** [objectType, count] pairs, sorted by type — objects of this execution touching the event. */
  typeCounts: Array<[string, number]>;
}

export interface ExecEdge {
  from: string;
  to: string;
  /** [objectType, count] pairs, sorted by type — objects of this execution touching *both* endpoints. */
  typeCounts: Array<[string, number]>;
}

export interface ExecutionGraph {
  events: ExecEvent[];
  edges: ExecEdge[];
}

function labelKey(tc: Array<[string, number]>): string {
  return tc.map(([t, n]) => `${t}:${n}`).join(',');
}

export function nodeLabel(e: ExecEvent): string {
  return `${e.activity}|${labelKey(e.typeCounts)}`;
}

/** Small, fast, deterministic 64-bit-ish string hash (cyrb-style). Only used
 * to keep WL colors from growing without bound between rounds — collisions
 * only cost an extra (harmless) isomorphism check inside a shared bucket. */
function hashString(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Weisfeiler-Lehman canonical hash of the whole graph: seeds each event's
 * color from its node label, then repeatedly folds in the labelled colors of
 * its in/out neighbours, stopping once the number of distinct colors stops
 * growing (bounded refinement — a graph's diameter is a natural cap). */
export function canonicalHash(g: ExecutionGraph): string {
  const outEdges = new Map<string, Array<{ to: string; label: string }>>();
  const inEdges = new Map<string, Array<{ from: string; label: string }>>();
  for (const e of g.edges) {
    const label = labelKey(e.typeCounts);
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push({ to: e.to, label });
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to)!.push({ from: e.from, label });
  }

  let colors = new Map<string, string>();
  for (const ev of g.events) colors.set(ev.id, nodeLabel(ev));

  const maxRounds = Math.min(g.events.length + 1, 16);
  for (let round = 0; round < maxRounds; round++) {
    const next = new Map<string, string>();
    for (const ev of g.events) {
      const outs = (outEdges.get(ev.id) ?? []).map((o) => `O:${o.label}>${colors.get(o.to)}`).sort();
      const ins = (inEdges.get(ev.id) ?? []).map((i) => `I:${i.label}>${colors.get(i.from)}`).sort();
      next.set(ev.id, hashString(`${colors.get(ev.id)}#${outs.join('|')}#${ins.join('|')}`));
    }
    const before = new Set(colors.values()).size;
    const after = new Set(next.values()).size;
    colors = next;
    if (after <= before && round > 0) break;
  }

  const multiset = g.events.map((ev) => colors.get(ev.id)!).sort();
  return hashString(`N${g.events.length}|E${g.edges.length}|${multiset.join(',')}`);
}

/**
 * A graph reduced to integers, ready for repeated isomorphism tests.
 *
 * The straightforward implementation this replaces re-derived everything on
 * every call and did its innermost work on strings: `consistent` looped over
 * the whole current mapping and, for each already-mapped pair, built four
 * template literals (`${aid}|${av.id}`) and did four `Map<string,string>`
 * lookups. With a bucket of 800-odd executions that is the difference
 * between a view that opens and one the browser offers to kill — on the
 * Logistics log the classification phase measured ~79s of it.
 *
 * Here a node is an index, a node label and an edge label are interned ints,
 * and adjacency is a dense `Int32Array` of edge-label ids (0 = no edge). A
 * consistency check is then two typed-array reads per mapped node, with no
 * allocation at all. Preparation happens once per graph rather than once per
 * comparison, which matters just as much: every execution in a bucket used
 * to be re-indexed against every representative it was tested against.
 *
 * `n x n` is fine because the caller only ever verifies small graphs
 * (`VERIFY_NODE_CAP`); a hypothetical huge graph would cost memory, so
 * `prepareGraph` refuses past `DENSE_NODE_CAP` and callers fall back.
 */
export interface PreparedGraph {
  n: number;
  edgeCount: number;
  /** Interned node-label id per node index. */
  labelOf: Int32Array;
  /** `adj[i * n + j]` = interned edge-label id for i->j, or 0 for no edge. */
  adj: Int32Array;
  /** Node indices grouped by label id, smallest group first. */
  groups: Map<number, number[]>;
}

/** Past this, the dense matrix is not worth it; nothing in this plugin hits
 * it, since verification is capped far lower (`VERIFY_NODE_CAP`). */
const DENSE_NODE_CAP = 400;

/**
 * Interning is module-global and monotonically growing, deliberately: ids
 * must agree *between* the two graphs being compared, so they cannot be
 * per-graph. Ids never escape this module and carry no meaning beyond
 * equality, so a run-to-run difference is unobservable. The table is bounded
 * by how many distinct labels a log actually has.
 */
const labelIds = new Map<string, number>();
function intern(label: string): number {
  let id = labelIds.get(label);
  // 0 is reserved for "no edge", so ids start at 1.
  if (id === undefined) { id = labelIds.size + 1; labelIds.set(label, id); }
  return id;
}

export function prepareGraph(g: ExecutionGraph): PreparedGraph | null {
  const n = g.events.length;
  if (n > DENSE_NODE_CAP) return null;
  const indexOf = new Map<string, number>();
  const labelOf = new Int32Array(n);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const ev = g.events[i];
    indexOf.set(ev.id, i);
    const id = intern(nodeLabel(ev));
    labelOf[i] = id;
    const group = groups.get(id);
    if (group) group.push(i); else groups.set(id, [i]);
  }
  const adj = new Int32Array(n * n);
  for (const e of g.edges) {
    const from = indexOf.get(e.from);
    const to = indexOf.get(e.to);
    if (from === undefined || to === undefined) continue;
    adj[from * n + to] = intern(labelKey(e.typeCounts));
  }
  return { n, edgeCount: g.edges.length, labelOf, adj, groups };
}

/**
 * Exact isomorphism over two prepared graphs.
 *
 * Same algorithm as before — backtracking, only same-label nodes ever tried
 * against each other, every edge among already-mapped nodes required to
 * match exactly in both directions including its label, smallest label
 * groups first so branching narrows fastest. Only the representation
 * changed.
 */
export function areIsomorphicPrepared(a: PreparedGraph, b: PreparedGraph): boolean {
  if (a.n !== b.n || a.edgeCount !== b.edgeCount) return false;
  if (a.groups.size !== b.groups.size) return false;
  for (const [label, group] of a.groups) {
    const other = b.groups.get(label);
    if (!other || other.length !== group.length) return false;
  }

  const n = a.n;
  const aAdj = a.adj;
  const bAdj = b.adj;
  // Smallest label groups first — narrows branching fastest.
  const order = new Int32Array(n);
  {
    const indices = Array.from({ length: n }, (_, i) => i);
    indices.sort((x, y) => a.groups.get(a.labelOf[x])!.length - a.groups.get(a.labelOf[y])!.length);
    for (let i = 0; i < n; i++) order[i] = indices[i];
  }

  // `mappedA[k]`/`mappedB[k]` are the k-th assignment, so `consistent` walks
  // a flat array instead of iterating a Map of string pairs.
  const mappedA = new Int32Array(n);
  const mappedB = new Int32Array(n);
  const usedB = new Uint8Array(n);
  let depth = 0;

  const consistent = (ai: number, bj: number): boolean => {
    for (let k = 0; k < depth; k++) {
      const ak = mappedA[k];
      const bk = mappedB[k];
      if (aAdj[ak * n + ai] !== bAdj[bk * n + bj]) return false;
      if (aAdj[ai * n + ak] !== bAdj[bj * n + bk]) return false;
    }
    return true;
  };

  const backtrack = (i: number): boolean => {
    if (i === n) return true;
    const ai = order[i];
    const candidates = b.groups.get(a.labelOf[ai]);
    if (!candidates) return false;
    for (const bj of candidates) {
      if (usedB[bj]) continue;
      if (!consistent(ai, bj)) continue;
      mappedA[depth] = ai;
      mappedB[depth] = bj;
      depth++;
      usedB[bj] = 1;
      if (backtrack(i + 1)) return true;
      depth--;
      usedB[bj] = 0;
    }
    return false;
  };

  return backtrack(0);
}

/** Convenience wrapper: prepares both graphs and compares them. Prefer
 * `prepareGraph` once per graph when comparing one against many. */
export function areIsomorphic(a: ExecutionGraph, b: ExecutionGraph): boolean {
  if (a.events.length !== b.events.length || a.edges.length !== b.edges.length) return false;
  const pa = prepareGraph(a);
  const pb = prepareGraph(b);
  if (!pa || !pb) return false;
  return areIsomorphicPrepared(pa, pb);
}

/** Above this many events in a hash bucket, skip exact pairwise verification
 * (worst-case backtracking cost grows too fast to be worth it here) and
 * trust the WL hash bucket as one variant outright — the same scalability
 * concession the paper itself makes for its own baseline comparison. */
export const VERIFY_NODE_CAP = 40;

export interface VariantGroup<T> {
  variantId: string;
  hash: string;
  executions: T[];
}

/** Buckets executions by canonical hash, then splits each bucket into true
 * isomorphism classes (or trusts the bucket, past the size cap). */
export function computeVariants<T extends { graph: ExecutionGraph }>(executions: T[]): VariantGroup<T>[] {
  const steps = variantSteps(executions);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Which half of the variant computation a `variantSteps` tick is in. */
export interface VariantProgress {
  phase: 'hash' | 'classify';
  done: number;
  total: number;
}

/**
 * The same bucketing and classification, one execution per `yield`.
 *
 * Both halves are linear in executions but far from free — on a 10k-execution
 * log the hashing is seconds and the classification more — and a sandboxed
 * view cannot move them to a Worker (the frame's CSP has no `worker-src`).
 * Yielding per execution lets a driver time-slice the work, report honest
 * progress and stop on request; `computeVariants` above drains it for every
 * caller that just wants the answer.
 *
 * The yielded object is reused between ticks rather than reallocated — a
 * driver must read it, not retain it.
 */
export function* variantSteps<T extends { graph: ExecutionGraph }>(
  executions: T[],
): Generator<VariantProgress, VariantGroup<T>[], void> {
  const progress: VariantProgress = { phase: 'hash', done: 0, total: executions.length };
  const buckets = new Map<string, T[]>();
  for (const ex of executions) {
    const h = canonicalHash(ex.graph);
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h)!.push(ex);
    progress.done++;
    yield progress;
  }

  progress.phase = 'classify';
  progress.done = 0;
  const groups: VariantGroup<T>[] = [];
  for (const [hash, bucket] of buckets) {
    if (bucket.length === 1 || bucket.some((ex) => ex.graph.events.length > VERIFY_NODE_CAP)) {
      groups.push({ variantId: `${hash}#0`, hash, executions: bucket });
      progress.done += bucket.length;
      yield progress;
      continue;
    }
    // One prepared form per graph, reused across every comparison it takes
    // part in — a bucket of 800 used to re-index both sides 800 times over.
    const classes: Array<{ rep: PreparedGraph | null; members: T[] }> = [];
    const unprepared: T[] = [];
    for (const ex of bucket) {
      const prepared = prepareGraph(ex.graph);
      if (!prepared) {
        unprepared.push(ex);
      } else {
        const cls = classes.find((c) => c.rep && areIsomorphicPrepared(c.rep, prepared));
        if (cls) cls.members.push(ex); else classes.push({ rep: prepared, members: [ex] });
      }
      progress.done++;
      yield progress;
    }
    // Too large to index densely: keep the pre-existing "trust the bucket"
    // concession rather than silently dropping them.
    if (unprepared.length) classes.push({ rep: null, members: unprepared });
    classes.forEach((cls, i) => groups.push({ variantId: `${hash}#${i}`, hash, executions: cls.members }));
  }
  return groups;
}

/** Standard DAG longest-path-from-sources layering (Kahn's algorithm with a
 * running max instead of a running count) — assigns each event a column so
 * that every edge points strictly rightward and independent/concurrent
 * branches share a column when nothing orders them. A deliberate
 * simplification of the paper's two-directional x_start/x_end recursion
 * (Algorithm 1): same left-to-right partial-order reading, far less code. */
export function layerColumns(g: ExecutionGraph): Map<string, number> {
  const indeg = new Map<string, number>();
  const outEdges = new Map<string, string[]>();
  for (const ev of g.events) indeg.set(ev.id, 0);
  for (const e of g.edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e.to);
  }

  const col = new Map<string, number>();
  const remaining = new Map(indeg);
  const queue: string[] = [];
  for (const ev of g.events) if ((indeg.get(ev.id) ?? 0) === 0) { col.set(ev.id, 0); queue.push(ev.id); }

  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const nxt of outEdges.get(cur) ?? []) {
      col.set(nxt, Math.max(col.get(nxt) ?? 0, (col.get(cur) ?? 0) + 1));
      const left = (remaining.get(nxt) ?? 0) - 1;
      remaining.set(nxt, left);
      if (left === 0) queue.push(nxt);
    }
  }
  // A cycle (only possible from same-timestamp ties across objects) leaves
  // some events unvisited by the Kahn pass above — place them at column 0
  // rather than looping forever.
  for (const ev of g.events) if (!col.has(ev.id)) col.set(ev.id, 0);
  return col;
}

/** A topological linearization of activities — used for the compact preview
 * chip. A process execution is a DAG, not a single sequence, so this reads
 * as "one consistent left-to-right order through the branching", not as
 * literally the only path. */
export function topoActivitySeq(g: ExecutionGraph): string[] {
  const col = layerColumns(g);
  return [...g.events].sort((a, b) => (col.get(a.id)! - col.get(b.id)!) || a.id.localeCompare(b.id)).map((e) => e.activity);
}
