/**
 * PNML in and out, for the editor's own document.
 *
 * PNML has no object-centric grammar: its P/T grammar is uncoloured and its
 * high-level grammar describes colour *sorts* and inscriptions, which is a
 * bigger idea than "this place belongs to object type X". So this writes a
 * structurally valid P/T net and carries the object-centric part in
 * `<toolspecific>` — the same thing OCPN Studio does with its colour sets, and
 * the same thing Promenade's own OCPN export does.
 *
 * Unlike that export, this one *does* write `<graphics>` positions. An
 * authored net has a layout its author chose and will expect back; a
 * discovered one has none, and inventing coordinates for it would bake one
 * viewer's arrangement into an interchange file as though it were data.
 */
import { emptyDoc, isPlace, OBJECT_TYPE_COLORS, type EdArc, type EdNode, type NetDoc, type ObjectType } from './model';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toPnml(doc: NetDoc): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<pnml xmlns="http://www.pnml.org/version-2009/grammar/pnml">',
    `  <net id="${esc(doc.name)}" type="http://www.pnml.org/version-2009/grammar/ptnet">`,
    `    <name><text>${esc(doc.name)}</text></name>`,
  ];
  if (doc.objectTypes.length) {
    out.push('    <toolspecific tool="promenade-net-editor" version="1.0">');
    out.push('      <objectTypes>');
    for (const t of doc.objectTypes) {
      out.push(`        <objectType name="${esc(t.name)}" color="${esc(t.color)}"/>`);
    }
    out.push('      </objectTypes>');
    out.push('    </toolspecific>');
  }
  out.push('    <page id="page1">');

  for (const n of doc.nodes) {
    const tag = n.kind === 'place' ? 'place' : 'transition';
    out.push(`      <${tag} id="${esc(n.id)}">`);
    out.push(`        <name><text>${esc(n.kind === 'transition' && n.silent ? 'tau' : n.name)}</text></name>`);
    out.push(`        <graphics><position x="${Math.round(n.x)}" y="${Math.round(n.y)}"/></graphics>`);
    if (n.kind === 'place' && n.marking === 'initial') {
      out.push('        <initialMarking><text>1</text></initialMarking>');
    }
    out.push('        <toolspecific tool="promenade-net-editor" version="1.0">');
    if (n.kind === 'place') {
      if (n.objectType) out.push(`          <objectType>${esc(n.objectType)}</objectType>`);
      out.push(`          <marking>${n.marking}</marking>`);
    } else if (n.silent) {
      out.push('          <silent>true</silent>');
    }
    out.push('        </toolspecific>');
    out.push(`      </${tag}>`);
  }

  for (const a of doc.arcs) {
    out.push(`      <arc id="${esc(a.id)}" source="${esc(a.source)}" target="${esc(a.target)}">`);
    if (a.objectType) out.push(`        <inscription><text>${esc(a.objectType)}</text></inscription>`);
    out.push('        <toolspecific tool="promenade-net-editor" version="1.0">');
    if (a.objectType) out.push(`          <objectType>${esc(a.objectType)}</objectType>`);
    if (a.variable) out.push('          <variable>true</variable>');
    out.push('        </toolspecific>');
    out.push('      </arc>');
  }

  out.push('    </page>', '  </net>', '</pnml>');
  return out.join('\n');
}

const text = (el: Element | null | undefined, tag: string): string | null => {
  const found = el?.getElementsByTagName(tag)[0];
  return found ? (found.textContent ?? '').trim() : null;
};

/** Our own toolspecific block, if this file came from here. */
const ours = (el: Element): Element | null => {
  for (const ts of Array.from(el.getElementsByTagName('toolspecific'))) {
    if (ts.getAttribute('tool') === 'promenade-net-editor') return ts;
  }
  return null;
};

/** Any toolspecific block, whoever wrote it — OCPN Studio's, for instance. */
const anyToolspecific = (el: Element): Element | null => el.getElementsByTagName('toolspecific')[0] ?? null;

export interface PnmlImport {
  doc: NetDoc;
  /** What could not be represented, said plainly rather than dropped silently. */
  notes: string[];
}

/**
 * Reads a PNML file into an editable document.
 *
 * Two dialects in practice. Our own round-trips exactly. Anything else — an
 * OCPN Studio export, a pm4py or ProM file — gives up its structure, its names
 * and its positions, and for the object-centric part we do the one honest
 * thing available: a coloured net's place has a `<colorSet>`, and that name is
 * adopted verbatim as an object type. A product colour set (`AircraftxGate`)
 * is *not* an object type in the OCPN sense, so it arrives as a type of that
 * name for the author to split or rename. Guessing at the decomposition would
 * be inventing a model the file does not contain.
 */
export function fromPnml(xml: string): PnmlImport {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  const error = parsed.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`That file is not valid XML: ${(error.textContent ?? '').slice(0, 120)}`);

  const net = parsed.getElementsByTagName('net')[0];
  if (!net) throw new Error('No <net> element — is this a PNML file?');

  const doc = emptyDoc();
  const notes: string[] = [];
  doc.name = text(net.getElementsByTagName('name')[0]?.parentElement === net
    ? net : net, 'text') || net.getAttribute('id') || 'Imported net';

  const pages = Array.from(net.getElementsByTagName('page'));
  if (pages.length > 1) {
    notes.push(`The file has ${pages.length} pages; only the first is imported. Hierarchical nets are not supported.`);
  }
  const scope: Element = pages[0] ?? net;

  const typeColors = new Map<string, string>();
  const declared = ours(net);
  for (const t of Array.from(declared?.getElementsByTagName('objectType') ?? [])) {
    const name = t.getAttribute('name');
    if (name) typeColors.set(name, t.getAttribute('color') || '');
  }

  const seenTypes: string[] = [];
  const noteType = (name: string) => {
    if (name && !seenTypes.includes(name)) seenTypes.push(name);
    return name || null;
  };

  const position = (el: Element, fallback: number): { x: number; y: number } => {
    const pos = el.getElementsByTagName('position')[0];
    const x = Number(pos?.getAttribute('x'));
    const y = Number(pos?.getAttribute('y'));
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x, y }
      // No graphics: lay it out in a column so nothing lands on top of
      // anything else, and let the author arrange it.
      : { x: 80 + (fallback % 6) * 190, y: 80 + Math.floor(fallback / 6) * 140 };
  };

  const nodes: EdNode[] = [];
  let index = 0;
  for (const el of Array.from(scope.getElementsByTagName('place'))) {
    const id = el.getAttribute('id') || `p${index}`;
    const mine = ours(el);
    const other = anyToolspecific(el);
    const objectType = text(mine, 'objectType') ?? text(other, 'colorSet');
    const declaredMarking = text(mine, 'marking');
    const hasInitial = el.getElementsByTagName('initialMarking').length > 0;
    nodes.push({
      id,
      kind: 'place',
      publishedId: id,
      name: text(el, 'text') || id,
      objectType: objectType ? noteType(objectType) : null,
      marking: declaredMarking === 'initial' || declaredMarking === 'final'
        ? declaredMarking
        : hasInitial ? 'initial' : 'none',
      ...position(el, index++),
    });
  }
  for (const el of Array.from(scope.getElementsByTagName('transition'))) {
    const id = el.getAttribute('id') || `t${index}`;
    const mine = ours(el);
    const name = text(el, 'text') || id;
    const other = anyToolspecific(el);
    if (other && (text(other, 'guard') || text(other, 'codeSegment') || text(other, 'subPageId'))) {
      notes.push(`“${name}” has a guard, code or a subpage; only its structure is imported.`);
    }
    nodes.push({
      id,
      kind: 'transition',
      publishedId: id,
      name: name === 'tau' ? '' : name,
      silent: text(mine, 'silent') === 'true' || name === 'tau',
      ...position(el, index++),
    });
  }

  const placeTypes = new Map(nodes.filter(isPlace).map((n) => [n.id, n.objectType]));
  const known = new Set(nodes.map((n) => n.id));
  const arcs: EdArc[] = [];
  for (const el of Array.from(scope.getElementsByTagName('arc'))) {
    const source = el.getAttribute('source') ?? '';
    const target = el.getAttribute('target') ?? '';
    if (!known.has(source) || !known.has(target)) {
      notes.push('An arc referenced a node on another page and was dropped.');
      continue;
    }
    const mine = ours(el);
    const inscription = text(el, 'inscription') ?? null;
    const objectType = text(mine, 'objectType')
      // An arc inscription is only adopted as a type when it names one we
      // already know: in a CPN it is an expression (`[ac, gate]`), not a type.
      ?? (inscription && seenTypes.includes(inscription) ? inscription : null)
      // Otherwise the place end decides, which is the same rule the canvas
      // applies to every arc it draws. A file that types its places and not
      // its arcs (every CPN does — the type is on the place) would otherwise
      // import as dozens of untyped arcs for the author to fix by hand.
      ?? placeTypes.get(source) ?? placeTypes.get(target) ?? null;
    arcs.push({
      id: el.getAttribute('id') || `a${arcs.length}`,
      source,
      target,
      objectType,
      variable: text(mine, 'variable') === 'true',
    });
  }

  const objectTypes: ObjectType[] = seenTypes.map((name, i) => ({
    name,
    color: typeColors.get(name) || OBJECT_TYPE_COLORS[i % OBJECT_TYPE_COLORS.length],
  }));

  if (objectTypes.length) {
    // Said once rather than per place: a colour set is adopted verbatim, so a
    // product set such as `AircraftxGate` arrives as a type of that name. It
    // is a real model, just not the object-centric decomposition — and only
    // the author knows what that decomposition should be.
    notes.push(`Object types were taken from the file’s colour sets verbatim (${objectTypes.map((t) => t.name).join(', ')}). Split or rename any that combine several objects.`);
  }

  doc.nodes = nodes;
  doc.arcs = arcs;
  doc.objectTypes = objectTypes;
  return { doc, notes };
}
