/**
 * The pure computation behind the view: raw log tables in, process executions
 * and variant summaries out.
 *
 * Extracted from `plugin.tsx` so it can be run — and *timed* — outside a
 * browser, and so the chunked, cancellable drivers in `pipeline.ts` have
 * something to drive that is not entangled with React. Nothing here touches
 * the DOM, `promenade`, or any global: same functions, same results, just
 * reachable from a Node script and a test.
 */
import {
  computeVariants, type ExecEvent, type ExecutionGraph, type VariantGroup,
} from './isomorphism';
import { buildCompactGraph, connectedComponents, leadingTypeExecutionSteps, type Edge } from './objectGraph';

export interface RawData {
  typeOf: Map<string, string>;
  eventById: Map<string, { activity: string; ts: number }>;
  eventsByObject: Map<string, Array<{ event_id: string; ts: number }>>;
  /** Global reverse index (event -> every object touching it, log-wide) — used
   * only to score how "specific" a touching object is when scoping shared
   * objects to their closest execution (see scopeSharedObjects). */
  objectsByEvent: Map<string, string[]>;
  edges: Edge[];
}


export interface ExecutionDetail {
  caseId: string;
  objectIds: string[];
  graph: ExecutionGraph;
  touchingByEvent: Map<string, Set<string>>;
  startMs: number;
  endMs: number;
  eventCount: number;
  /** True when the execution's real event set is larger than `maxEvents` —
   * `graph`/`eventCount` reflect only the chronologically-first `maxEvents`
   * events, not the whole thing. See buildExecution's doc comment for why
   * this stays a real, comparable graph rather than being dropped. */
  truncated: boolean;
}

/** `promenade.setCachedState()`'s payload shape — see the extraction effect
 * in `App` for how `execSig` guards `executions` against a stale reuse. */

export function typeCountsOf(objIds: Iterable<string>, typeOf: Map<string, string>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const oid of objIds) {
    const t = typeOf.get(oid);
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Builds the labelled process-execution graph (Def. 4/7) for one object set:
 * E' = events touching any object in it, D = each object's own consecutive-
 * event pairs (the practical reading of con_L ∩ (E'×E') — see the plugin
 * README), node/edge labels from the type counts within this execution
 * specifically, not the whole log.
 *
 * On a real object graph that's one big, densely-connected component (a
 * shared employee/truck/warehouse hub links most of the log together — the
 * "highly entangled" case the paper itself calls out for its own DS2
 * dataset), E' for *every* execution can balloon toward the whole log, and
 * there's no Worker to offload that to (the sandboxed view's CSP blocks
 * them). `maxEvents` bounds the work, but naively stopping the very first
 * time any one object's history is walked (in whatever order objectIds
 * happens to list them) truncates arbitrarily — two structurally identical
 * large executions would almost certainly get cut at different, incomparable
 * points and never hash equal, making every large execution look like its
 * own unique "variant" even when it isn't.
 *
 * Instead: take each object's own chronologically-first `maxEvents` events
 * (its per-object list is already ts-sorted) — bounding the walk to
 * O(objects × maxEvents) regardless of how big any single hub object's full
 * history is — merge them, and keep only the execution-wide chronologically-
 * first `maxEvents`. This is provably the *exact* true answer, not an
 * approximation: any event among the execution's true global top `maxEvents`
 * earliest necessarily ranks within the first `maxEvents` of every object
 * that touches it too (a subset can't rank an element later than the whole
 * set does). Two executions that agree on their first `maxEvents` events
 * therefore truncate to the same graph and can still be compared —
 * truncated executions stay real, comparable variants instead of forced
 * singletons.
 */
export function buildExecution(
  caseId: string, objectIds: string[], data: RawData, maxEvents: number, allowedEvents: Set<string> | null,
): ExecutionDetail {
  return allowedEvents
    ? buildExecutionScoped(caseId, objectIds, data, maxEvents, allowedEvents)
    : buildExecutionUnscoped(caseId, objectIds, data, maxEvents);
}

function buildExecutionUnscoped(caseId: string, objectIds: string[], data: RawData, maxEvents: number): ExecutionDetail {
  const union = new Map<string, { ts: number; touching: Set<string> }>();
  const perObjectSlices: Array<Array<{ event_id: string; ts: number }>> = [];
  for (const oid of objectIds) {
    const evs = data.eventsByObject.get(oid) ?? [];
    const slice = evs.length > maxEvents ? evs.slice(0, maxEvents) : evs;
    perObjectSlices.push(slice);
    for (const ev of slice) {
      let entry = union.get(ev.event_id);
      if (!entry) { entry = { ts: ev.ts, touching: new Set() }; union.set(ev.event_id, entry); }
      entry.touching.add(oid);
    }
  }

  const sortedIds = [...union.keys()].sort((a, b) => union.get(a)!.ts - union.get(b)!.ts || a.localeCompare(b));
  const truncated = sortedIds.length > maxEvents;
  const keptIds = truncated ? sortedIds.slice(0, maxEvents) : sortedIds;
  const keptSet = new Set(keptIds);

  let startMs = Infinity;
  let endMs = -Infinity;
  const touchingByEvent = new Map<string, Set<string>>();
  const events: ExecEvent[] = keptIds.map((eid) => {
    const entry = union.get(eid)!;
    touchingByEvent.set(eid, entry.touching);
    if (entry.ts < startMs) startMs = entry.ts;
    if (entry.ts > endMs) endMs = entry.ts;
    return { id: eid, activity: data.eventById.get(eid)?.activity ?? '?', typeCounts: typeCountsOf(entry.touching, data.typeOf) };
  });

  const dfSet = new Set<string>();
  for (const slice of perObjectSlices) {
    let prev: string | null = null;
    for (const ev of slice) {
      if (!keptSet.has(ev.event_id)) { prev = null; continue; }
      if (prev) dfSet.add(`${prev}|${ev.event_id}`);
      prev = ev.event_id;
    }
  }
  const edges = [...dfSet].map((key) => {
    const [from, to] = key.split('|');
    const shared = [...union.get(from)!.touching].filter((o) => union.get(to)!.touching.has(o));
    return { from, to, typeCounts: typeCountsOf(shared, data.typeOf) };
  });

  return {
    caseId, objectIds, touchingByEvent, graph: { events, edges }, eventCount: keptIds.length, truncated,
    startMs: isFinite(startMs) ? startMs : 0, endMs: isFinite(endMs) ? endMs : 0,
  };
}

/**
 * The scoped path (scopeSharedObjects on): `allowedEvents` is already the
 * exact, correct candidate set (computeAllowedEventsByRoot guarantees every
 * member touches an object in `objectIds`), so this never walks a shared
 * object's full history the way the unscoped path has to — it only ever
 * looks at the (usually tiny) allowed set and each event's own touching-
 * object list, both independent of how large any hub object's real history
 * is. This is what actually fixes the runway/fuel-truck blow-up's cost, not
 * just its correctness.
 */
function buildExecutionScoped(
  caseId: string, objectIds: string[], data: RawData, maxEvents: number, allowedEvents: Set<string>,
): ExecutionDetail {
  const objectSet = new Set(objectIds);
  const candidates = [...allowedEvents]
    .map((eid) => ({ eid, ts: data.eventById.get(eid)?.ts ?? 0 }))
    .sort((a, b) => a.ts - b.ts || a.eid.localeCompare(b.eid));
  const truncated = candidates.length > maxEvents;
  const kept = truncated ? candidates.slice(0, maxEvents) : candidates;

  let startMs = Infinity;
  let endMs = -Infinity;
  const touchingByEvent = new Map<string, Set<string>>();
  const events: ExecEvent[] = kept.map(({ eid, ts }) => {
    const touching = new Set((data.objectsByEvent.get(eid) ?? []).filter((o) => objectSet.has(o)));
    touchingByEvent.set(eid, touching);
    if (ts < startMs) startMs = ts;
    if (ts > endMs) endMs = ts;
    return { id: eid, activity: data.eventById.get(eid)?.activity ?? '?', typeCounts: typeCountsOf(touching, data.typeOf) };
  });

  const perObjectKept = new Map<string, string[]>();
  for (const { eid } of kept) {
    for (const oid of touchingByEvent.get(eid)!) {
      if (!perObjectKept.has(oid)) perObjectKept.set(oid, []);
      perObjectKept.get(oid)!.push(eid);
    }
  }
  const dfSet = new Set<string>();
  for (const list of perObjectKept.values()) {
    for (let i = 1; i < list.length; i++) dfSet.add(`${list[i - 1]}|${list[i]}`);
  }
  const edges = [...dfSet].map((key) => {
    const [from, to] = key.split('|');
    const shared = [...touchingByEvent.get(from)!].filter((o) => touchingByEvent.get(to)!.has(o));
    return { from, to, typeCounts: typeCountsOf(shared, data.typeOf) };
  });

  return {
    caseId, objectIds, touchingByEvent, graph: { events, edges }, eventCount: kept.length, truncated,
    startMs: isFinite(startMs) ? startMs : 0, endMs: isFinite(endMs) ? endMs : 0,
  };
}

/**
 * Scopes shared ("hub") objects to their closest execution instead of
 * pulling in their whole history everywhere they're reachable — an explicit,
 * documented deviation from Def. 4 (see README's "Scoping shared objects"
 * section). On by default: the strict Def. 4 reading is close to unusable
 * on a log where a handful of resources (a runway, a fuel truck) are reused
 * across most cases, so defaulting to "technically exact but unusable" would
 * serve paper-fidelity over the tool actually being worth opening.
 *
 * For every event, find its touching object with the SMALLEST membership
 * count (how many executions include that object) — the least-shared, most
 * case-specific anchor — and assign the event only to the execution(s) that
 * include that anchor (ties keep every execution that shares the minimum,
 * consistent with how leadingTypeExecutions already treats per-type distance
 * ties). Raw graph distance can't do this job: a hub object sits at distance
 * 1 from every event it touches too, so a closest-by-distance tie-break
 * would just re-include its whole reach. Membership count sidesteps that —
 * the runway is shared by hundreds of executions, but the specific flight
 * touching the same event usually belongs to exactly one.
 *
 * Only meaningful for leading-type extraction (it needs multiple same-type
 * roots to partition an object's events across). Connected components has no
 * roots to be "closer" to — one component is definitionally one execution.
 */
export function computeAllowedEventsByRoot(
  objectSetsByRoot: Array<{ root: string; objectIds: string[] }>, data: RawData,
): Map<string, Set<string>> {
  const membersOf = new Map<string, Set<string>>();
  for (const { root, objectIds } of objectSetsByRoot) {
    for (const oid of objectIds) {
      if (!membersOf.has(oid)) membersOf.set(oid, new Set());
      membersOf.get(oid)!.add(root);
    }
  }

  const allowedByRoot = new Map<string, Set<string>>();
  for (const { root } of objectSetsByRoot) allowedByRoot.set(root, new Set());

  for (const [eventId, touching] of data.objectsByEvent) {
    let minCount = Infinity;
    for (const oid of touching) {
      const m = membersOf.get(oid);
      if (m && m.size < minCount) minCount = m.size;
    }
    if (!isFinite(minCount)) continue;
    for (const oid of touching) {
      const m = membersOf.get(oid);
      if (m && m.size === minCount) {
        for (const root of m) allowedByRoot.get(root)!.add(eventId);
      }
    }
  }
  return allowedByRoot;
}

export function computeExecutions(
  extraction: 'leadingType' | 'connectedComponents', leadingType: string, data: RawData,
  maxEvents: number, scopeSharedObjects: boolean,
): ExecutionDetail[] {
  const steps = executionSteps(extraction, leadingType, data, maxEvents, scopeSharedObjects);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Which part of the extraction an `executionSteps` tick is in. */
export interface ExecutionProgress {
  phase: 'graph' | 'extract' | 'scope' | 'build';
  done: number;
  total: number;
}

/**
 * The same extraction, yielding as it goes.
 *
 * `graph` and `scope` are single indivisible steps (both are fast — tens of
 * milliseconds even on a large log); `extract` and `build` are per-root and
 * are where the seconds actually go, so they yield per item. As in
 * `variantSteps`, the progress object is reused between ticks: read it, do
 * not retain it.
 */
export function* executionSteps(
  extraction: 'leadingType' | 'connectedComponents', leadingType: string, data: RawData,
  maxEvents: number, scopeSharedObjects: boolean,
): Generator<ExecutionProgress, ExecutionDetail[], void> {
  const progress: ExecutionProgress = { phase: 'graph', done: 0, total: 1 };
  const nodes = [...data.typeOf.keys()].filter((oid) => data.eventsByObject.has(oid));
  const graph = buildCompactGraph(nodes, data.typeOf, data.edges);
  progress.done = 1;
  yield progress;

  if (extraction === 'connectedComponents') {
    const components = connectedComponents(graph);
    progress.phase = 'build';
    progress.done = 0;
    progress.total = components.length;
    const out: ExecutionDetail[] = [];
    for (const objIds of components) {
      out.push(buildExecution([...objIds].sort()[0], objIds, data, maxEvents, null));
      progress.done++;
      yield progress;
    }
    return out;
  }

  const leadingObjects = nodes.filter((id) => data.typeOf.get(id) === leadingType);

  progress.phase = 'extract';
  progress.done = 0;
  progress.total = leadingObjects.length;
  const extraction$ = leadingTypeExecutionSteps(leadingObjects, graph);
  let step = extraction$.next();
  while (!step.done) {
    progress.done = step.value;
    yield progress;
    step = extraction$.next();
  }
  const objectSets = step.value;

  progress.phase = 'scope';
  progress.done = 0;
  progress.total = 1;
  const allowedByRoot = scopeSharedObjects
    ? computeAllowedEventsByRoot(leadingObjects.map((root, i) => ({ root, objectIds: objectSets[i] })), data)
    : null;
  progress.done = 1;
  yield progress;

  progress.phase = 'build';
  progress.done = 0;
  progress.total = leadingObjects.length;
  const executions: ExecutionDetail[] = new Array(leadingObjects.length);
  for (let i = 0; i < leadingObjects.length; i++) {
    const root = leadingObjects[i];
    executions[i] = buildExecution(root, objectSets[i], data, maxEvents, allowedByRoot?.get(root) ?? null);
    progress.done = i + 1;
    yield progress;
  }
  return executions;
}

// ---------------------------------------------------------------------------
// Variant summaries
// ---------------------------------------------------------------------------
export interface VariantSummary {
  variantId: string;
  executions: ExecutionDetail[];
  execCount: number;
  avgEvents: number;
  avgObjects: number;
  avgDurationMs: number;
  representative: ExecutionDetail;
}

export function toSummary(variantId: string, executions: ExecutionDetail[]): VariantSummary {
  return {
    variantId,
    executions,
    execCount: executions.length,
    avgEvents: executions.reduce((s, e) => s + e.eventCount, 0) / executions.length,
    avgObjects: executions.reduce((s, e) => s + e.objectIds.length, 0) / executions.length,
    avgDurationMs: executions.reduce((s, e) => s + (e.endMs - e.startMs), 0) / executions.length,
    representative: executions[0],
  };
}

/** Truncated executions (see buildExecution) still carry a real, deterministic
 * graph — the chronologically-first `maxEvents` events — so they go through
 * the same isomorphism pipeline as everything else: two large executions
 * that agree on their early behavior still group into one variant. */
export function summarizeVariants(
  executions: ExecutionDetail[],
  /** Already-computed groups. The sliced driver in `pipeline.ts` has them
   * by the time it gets here, and recomputing would double the most
   * expensive stage of the whole view. */
  groups: VariantGroup<ExecutionDetail>[] = computeVariants(executions),
): VariantSummary[] {
  return groups.map((g) => toSummary(g.variantId, g.executions)).sort((a, b) => b.execCount - a.execCount);
}
