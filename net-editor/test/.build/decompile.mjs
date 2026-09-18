// src/model.ts
var emptyDoc = () => ({
  name: "Untitled net",
  objectTypes: [],
  nodes: [],
  arcs: []
});
var OBJECT_TYPE_COLORS = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#CC79A7",
  "#56B4E9",
  "#D55E00",
  "#8E6C8A",
  "#6b7280"
];

// src/decompile.ts
var markingOf = (initial, final) => (
  // A place in both markings is a one-place accepting net, which the canvas
  // has no way to draw: initial wins, and the note says so.
  initial ? "initial" : final ? "final" : "none"
);
function fromAcceptingPetriNet(payload, name) {
  const p = payload ?? {};
  const notes = [];
  const labels = Array.isArray(p.labels) ? p.labels : [];
  const places = Array.isArray(p.places) ? p.places : [];
  const initial = new Set(Array.isArray(p.initial_marking) ? p.initial_marking : []);
  const final = new Set(Array.isArray(p.final_marking) ? p.final_marking : []);
  const both = [...initial].filter((i) => final.has(i));
  if (both.length) {
    notes.push(`${both.length} place${both.length === 1 ? " is" : "s are"} both initial and final; shown as initial.`);
  }
  const nodes = [
    ...places.map((pl, i) => {
      const published = String(pl?.id ?? `p${i + 1}`);
      return {
        id: `p${i}`,
        kind: "place",
        name: published,
        publishedId: published,
        objectType: null,
        marking: markingOf(initial.has(i), final.has(i)),
        x: 0,
        y: 0
      };
    }),
    // An `AcceptingPetriNet` gives a transition no id of its own — it is
    // addressed by position — so there is nothing to preserve here.
    ...labels.map((label, i) => ({
      id: `t${i}`,
      kind: "transition",
      name: typeof label === "string" ? label : "",
      silent: label === null,
      x: 0,
      y: 0
    }))
  ];
  const arcs = [];
  const pairs = (value, from, to, limitFrom, limitTo) => {
    for (const entry of Array.isArray(value) ? value : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [a, b] = entry;
      if (!(a >= 0 && a < limitFrom && b >= 0 && b < limitTo)) continue;
      arcs.push({ id: `a${arcs.length}`, source: from(a), target: to(b), objectType: null, variable: false });
    }
  };
  pairs(p.place_to_transition, (i) => `p${i}`, (i) => `t${i}`, places.length, labels.length);
  pairs(p.transition_to_place, (i) => `t${i}`, (i) => `p${i}`, labels.length, places.length);
  return { doc: layout({ ...emptyDoc(), name, nodes, arcs }), notes };
}
function fromOcpn(payload, name) {
  const p = payload ?? {};
  const notes = [];
  const typeNames = (Array.isArray(p.objectTypes) ? p.objectTypes : []).map(String);
  const objectTypes = typeNames.map((t, i) => ({ name: t, color: OBJECT_TYPE_COLORS[i % OBJECT_TYPE_COLORS.length] }));
  const nodes = [];
  const placeIds = /* @__PURE__ */ new Map();
  const transitionIds = /* @__PURE__ */ new Map();
  let collisions = 0;
  for (const [i, raw] of (Array.isArray(p.places) ? p.places : []).entries()) {
    const pl = raw;
    const published = String(pl?.id ?? `p${i + 1}`);
    const id = `p${i}`;
    if (placeIds.has(published)) collisions++;
    else placeIds.set(published, id);
    nodes.push({
      id,
      kind: "place",
      name: published,
      publishedId: published,
      objectType: typeof pl?.objectType === "string" && pl.objectType ? pl.objectType : null,
      marking: markingOf(pl?.kind === "source", pl?.kind === "sink"),
      x: 0,
      y: 0
    });
  }
  for (const [i, raw] of (Array.isArray(p.transitions) ? p.transitions : []).entries()) {
    const tr = raw;
    const published = String(tr?.id ?? `t${i + 1}`);
    const id = `t${i}`;
    if (transitionIds.has(published)) collisions++;
    else transitionIds.set(published, id);
    nodes.push({
      id,
      kind: "transition",
      name: typeof tr?.activity === "string" ? tr.activity : "",
      // The miner's ids mean something (see `publishedId`), and a transition's
      // is routinely not its activity — `t:Collect Goods` against
      // `Collect Goods`. Keeping it is what makes an edited net still the same
      // net to anything that correlates by id.
      publishedId: published,
      silent: tr?.activity === null || tr?.activity === void 0,
      x: 0,
      y: 0
    });
  }
  if (collisions) {
    notes.push(`${collisions} node${collisions === 1 ? " shares its" : "s share"} id with another; arcs were attached to the first.`);
  }
  const resolve = (ref) => {
    const r = ref;
    const id = String(r?.id ?? "");
    return (r?.kind === "place" ? placeIds.get(id) : r?.kind === "transition" ? transitionIds.get(id) : void 0) ?? null;
  };
  const arcs = [];
  let dangling = 0;
  for (const [i, raw] of (Array.isArray(p.arcs) ? p.arcs : []).entries()) {
    const a = raw;
    const source = resolve(a?.source);
    const target = resolve(a?.target);
    if (!source || !target) {
      dangling++;
      continue;
    }
    arcs.push({
      id: String(a?.id ?? `a${i}`),
      source,
      target,
      objectType: typeof a?.objectType === "string" && a.objectType ? a.objectType : null,
      variable: a?.variable === true
    });
  }
  if (dangling) notes.push(`${dangling} arc${dangling === 1 ? "" : "s"} named a node that is not in the net and ${dangling === 1 ? "was" : "were"} dropped.`);
  return { doc: layout({ ...emptyDoc(), name, objectTypes, nodes, arcs }), notes };
}
function decompile(type, payload, name) {
  if (type === "ObjectCentricPetriNet") return fromOcpn(payload, name);
  if (type === "AcceptingPetriNet") return fromAcceptingPetriNet(payload, name);
  throw new Error(`The editor cannot open a ${type}.`);
}
function layout(doc) {
  const successors = /* @__PURE__ */ new Map();
  const indegree = /* @__PURE__ */ new Map();
  for (const n of doc.nodes) {
    successors.set(n.id, []);
    indegree.set(n.id, 0);
  }
  for (const a of doc.arcs) {
    if (!successors.has(a.source) || !indegree.has(a.target)) continue;
    successors.get(a.source).push(a.target);
    indegree.set(a.target, indegree.get(a.target) + 1);
  }
  const rank = /* @__PURE__ */ new Map();
  const queue = doc.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) rank.set(id, 0);
  const remaining = new Map(indegree);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const next of successors.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  for (const n of doc.nodes) {
    if (rank.has(n.id)) continue;
    const ranked = doc.arcs.filter((a) => a.target === n.id && rank.has(a.source)).map((a) => rank.get(a.source));
    rank.set(n.id, ranked.length ? Math.max(...ranked) + 1 : 0);
  }
  const columns = /* @__PURE__ */ new Map();
  for (const n of doc.nodes) {
    const r = rank.get(n.id) ?? 0;
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(n.id);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const COL = 170, ROW = 115;
  const position = /* @__PURE__ */ new Map();
  for (const [r, ids] of columns) {
    const top = (tallest - ids.length) * ROW / 2;
    ids.forEach((id, i) => position.set(id, { x: 60 + r * COL, y: 40 + top + i * ROW }));
  }
  return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...position.get(n.id) })) };
}
export {
  decompile,
  fromAcceptingPetriNet,
  fromOcpn,
  layout
};
