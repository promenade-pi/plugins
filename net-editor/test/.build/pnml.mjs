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
var isPlace = (n) => n.kind === "place";

// src/pnml.ts
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function toPnml(doc) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<pnml xmlns="http://www.pnml.org/version-2009/grammar/pnml">',
    `  <net id="${esc(doc.name)}" type="http://www.pnml.org/version-2009/grammar/ptnet">`,
    `    <name><text>${esc(doc.name)}</text></name>`
  ];
  if (doc.objectTypes.length) {
    out.push('    <toolspecific tool="promenade-net-editor" version="1.0">');
    out.push("      <objectTypes>");
    for (const t of doc.objectTypes) {
      out.push(`        <objectType name="${esc(t.name)}" color="${esc(t.color)}"/>`);
    }
    out.push("      </objectTypes>");
    out.push("    </toolspecific>");
  }
  out.push('    <page id="page1">');
  for (const n of doc.nodes) {
    const tag = n.kind === "place" ? "place" : "transition";
    out.push(`      <${tag} id="${esc(n.id)}">`);
    out.push(`        <name><text>${esc(n.kind === "transition" && n.silent ? "tau" : n.name)}</text></name>`);
    out.push(`        <graphics><position x="${Math.round(n.x)}" y="${Math.round(n.y)}"/></graphics>`);
    if (n.kind === "place" && n.marking === "initial") {
      out.push("        <initialMarking><text>1</text></initialMarking>");
    }
    out.push('        <toolspecific tool="promenade-net-editor" version="1.0">');
    if (n.kind === "place") {
      if (n.objectType) out.push(`          <objectType>${esc(n.objectType)}</objectType>`);
      out.push(`          <marking>${n.marking}</marking>`);
    } else if (n.silent) {
      out.push("          <silent>true</silent>");
    }
    out.push("        </toolspecific>");
    out.push(`      </${tag}>`);
  }
  for (const a of doc.arcs) {
    out.push(`      <arc id="${esc(a.id)}" source="${esc(a.source)}" target="${esc(a.target)}">`);
    if (a.objectType) out.push(`        <inscription><text>${esc(a.objectType)}</text></inscription>`);
    out.push('        <toolspecific tool="promenade-net-editor" version="1.0">');
    if (a.objectType) out.push(`          <objectType>${esc(a.objectType)}</objectType>`);
    if (a.variable) out.push("          <variable>true</variable>");
    out.push("        </toolspecific>");
    out.push("      </arc>");
  }
  out.push("    </page>", "  </net>", "</pnml>");
  return out.join("\n");
}
var text = (el, tag) => {
  const found = el?.getElementsByTagName(tag)[0];
  return found ? (found.textContent ?? "").trim() : null;
};
var ours = (el) => {
  for (const ts of Array.from(el.getElementsByTagName("toolspecific"))) {
    if (ts.getAttribute("tool") === "promenade-net-editor") return ts;
  }
  return null;
};
var anyToolspecific = (el) => el.getElementsByTagName("toolspecific")[0] ?? null;
function fromPnml(xml) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const error = parsed.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`That file is not valid XML: ${(error.textContent ?? "").slice(0, 120)}`);
  const net = parsed.getElementsByTagName("net")[0];
  if (!net) throw new Error("No <net> element \u2014 is this a PNML file?");
  const doc = emptyDoc();
  const notes = [];
  doc.name = text(net.getElementsByTagName("name")[0]?.parentElement === net ? net : net, "text") || net.getAttribute("id") || "Imported net";
  const pages = Array.from(net.getElementsByTagName("page"));
  if (pages.length > 1) {
    notes.push(`The file has ${pages.length} pages; only the first is imported. Hierarchical nets are not supported.`);
  }
  const scope = pages[0] ?? net;
  const typeColors = /* @__PURE__ */ new Map();
  const declared = ours(net);
  for (const t of Array.from(declared?.getElementsByTagName("objectType") ?? [])) {
    const name = t.getAttribute("name");
    if (name) typeColors.set(name, t.getAttribute("color") || "");
  }
  const seenTypes = [];
  const noteType = (name) => {
    if (name && !seenTypes.includes(name)) seenTypes.push(name);
    return name || null;
  };
  const position = (el, fallback) => {
    const pos = el.getElementsByTagName("position")[0];
    const x = Number(pos?.getAttribute("x"));
    const y = Number(pos?.getAttribute("y"));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { x: 80 + fallback % 6 * 190, y: 80 + Math.floor(fallback / 6) * 140 };
  };
  const nodes = [];
  let index = 0;
  for (const el of Array.from(scope.getElementsByTagName("place"))) {
    const id = el.getAttribute("id") || `p${index}`;
    const mine = ours(el);
    const other = anyToolspecific(el);
    const objectType = text(mine, "objectType") ?? text(other, "colorSet");
    const declaredMarking = text(mine, "marking");
    const hasInitial = el.getElementsByTagName("initialMarking").length > 0;
    nodes.push({
      id,
      kind: "place",
      publishedId: id,
      name: text(el, "text") || id,
      objectType: objectType ? noteType(objectType) : null,
      marking: declaredMarking === "initial" || declaredMarking === "final" ? declaredMarking : hasInitial ? "initial" : "none",
      ...position(el, index++)
    });
  }
  for (const el of Array.from(scope.getElementsByTagName("transition"))) {
    const id = el.getAttribute("id") || `t${index}`;
    const mine = ours(el);
    const name = text(el, "text") || id;
    const other = anyToolspecific(el);
    if (other && (text(other, "guard") || text(other, "codeSegment") || text(other, "subPageId"))) {
      notes.push(`\u201C${name}\u201D has a guard, code or a subpage; only its structure is imported.`);
    }
    nodes.push({
      id,
      kind: "transition",
      publishedId: id,
      name: name === "tau" ? "" : name,
      silent: text(mine, "silent") === "true" || name === "tau",
      ...position(el, index++)
    });
  }
  const placeTypes = new Map(nodes.filter(isPlace).map((n) => [n.id, n.objectType]));
  const known = new Set(nodes.map((n) => n.id));
  const arcs = [];
  for (const el of Array.from(scope.getElementsByTagName("arc"))) {
    const source = el.getAttribute("source") ?? "";
    const target = el.getAttribute("target") ?? "";
    if (!known.has(source) || !known.has(target)) {
      notes.push("An arc referenced a node on another page and was dropped.");
      continue;
    }
    const mine = ours(el);
    const inscription = text(el, "inscription") ?? null;
    const objectType = text(mine, "objectType") ?? (inscription && seenTypes.includes(inscription) ? inscription : null) ?? placeTypes.get(source) ?? placeTypes.get(target) ?? null;
    arcs.push({
      id: el.getAttribute("id") || `a${arcs.length}`,
      source,
      target,
      objectType,
      variable: text(mine, "variable") === "true"
    });
  }
  const objectTypes = seenTypes.map((name, i) => ({
    name,
    color: typeColors.get(name) || OBJECT_TYPE_COLORS[i % OBJECT_TYPE_COLORS.length]
  }));
  if (objectTypes.length) {
    notes.push(`Object types were taken from the file\u2019s colour sets verbatim (${objectTypes.map((t) => t.name).join(", ")}). Split or rename any that combine several objects.`);
  }
  doc.nodes = nodes;
  doc.arcs = arcs;
  doc.objectTypes = objectTypes;
  return { doc, notes };
}
export {
  fromPnml,
  toPnml
};
