/**
 * The object graph (paper Def. 3): objects are nodes, connected whenever
 * they co-occur in at least one event. Note this is *not* the {o2o} relation
 * — {o2o} is a separate, explicitly-declared object-to-object link that the
 * paper's case notion does not use.
 *
 * A real log's object graph is often one large, densely connected component
 * (a handful of "hub" objects — an employee, a warehouse — sit on thousands
 * of events and transitively link most other objects together). Leading-type
 * extraction (Def. 6) needs a full shortest-path BFS from *every* object of
 * the chosen type, so this is stored as a flat typed-array CSR adjacency
 * list rather than Map<string, Set<string>>: thousands of BFS calls over a
 * many-thousand-node graph is exactly the case where per-call Map/Set
 * allocation and string hashing dominate the runtime (this is the client's
 * only thread — a sandboxed view has no Worker available), while
 * integer-indexed typed arrays with incremental reset keep each call to
 * O(visited nodes).
 */
export interface Edge { a: string; b: string; }

export interface CompactGraph {
  ids: string[];
  indexOf: Map<string, number>;
  typeIndex: Int32Array;
  typeNames: string[];
  adjStart: Int32Array;
  adjList: Int32Array;
}

export function buildCompactGraph(objectIds: string[], typeOf: Map<string, string>, edges: Edge[]): CompactGraph {
  const n = objectIds.length;
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(objectIds[i], i);

  const typeNames: string[] = [];
  const typeIndexOf = new Map<string, number>();
  const typeIndex = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = typeOf.get(objectIds[i]) ?? '?';
    let ti = typeIndexOf.get(t);
    if (ti === undefined) { ti = typeNames.length; typeNames.push(t); typeIndexOf.set(t, ti); }
    typeIndex[i] = ti;
  }

  const ea: number[] = [];
  const eb: number[] = [];
  const degree = new Int32Array(n);
  for (const e of edges) {
    const a = indexOf.get(e.a);
    const b = indexOf.get(e.b);
    if (a === undefined || b === undefined || a === b) continue;
    ea.push(a); eb.push(b);
    degree[a]++; degree[b]++;
  }

  const adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const adjList = new Int32Array(adjStart[n]);
  const cursor = adjStart.slice(0, n);
  for (let i = 0; i < ea.length; i++) {
    const a = ea[i], b = eb[i];
    adjList[cursor[a]++] = b;
    adjList[cursor[b]++] = a;
  }

  return { ids: objectIds, indexOf, typeIndex, typeNames, adjStart, adjList };
}

/** Connected components (paper Def. 5) via union-find over the compact
 * index space — every component's object set is one process execution.
 * Parameter-free, but a highly entangled log can collapse into one giant
 * component. */
export function connectedComponents(g: CompactGraph): string[][] {
  const n = g.ids.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (parent[cur] !== root) { const next = parent[cur]; parent[cur] = root; cur = next; }
    return root;
  };
  for (let a = 0; a < n; a++) {
    const start = g.adjStart[a], end = g.adjStart[a + 1];
    for (let k = start; k < end; k++) {
      const b = g.adjList[k];
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(g.ids[i]);
  }
  return [...groups.values()];
}

/**
 * Leading-type extraction (paper Def. 6): for every object of the chosen
 * type, a process execution is grown by a breadth-first search over the
 * object graph, keeping — for every other type — only the object(s) at the
 * shortest graph distance from the root. The root itself sits at distance 0
 * for its own type, so it always wins over any other object of that type; a
 * rooted execution therefore never absorbs a second leading-type object.
 *
 * Scratch buffers (`dist`, `queue`, `minDistByType`) are allocated once and
 * reused across every root, resetting only the nodes a given BFS actually
 * touched — the dominant cost across thousands of roots.
 */
export function leadingTypeExecutions(rootIds: string[], g: CompactGraph): string[][] {
  const steps = leadingTypeExecutionSteps(rootIds, g);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/**
 * The same extraction, one root per `yield`.
 *
 * The loop below is the single most expensive thing this view does before it
 * can show anything (seconds, on a log with thousands of leading objects),
 * and a sandboxed view has no Worker to put it in — the frame's CSP is
 * `default-src 'none'` with no `worker-src`, so `new Worker` is blocked
 * outright. Handing control back per root is therefore the only way to keep
 * the tab responsive, report progress and be interruptible. The synchronous
 * wrapper above drains it, so nothing that just wants the answer changes.
 */
export function* leadingTypeExecutionSteps(rootIds: string[], g: CompactGraph): Generator<number, string[][], void> {
  const n = g.ids.length;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const minDistByType = new Int32Array(g.typeNames.length);
  const touched: number[] = [];
  const results: string[][] = new Array(rootIds.length);

  for (let r = 0; r < rootIds.length; r++) {
    const root = g.indexOf.get(rootIds[r]);
    if (root === undefined) { results[r] = [rootIds[r]]; continue; }

    touched.length = 0;
    minDistByType.fill(0x7fffffff);
    let qHead = 0, qTail = 0;
    dist[root] = 0;
    touched.push(root);
    queue[qTail++] = root;
    while (qHead < qTail) {
      const cur = queue[qHead++];
      const d = dist[cur];
      const start = g.adjStart[cur], end = g.adjStart[cur + 1];
      for (let k = start; k < end; k++) {
        const nb = g.adjList[k];
        if (dist[nb] === -1) {
          dist[nb] = d + 1;
          touched.push(nb);
          queue[qTail++] = nb;
        }
      }
    }

    for (const node of touched) {
      const t = g.typeIndex[node];
      if (dist[node] < minDistByType[t]) minDistByType[t] = dist[node];
    }
    const objectSet: string[] = [];
    for (const node of touched) {
      if (dist[node] === minDistByType[g.typeIndex[node]]) objectSet.push(g.ids[node]);
    }
    results[r] = objectSet;

    for (const node of touched) dist[node] = -1;
    yield r + 1;
  }

  return results;
}
