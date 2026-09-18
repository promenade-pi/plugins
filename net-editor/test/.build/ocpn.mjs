function validateOcpn(v) {
  const p = v;
  if (!p || typeof p !== "object") return "not an object";
  if (!Array.isArray(p.objectTypes)) return "no objectTypes";
  if (!Array.isArray(p.places)) return "no places";
  if (!Array.isArray(p.transitions)) return "no transitions";
  if (!Array.isArray(p.arcs)) return "no arcs";
  const types = new Set(p.objectTypes);
  const placeIx = new Map(p.places.map((pl) => [pl.id, pl]));
  const transitionIx = new Map(p.transitions.map((t) => [t.id, t]));
  for (const pl of p.places) {
    if (!types.has(pl.objectType)) return `place ${pl.id} has undeclared object type ${pl.objectType}`;
  }
  for (const t of p.transitions) {
    for (const ot of t.objectTypes) {
      if (!types.has(ot)) return `transition ${t.id} has undeclared object type ${ot}`;
    }
    if (t.activity == null && t.objectTypes.length !== 1) {
      return `silent transition ${t.id} must belong to exactly one object type`;
    }
  }
  for (const a of p.arcs) {
    if (!types.has(a.objectType)) return `arc ${a.id} has undeclared object type ${a.objectType}`;
    if (a.source.kind === "place" === (a.target.kind === "place")) {
      return `arc ${a.id} does not alternate place/transition`;
    }
    for (const end of [a.source, a.target]) {
      if (end.kind === "place") {
        const pl = placeIx.get(end.id);
        if (!pl) return `arc ${a.id} references unknown place ${end.id}`;
        if (pl.objectType !== a.objectType) {
          return `arc ${a.id} object type ${a.objectType} does not match place ${end.id} object type ${pl.objectType}`;
        }
      } else {
        const t = transitionIx.get(end.id);
        if (!t) return `arc ${a.id} references unknown transition ${end.id}`;
        if (!t.objectTypes.includes(a.objectType)) {
          return `arc ${a.id} object type ${a.objectType} not among transition ${end.id}'s object types`;
        }
      }
    }
  }
  return null;
}
function summarizeOcpn(p) {
  return `${p.objectTypes.length} object type${p.objectTypes.length === 1 ? "" : "s"} \xB7 ${p.places.length} places \xB7 ${p.transitions.length} transitions \xB7 ${p.arcs.length} arcs`;
}
export {
  summarizeOcpn,
  validateOcpn
};
