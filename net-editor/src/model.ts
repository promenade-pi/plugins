/**
 * The editor's own net model, and the two artifact payloads it compiles to.
 *
 * One model covers both targets on purpose: a Petri net is the degenerate
 * object-centric net with no object types. Declaring a type switches on
 * per-place typing, per-arc typing and variable arcs; declaring none leaves a
 * plain net. That keeps one canvas, one selection model and one undo stack
 * instead of two editors that would differ only in what they refuse to draw.
 *
 * The editor model is *not* either artifact shape. Both payloads address
 * things by index or by derived id and carry no coordinates, which is the
 * right contract for a discovered model and a hostile one to edit: deleting a
 * transition would renumber every arc. So the editor keeps ids and positions,
 * and compiles on publish.
 */

export interface ObjectType {
  name: string;
  color: string;
}

export type PlaceMarking = 'none' | 'initial' | 'final';

/**
 * The id this node was published under before it was opened for editing.
 *
 * A net's ids are not decoration: `ocpn.ts` makes a labelled transition's id a
 * pure function of its activity, which is how two object types that discover
 * the same activity end up sharing one transition — and a comparison or a
 * replay correlates nets by id. Republishing an edited net under freshly
 * derived ids would quietly break every one of those, so the id a node came in
 * with is kept until the author renames the thing it names, at which point it
 * is no longer the name of that thing.
 */
interface Imported {
  publishedId?: string;
}

export interface EdPlace extends Imported {
  id: string;
  kind: 'place';
  name: string;
  /** `null` while untyped, which is the only valid state for a plain net. */
  objectType: string | null;
  marking: PlaceMarking;
  x: number;
  y: number;
}

export interface EdTransition extends Imported {
  id: string;
  kind: 'transition';
  /** The activity. Ignored while `silent`. */
  name: string;
  silent: boolean;
  x: number;
  y: number;
}

export type EdNode = EdPlace | EdTransition;

export interface EdArc {
  id: string;
  source: string;
  target: string;
  objectType: string | null;
  /** One firing may move more than one token of this type. OCPN only. */
  variable: boolean;
}

export interface NetDoc {
  name: string;
  objectTypes: ObjectType[];
  nodes: EdNode[];
  arcs: EdArc[];
}

export const emptyDoc = (): NetDoc => ({
  name: 'Untitled net',
  objectTypes: [],
  nodes: [],
  arcs: [],
});

/** Okabe-Ito, the palette the rest of Promenade colours object types from. */
export const OBJECT_TYPE_COLORS = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#8E6C8A', '#6b7280',
];

export const isPlace = (n: EdNode): n is EdPlace => n.kind === 'place';
export const isTransition = (n: EdNode): n is EdTransition => n.kind === 'transition';

/* ------------------------------------------------------------------ *
 * Validation.
 * ------------------------------------------------------------------ */

export interface Problem {
  /** The node or arc at fault, so the canvas can point at it. */
  id?: string;
  message: string;
}

/**
 * Everything that would make the published artifact invalid or meaningless.
 *
 * Reported before publishing rather than after: the host validates too (it has
 * to — a frame is untrusted), but its errors are about the payload, and by
 * then the author has lost the connection between "places[3].outputs names a
 * transition that does not exist" and the arc they drew.
 */
export function validateDoc(doc: NetDoc): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const typed = doc.objectTypes.length > 0;
  const typeNames = new Set(doc.objectTypes.map((t) => t.name));

  if (doc.nodes.length === 0) problems.push({ message: 'The net is empty.' });

  const names = new Set<string>();
  for (const t of doc.objectTypes) {
    if (!t.name.trim()) problems.push({ message: 'An object type has no name.' });
    else if (names.has(t.name)) problems.push({ message: `Two object types are both called “${t.name}”.` });
    names.add(t.name);
  }

  for (const node of doc.nodes) {
    if (isPlace(node)) {
      if (typed && !node.objectType) {
        problems.push({ id: node.id, message: `Place “${node.name || node.id}” has no object type.` });
      }
      if (node.objectType && !typeNames.has(node.objectType)) {
        problems.push({ id: node.id, message: `Place “${node.name || node.id}” names an object type that no longer exists.` });
      }
    } else if (!node.silent && !node.name.trim()) {
      problems.push({ id: node.id, message: 'A transition has no activity name. Name it, or mark it silent.' });
    }
  }

  /**
   * The OCPN rules the host validator enforces, checked here first.
   *
   * Not duplication for its own sake: the host has to check, because a frame
   * is untrusted, but by the time it speaks the author has lost the thread
   * between "arc a7 object type order does not match place p3 object type
   * item" and the arc they just dragged. These say the same things about the
   * thing on screen.
   */
  const arcTypesOfTransition = new Map<string, Set<string>>();
  if (typed) {
    for (const arc of doc.arcs) {
      if (!arc.objectType) continue;
      for (const end of [arc.source, arc.target]) {
        const node = byId.get(end);
        if (node?.kind !== 'transition') continue;
        if (!arcTypesOfTransition.has(end)) arcTypesOfTransition.set(end, new Set());
        arcTypesOfTransition.get(end)!.add(arc.objectType);
      }
    }
    for (const node of doc.nodes) {
      if (!isTransition(node) || !node.silent) continue;
      const count = arcTypesOfTransition.get(node.id)?.size ?? 0;
      if (count !== 1) {
        problems.push({
          id: node.id,
          // A silent transition routes tokens of one type; one shared across
          // types would have no meaning, and an unconnected one no purpose.
          message: count === 0
            ? 'A silent transition has no typed arcs. A silent transition must belong to exactly one object type.'
            : 'A silent transition touches several object types. It must belong to exactly one.',
        });
      }
    }
  }

  // Published ids have to be unique within their namespace, and an edited net
  // mixes ids it kept with ids derived from names — so a rename can collide
  // with an id somebody else is still holding. The host refuses the whole
  // publish for this; saying it here points at the node.
  for (const kind of ['place', 'transition'] as const) {
    const seen = new Map<string, EdNode>();
    for (const node of doc.nodes) {
      if (node.kind !== kind) continue;
      const published = publishedIdOf(node);
      if (!published) continue;
      const first = seen.get(published);
      if (first) {
        problems.push({
          id: node.id,
          message: `Two ${kind}s would be published as “${published}”. Rename one.`,
        });
      } else seen.set(published, node);
    }
  }

  for (const arc of doc.arcs) {
    const from = byId.get(arc.source);
    const to = byId.get(arc.target);
    if (!from || !to) {
      problems.push({ id: arc.id, message: 'An arc has a loose end.' });
      continue;
    }
    // The one structural rule a Petri net has: the graph is bipartite.
    if (from.kind === to.kind) {
      problems.push({
        id: arc.id,
        message: from.kind === 'place'
          ? 'An arc joins two places. Every arc runs between a place and a transition.'
          : 'An arc joins two transitions. Every arc runs between a place and a transition.',
      });
    }
    if (typed && !arc.objectType) {
      problems.push({ id: arc.id, message: 'An arc has no object type.' });
      continue;
    }
    // An arc and the place it touches must agree: the arc carries tokens of
    // its type, and the place holds tokens of its own.
    for (const end of [from, to]) {
      if (isPlace(end) && arc.objectType && end.objectType && end.objectType !== arc.objectType) {
        problems.push({
          id: arc.id,
          message: `An arc of type “${arc.objectType}” touches place “${end.name || end.id}”, which holds “${end.objectType}”.`,
        });
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Compilation.
 * ------------------------------------------------------------------ */

/** The id a node publishes under. */
export const publishedIdOf = (n: EdNode): string => n.publishedId ?? n.name ?? n.id;

/** Which artifact this document publishes as. */
export const targetType = (doc: NetDoc): 'AcceptingPetriNet' | 'ObjectCentricPetriNet' =>
  (doc.objectTypes.length > 0 ? 'ObjectCentricPetriNet' : 'AcceptingPetriNet');

/**
 * `AcceptingPetriNet`: index-addressed, so this is where editor ids are
 * flattened into the positions every downstream viewer and conformance
 * checker expects.
 */
export function toAcceptingPetriNet(doc: NetDoc): unknown {
  const places = doc.nodes.filter(isPlace);
  const transitions = doc.nodes.filter(isTransition);
  const placeIx = new Map(places.map((p, i) => [p.id, i]));
  const transIx = new Map(transitions.map((t, i) => [t.id, i]));

  const place_to_transition: Array<[number, number]> = [];
  const transition_to_place: Array<[number, number]> = [];
  const inputs: number[][] = places.map(() => []);
  const outputs: number[][] = places.map(() => []);

  for (const arc of doc.arcs) {
    const p = placeIx.get(arc.source);
    const t = transIx.get(arc.target);
    if (p != null && t != null) {
      place_to_transition.push([p, t]);
      outputs[p].push(t);
      continue;
    }
    const ft = transIx.get(arc.source);
    const tp = placeIx.get(arc.target);
    if (ft != null && tp != null) {
      transition_to_place.push([ft, tp]);
      inputs[tp].push(ft);
    }
  }

  const labels = transitions.map((t) => (t.silent ? null : t.name));
  const initial_marking = places.flatMap((p, i) => (p.marking === 'initial' ? [i] : []));
  const final_marking = places.flatMap((p, i) => (p.marking === 'final' ? [i] : []));

  return {
    // `activities` is the index list of labelled transitions — a silent one is
    // not an activity, which is the whole distinction the field exists for.
    activities: transitions.flatMap((t, i) => (t.silent ? [] : [i])),
    labels,
    places: places.map((p, i) => ({
      id: publishedIdOf(p) || p.id,
      inputs: inputs[i],
      outputs: outputs[i],
      kind: p.marking === 'initial' ? 'initial' : p.marking === 'final' ? 'final' : 'derived',
    })),
    place_to_transition,
    transition_to_place,
    initial_marking,
    final_marking,
    start_activities: initial_marking.flatMap((p) => outputs[p]).filter((t) => !transitions[t].silent),
    end_activities: final_marking.flatMap((p) => inputs[p]).filter((t) => !transitions[t].silent),
    stats: {
      places: places.length,
      transitions: transitions.length,
      arcs: place_to_transition.length + transition_to_place.length,
      silent_transitions: transitions.filter((t) => t.silent).length,
    },
  };
}

/**
 * `ObjectCentricPetriNet`: id-addressed, and a transition carries every object
 * type that touches it — derived from the arcs rather than asked for, because
 * a transition's types *are* the types of its arcs and a second, editable copy
 * would only ever be a way to disagree with them.
 */
export function toOcpn(doc: NetDoc): unknown {
  const places = doc.nodes.filter(isPlace);
  const transitions = doc.nodes.filter(isTransition);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));

  const typesOfTransition = new Map<string, Set<string>>();
  for (const arc of doc.arcs) {
    if (!arc.objectType) continue;
    for (const end of [arc.source, arc.target]) {
      const node = byId.get(end);
      if (!node || node.kind !== 'transition') continue;
      if (!typesOfTransition.has(end)) typesOfTransition.set(end, new Set());
      typesOfTransition.get(end)!.add(arc.objectType);
    }
  }

  return {
    objectTypes: doc.objectTypes.map((t) => t.name),
    places: places.map((p) => ({
      id: publishedIdOf(p) || p.id,
      objectType: p.objectType ?? '',
      kind: p.marking === 'initial' ? 'source' : p.marking === 'final' ? 'sink' : 'normal',
    })),
    transitions: transitions.map((t) => ({
      id: publishedIdOf(t) || t.id,
      activity: t.silent ? null : t.name,
      objectTypes: [...(typesOfTransition.get(t.id) ?? [])],
    })),
    arcs: doc.arcs.flatMap((arc) => {
      const from = byId.get(arc.source);
      const to = byId.get(arc.target);
      if (!from || !to || from.kind === to.kind) return [];
      const ref = (n: EdNode) => ({ kind: n.kind, id: publishedIdOf(n) || n.id });
      return [{
        id: arc.id,
        source: ref(from),
        target: ref(to),
        objectType: arc.objectType ?? '',
        variable: arc.variable,
      }];
    }),
    metadata: {
      perObjectType: Object.fromEntries(doc.objectTypes.map((t) => [t.name, {
        places: places.filter((p) => p.objectType === t.name).length,
        transitions: transitions.filter((tr) => typesOfTransition.get(tr.id)?.has(t.name)).length,
        arcs: doc.arcs.filter((a) => a.objectType === t.name).length,
        silentTransitions: transitions.filter((tr) => tr.silent && typesOfTransition.get(tr.id)?.has(t.name)).length,
        variableArcs: doc.arcs.filter((a) => a.objectType === t.name && a.variable).length,
        traces: 0,
        events: 0,
      }])),
      skippedObjectTypes: [],
      // Hand-drawn, so there are no discovery parameters. Reported honestly
      // rather than omitted: the Inspector reads this block, and a viewer that
      // finds nothing there cannot tell "authored" from "malformed".
      parameters: { variant: 'IM', noiseThreshold: 0, objectTypes: doc.objectTypes.map((t) => t.name) },
    },
  };
}

export const compile = (doc: NetDoc): unknown =>
  (targetType(doc) === 'ObjectCentricPetriNet' ? toOcpn(doc) : toAcceptingPetriNet(doc));
