/**
 * The inverse of `model.ts`'s compilers: a published net back into a document
 * the canvas can edit.
 *
 * Two things are genuinely lost on the way out and have to be reconstructed
 * here rather than recovered.
 *
 * *Identity.* Both compilers publish a node's **name** as its id, because that
 * is what every downstream viewer shows. Names are not unique in general, so
 * reading one back mints fresh internal ids and keeps the published id as the
 * name — which also keeps a place called `start` from colliding with a
 * transition called `start`, since the payload puts them in one namespace only
 * for `AcceptingPetriNet` and in two for an OCPN.
 *
 * *Layout.* A published net carries no coordinates, on purpose: position is
 * view state, and every viewer lays a net out its own way. So an imported net
 * is ranked and laid out here. It will not match what the author of a
 * hand-drawn net saw — nothing in the artifact could make it — and the panel's
 * own cached state is what keeps a layout across a close and reopen.
 */
import {
  OBJECT_TYPE_COLORS, emptyDoc,
  type EdArc, type EdNode, type NetDoc, type PlaceMarking,
} from './model';

export interface Decompiled {
  doc: NetDoc;
  notes: string[];
}

const markingOf = (initial: boolean, final: boolean): PlaceMarking =>
  // A place in both markings is a one-place accepting net, which the canvas
  // has no way to draw: initial wins, and the note says so.
  (initial ? 'initial' : final ? 'final' : 'none');

/** `AcceptingPetriNet` — index-addressed, so arcs are pairs of positions. */
export function fromAcceptingPetriNet(payload: unknown, name: string): Decompiled {
  const p = (payload ?? {}) as {
    labels?: unknown; places?: unknown;
    place_to_transition?: unknown; transition_to_place?: unknown;
    initial_marking?: unknown; final_marking?: unknown;
  };
  const notes: string[] = [];
  const labels = Array.isArray(p.labels) ? p.labels : [];
  const places = Array.isArray(p.places) ? p.places : [];
  const initial = new Set(Array.isArray(p.initial_marking) ? p.initial_marking as number[] : []);
  const final = new Set(Array.isArray(p.final_marking) ? p.final_marking as number[] : []);

  const both = [...initial].filter((i) => final.has(i));
  if (both.length) {
    notes.push(`${both.length} place${both.length === 1 ? ' is' : 's are'} both initial and final; shown as initial.`);
  }

  const nodes: EdNode[] = [
    ...places.map((pl, i) => {
      const published = String((pl as { id?: unknown })?.id ?? `p${i + 1}`);
      return {
        id: `p${i}`, kind: 'place' as const, name: published, publishedId: published,
        objectType: null, marking: markingOf(initial.has(i), final.has(i)), x: 0, y: 0,
      };
    }),
    // An `AcceptingPetriNet` gives a transition no id of its own — it is
    // addressed by position — so there is nothing to preserve here.
    ...labels.map((label, i) => ({
      id: `t${i}`, kind: 'transition' as const,
      name: typeof label === 'string' ? label : '',
      silent: label === null, x: 0, y: 0,
    })),
  ];

  const arcs: EdArc[] = [];
  const pairs = (value: unknown, from: (n: number) => string, to: (n: number) => string, limitFrom: number, limitTo: number) => {
    for (const entry of Array.isArray(value) ? value : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [a, b] = entry as [number, number];
      if (!(a >= 0 && a < limitFrom && b >= 0 && b < limitTo)) continue;
      arcs.push({ id: `a${arcs.length}`, source: from(a), target: to(b), objectType: null, variable: false });
    }
  };
  pairs(p.place_to_transition, (i) => `p${i}`, (i) => `t${i}`, places.length, labels.length);
  pairs(p.transition_to_place, (i) => `t${i}`, (i) => `p${i}`, labels.length, places.length);

  return { doc: layout({ ...emptyDoc(), name, nodes, arcs }), notes };
}

/** `ObjectCentricPetriNet` — id-addressed, with places and transitions in
 *  separate namespaces (an arc end says which). */
export function fromOcpn(payload: unknown, name: string): Decompiled {
  const p = (payload ?? {}) as {
    objectTypes?: unknown; places?: unknown; transitions?: unknown; arcs?: unknown;
  };
  const notes: string[] = [];
  const typeNames = (Array.isArray(p.objectTypes) ? p.objectTypes : []).map(String);
  const objectTypes = typeNames.map((t, i) => ({ name: t, color: OBJECT_TYPE_COLORS[i % OBJECT_TYPE_COLORS.length] }));

  const nodes: EdNode[] = [];
  const placeIds = new Map<string, string>();
  const transitionIds = new Map<string, string>();
  let collisions = 0;

  for (const [i, raw] of (Array.isArray(p.places) ? p.places : []).entries()) {
    const pl = raw as { id?: unknown; objectType?: unknown; kind?: unknown };
    const published = String(pl?.id ?? `p${i + 1}`);
    const id = `p${i}`;
    if (placeIds.has(published)) collisions++; else placeIds.set(published, id);
    nodes.push({
      id, kind: 'place', name: published, publishedId: published,
      objectType: typeof pl?.objectType === 'string' && pl.objectType ? pl.objectType : null,
      marking: markingOf(pl?.kind === 'source', pl?.kind === 'sink'), x: 0, y: 0,
    });
  }
  for (const [i, raw] of (Array.isArray(p.transitions) ? p.transitions : []).entries()) {
    const tr = raw as { id?: unknown; activity?: unknown };
    const published = String(tr?.id ?? `t${i + 1}`);
    const id = `t${i}`;
    if (transitionIds.has(published)) collisions++; else transitionIds.set(published, id);
    nodes.push({
      id, kind: 'transition', name: typeof tr?.activity === 'string' ? tr.activity : '',
      // The miner's ids mean something (see `publishedId`), and a transition's
      // is routinely not its activity — `t:Collect Goods` against
      // `Collect Goods`. Keeping it is what makes an edited net still the same
      // net to anything that correlates by id.
      publishedId: published,
      silent: tr?.activity === null || tr?.activity === undefined, x: 0, y: 0,
    });
  }
  if (collisions) {
    // Two nodes published under one id: the arcs can only be attached to one
    // of them, so say it rather than silently rewire the net.
    notes.push(`${collisions} node${collisions === 1 ? ' shares its' : 's share'} id with another; arcs were attached to the first.`);
  }

  const resolve = (ref: unknown): string | null => {
    const r = ref as { kind?: unknown; id?: unknown };
    const id = String(r?.id ?? '');
    return (r?.kind === 'place' ? placeIds.get(id) : r?.kind === 'transition' ? transitionIds.get(id) : undefined) ?? null;
  };
  const arcs: EdArc[] = [];
  let dangling = 0;
  for (const [i, raw] of (Array.isArray(p.arcs) ? p.arcs : []).entries()) {
    const a = raw as { id?: unknown; source?: unknown; target?: unknown; objectType?: unknown; variable?: unknown };
    const source = resolve(a?.source);
    const target = resolve(a?.target);
    if (!source || !target) { dangling++; continue; }
    arcs.push({
      id: String(a?.id ?? `a${i}`), source, target,
      objectType: typeof a?.objectType === 'string' && a.objectType ? a.objectType : null,
      variable: a?.variable === true,
    });
  }
  if (dangling) notes.push(`${dangling} arc${dangling === 1 ? '' : 's'} named a node that is not in the net and ${dangling === 1 ? 'was' : 'were'} dropped.`);

  return { doc: layout({ ...emptyDoc(), name, objectTypes, nodes, arcs }), notes };
}

export function decompile(type: string, payload: unknown, name: string): Decompiled {
  if (type === 'ObjectCentricPetriNet') return fromOcpn(payload, name);
  if (type === 'AcceptingPetriNet') return fromAcceptingPetriNet(payload, name);
  throw new Error(`The editor cannot open a ${type}.`);
}

/**
 * Ranks nodes by longest path from a source and lays the ranks out in columns.
 *
 * Deliberately plain: a Petri net alternates places and transitions, so the
 * columns alternate too and flow reads left to right without any crossing
 * minimisation. A cycle has no longest path, so nodes a topological pass never
 * reaches are placed one column past the furthest predecessor that *was*
 * reached — enough to see the net and drag it into shape, which is the job.
 */
export function layout(doc: NetDoc): NetDoc {
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of doc.nodes) { successors.set(n.id, []); indegree.set(n.id, 0); }
  for (const a of doc.arcs) {
    if (!successors.has(a.source) || !indegree.has(a.target)) continue;
    successors.get(a.source)!.push(a.target);
    indegree.set(a.target, indegree.get(a.target)! + 1);
  }

  const rank = new Map<string, number>();
  const queue = doc.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  const remaining = new Map(indegree);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of successors.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  // Whatever the topological pass could not reach is on a cycle.
  for (const n of doc.nodes) {
    if (rank.has(n.id)) continue;
    const ranked = doc.arcs
      .filter((a) => a.target === n.id && rank.has(a.source))
      .map((a) => rank.get(a.source)!);
    rank.set(n.id, ranked.length ? Math.max(...ranked) + 1 : 0);
  }

  const columns = new Map<number, string[]>();
  for (const n of doc.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r)!.push(n.id);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const COL = 170, ROW = 115;
  const position = new Map<string, { x: number; y: number }>();
  for (const [r, ids] of columns) {
    const top = ((tallest - ids.length) * ROW) / 2;
    ids.forEach((id, i) => position.set(id, { x: 60 + r * COL, y: 40 + top + i * ROW }));
  }
  return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...position.get(n.id)! })) };
}
