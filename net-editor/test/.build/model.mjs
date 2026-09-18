const emptyDoc = () => ({
  name: "Untitled net",
  objectTypes: [],
  nodes: [],
  arcs: []
});
const OBJECT_TYPE_COLORS = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#CC79A7",
  "#56B4E9",
  "#D55E00",
  "#8E6C8A",
  "#6b7280"
];
const isPlace = (n) => n.kind === "place";
const isTransition = (n) => n.kind === "transition";
function validateDoc(doc) {
  const problems = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const typed = doc.objectTypes.length > 0;
  const typeNames = new Set(doc.objectTypes.map((t) => t.name));
  if (doc.nodes.length === 0) problems.push({ message: "The net is empty." });
  const names = /* @__PURE__ */ new Set();
  for (const t of doc.objectTypes) {
    if (!t.name.trim()) problems.push({ message: "An object type has no name." });
    else if (names.has(t.name)) problems.push({ message: `Two object types are both called \u201C${t.name}\u201D.` });
    names.add(t.name);
  }
  for (const node of doc.nodes) {
    if (isPlace(node)) {
      if (typed && !node.objectType) {
        problems.push({ id: node.id, message: `Place \u201C${node.name || node.id}\u201D has no object type.` });
      }
      if (node.objectType && !typeNames.has(node.objectType)) {
        problems.push({ id: node.id, message: `Place \u201C${node.name || node.id}\u201D names an object type that no longer exists.` });
      }
    } else if (!node.silent && !node.name.trim()) {
      problems.push({ id: node.id, message: "A transition has no activity name. Name it, or mark it silent." });
    }
  }
  const arcTypesOfTransition = /* @__PURE__ */ new Map();
  if (typed) {
    for (const arc of doc.arcs) {
      if (!arc.objectType) continue;
      for (const end of [arc.source, arc.target]) {
        const node = byId.get(end);
        if (node?.kind !== "transition") continue;
        if (!arcTypesOfTransition.has(end)) arcTypesOfTransition.set(end, /* @__PURE__ */ new Set());
        arcTypesOfTransition.get(end).add(arc.objectType);
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
          message: count === 0 ? "A silent transition has no typed arcs. A silent transition must belong to exactly one object type." : "A silent transition touches several object types. It must belong to exactly one."
        });
      }
    }
  }
  for (const kind of ["place", "transition"]) {
    const seen = /* @__PURE__ */ new Map();
    for (const node of doc.nodes) {
      if (node.kind !== kind) continue;
      const published = publishedIdOf(node);
      if (!published) continue;
      const first = seen.get(published);
      if (first) {
        problems.push({
          id: node.id,
          message: `Two ${kind}s would be published as \u201C${published}\u201D. Rename one.`
        });
      } else seen.set(published, node);
    }
  }
  for (const arc of doc.arcs) {
    const from = byId.get(arc.source);
    const to = byId.get(arc.target);
    if (!from || !to) {
      problems.push({ id: arc.id, message: "An arc has a loose end." });
      continue;
    }
    if (from.kind === to.kind) {
      problems.push({
        id: arc.id,
        message: from.kind === "place" ? "An arc joins two places. Every arc runs between a place and a transition." : "An arc joins two transitions. Every arc runs between a place and a transition."
      });
    }
    if (typed && !arc.objectType) {
      problems.push({ id: arc.id, message: "An arc has no object type." });
      continue;
    }
    for (const end of [from, to]) {
      if (isPlace(end) && arc.objectType && end.objectType && end.objectType !== arc.objectType) {
        problems.push({
          id: arc.id,
          message: `An arc of type \u201C${arc.objectType}\u201D touches place \u201C${end.name || end.id}\u201D, which holds \u201C${end.objectType}\u201D.`
        });
      }
    }
  }
  return problems;
}
const publishedIdOf = (n) => n.publishedId ?? n.name ?? n.id;
const targetType = (doc) => doc.objectTypes.length > 0 ? "ObjectCentricPetriNet" : "AcceptingPetriNet";
function toAcceptingPetriNet(doc) {
  const places = doc.nodes.filter(isPlace);
  const transitions = doc.nodes.filter(isTransition);
  const placeIx = new Map(places.map((p, i) => [p.id, i]));
  const transIx = new Map(transitions.map((t, i) => [t.id, i]));
  const place_to_transition = [];
  const transition_to_place = [];
  const inputs = places.map(() => []);
  const outputs = places.map(() => []);
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
  const labels = transitions.map((t) => t.silent ? null : t.name);
  const initial_marking = places.flatMap((p, i) => p.marking === "initial" ? [i] : []);
  const final_marking = places.flatMap((p, i) => p.marking === "final" ? [i] : []);
  return {
    // `activities` is the index list of labelled transitions — a silent one is
    // not an activity, which is the whole distinction the field exists for.
    activities: transitions.flatMap((t, i) => t.silent ? [] : [i]),
    labels,
    places: places.map((p, i) => ({
      id: publishedIdOf(p) || p.id,
      inputs: inputs[i],
      outputs: outputs[i],
      kind: p.marking === "initial" ? "initial" : p.marking === "final" ? "final" : "derived"
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
      silent_transitions: transitions.filter((t) => t.silent).length
    }
  };
}
function toOcpn(doc) {
  const places = doc.nodes.filter(isPlace);
  const transitions = doc.nodes.filter(isTransition);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const typesOfTransition = /* @__PURE__ */ new Map();
  for (const arc of doc.arcs) {
    if (!arc.objectType) continue;
    for (const end of [arc.source, arc.target]) {
      const node = byId.get(end);
      if (!node || node.kind !== "transition") continue;
      if (!typesOfTransition.has(end)) typesOfTransition.set(end, /* @__PURE__ */ new Set());
      typesOfTransition.get(end).add(arc.objectType);
    }
  }
  return {
    objectTypes: doc.objectTypes.map((t) => t.name),
    places: places.map((p) => ({
      id: publishedIdOf(p) || p.id,
      objectType: p.objectType ?? "",
      kind: p.marking === "initial" ? "source" : p.marking === "final" ? "sink" : "normal"
    })),
    transitions: transitions.map((t) => ({
      id: publishedIdOf(t) || t.id,
      activity: t.silent ? null : t.name,
      objectTypes: [...typesOfTransition.get(t.id) ?? []]
    })),
    arcs: doc.arcs.flatMap((arc) => {
      const from = byId.get(arc.source);
      const to = byId.get(arc.target);
      if (!from || !to || from.kind === to.kind) return [];
      const ref = (n) => ({ kind: n.kind, id: publishedIdOf(n) || n.id });
      return [{
        id: arc.id,
        source: ref(from),
        target: ref(to),
        objectType: arc.objectType ?? "",
        variable: arc.variable
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
        events: 0
      }])),
      skippedObjectTypes: [],
      // Hand-drawn, so there are no discovery parameters. Reported honestly
      // rather than omitted: the Inspector reads this block, and a viewer that
      // finds nothing there cannot tell "authored" from "malformed".
      parameters: { variant: "IM", noiseThreshold: 0, objectTypes: doc.objectTypes.map((t) => t.name) }
    }
  };
}
const compile = (doc) => targetType(doc) === "ObjectCentricPetriNet" ? toOcpn(doc) : toAcceptingPetriNet(doc);
export {
  OBJECT_TYPE_COLORS,
  compile,
  emptyDoc,
  isPlace,
  isTransition,
  publishedIdOf,
  targetType,
  toAcceptingPetriNet,
  toOcpn,
  validateDoc
};
