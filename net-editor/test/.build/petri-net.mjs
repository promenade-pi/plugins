function validateAcceptingPetriNet(v) {
  const p = v;
  if (!p || typeof p !== "object") return "not an object";
  if (!Array.isArray(p.labels)) return "no labels";
  if (!Array.isArray(p.places)) return "no places";
  const transitionCount = p.labels.length;
  const placeCount = p.places.length;
  for (const [i, label] of p.labels.entries()) {
    if (label !== null && typeof label !== "string") return `labels[${i}] is neither a string nor null`;
  }
  const pair = (name, value, firstMax, secondMax) => {
    if (!Array.isArray(value)) return `no ${name}`;
    for (const [i, entry] of value.entries()) {
      if (!Array.isArray(entry) || entry.length !== 2) return `${name}[${i}] is not a pair`;
      const [a, b] = entry;
      if (!Number.isInteger(a) || a < 0 || a >= firstMax) return `${name}[${i}] has an out-of-range source`;
      if (!Number.isInteger(b) || b < 0 || b >= secondMax) return `${name}[${i}] has an out-of-range target`;
    }
    return null;
  };
  const arcs = pair("place_to_transition", p.place_to_transition, placeCount, transitionCount) ?? pair("transition_to_place", p.transition_to_place, transitionCount, placeCount);
  if (arcs) return arcs;
  const marking = (name, value) => {
    if (!Array.isArray(value)) return `no ${name}`;
    for (const [i, x] of value.entries()) {
      if (!Number.isInteger(x) || x < 0 || x >= placeCount) return `${name}[${i}] is not a place index`;
    }
    return null;
  };
  const markings = marking("initial_marking", p.initial_marking) ?? marking("final_marking", p.final_marking);
  if (markings) return markings;
  for (const [i, place] of p.places.entries()) {
    const pl = place;
    if (!pl || typeof pl !== "object") return `places[${i}] is not an object`;
    if (typeof pl.id !== "string" || !pl.id) return `places[${i}] has no id`;
    for (const key of ["inputs", "outputs"]) {
      if (!Array.isArray(pl[key])) return `places[${i}].${key} is not an array`;
      for (const t of pl[key]) {
        if (!Number.isInteger(t) || t < 0 || t >= transitionCount) {
          return `places[${i}].${key} names a transition that does not exist`;
        }
      }
    }
  }
  const ids = new Set(p.places.map((pl) => pl.id));
  if (ids.size !== placeCount) return "two places share an id";
  return null;
}
export {
  validateAcceptingPetriNet
};
