import type { OcptPayload, OcptTreeNode } from './types';

// A process tree has no cross edges and no cycles, so — unlike the OCPN
// layout in `plugins/ocpn-flow-view` — it needs no general graph layout
// engine (and so none of elkjs's sandboxed-CSP-without-Worker workaround
// either). A single width-aware postorder/preorder pass is exact and
// instant.

export const OP_SIZE = 40;
export const TAU_COMPACT_SIZE = 16;
const LEAF_MIN_W = 92;
const LEAF_PAD_X = 16;
const LEAF_H = 40;
const SIBLING_GAP = 26;
const LEVEL_GAP = 130;

// The van Detten paper's interaction table below a leaf: a header row plus
// one row per related object type, X-marking which of divergence/
// convergence/deficiency hold. Row height is fixed in CSS too (LeafNode's
// <td>/<th> use the same TABLE_ROW_H as an explicit height) so the DOM
// never silently drifts from what this file told the layout to reserve
// space for — the exact class of bug the operator-node box-sizing fix
// addressed for borders.
export const TABLE_ROW_H = 16;
const TABLE_FLAG_COL_W = 22;
const TABLE_TYPE_COL_MIN_W = 54;
const TABLE_TYPE_PAD_X = 10;
const TABLE_GAP = 4;

export const OP_GLYPH: Record<string, string> = {
  sequence: '→',
  xor: '×',
  parallel: '∧',
  loop: '↻',
};

export const OP_LABEL: Record<string, string> = {
  sequence: 'Sequence',
  xor: 'Exclusive choice',
  parallel: 'Parallel',
  loop: 'Loop',
};

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

export interface TypeFlag {
  type: string;
  divergent: boolean;
  convergent: boolean;
  deficient: boolean;
}

export function leafTypeFlags(n: OcptTreeNode): TypeFlag[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const t of n.related) {
    if (!seen.has(t)) { seen.add(t); order.push(t); }
  }
  return order.map((type) => ({
    type,
    divergent: n.divergent.includes(type),
    convergent: n.convergent.includes(type),
    deficient: n.deficient.includes(type),
  }));
}

export interface TableColumns {
  div: boolean;
  con: boolean;
  def: boolean;
}

// A leaf with no divergence/convergence/deficiency anywhere gets a
// single-column "Type" table (matching the paper's plain leaves like
// "Register"); columns only appear once something in the subtree actually
// needs them.
export function neededColumns(types: TypeFlag[]): TableColumns {
  return {
    div: types.some((t) => t.divergent),
    con: types.some((t) => t.convergent),
    def: types.some((t) => t.deficient),
  };
}

function measureTypeTable(types: TypeFlag[]): { width: number; height: number; cols: TableColumns } {
  const cols = neededColumns(types);
  const flagCols = (cols.div ? 1 : 0) + (cols.con ? 1 : 0) + (cols.def ? 1 : 0);
  const typeColWidth = Math.max(
    TABLE_TYPE_COL_MIN_W,
    ...types.map((t) => measure(t.type, '600 10px system-ui, sans-serif') + TABLE_TYPE_PAD_X),
  );
  return {
    width: typeColWidth + flagCols * TABLE_FLAG_COL_W,
    height: (types.length + 1) * TABLE_ROW_H,
    cols,
  };
}

function leafWidth(label: string, tableWidth: number): number {
  const textW = measure(label, '600 12px system-ui, sans-serif');
  return Math.max(LEAF_MIN_W, textW + LEAF_PAD_X * 2, tableWidth + LEAF_PAD_X);
}

export type NodeKind = 'operator' | 'leaf' | 'tau';

export interface LaidOutNode {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  positioned: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  orientation: 'vertical' | 'horizontal';
  // A tau leaf is never dropped from the tree: it's what makes an XOR
  // branch optional or a loop 0..* vs 1..* rather than mandatory, so
  // removing it would misrepresent the model, not just declutter the
  // drawing — an operator would keep one child and give no visual sign
  // anything was hidden. `compactSilent` only shrinks and mutes its box.
  compactSilent: boolean;
  showInteractionTable: boolean;
}

export function layoutTree(payload: OcptPayload, opts: LayoutOptions): LayoutResult {
  const { nodes, root } = payload;
  const horizontal = opts.orientation === 'horizontal';

  function children(i: number): number[] {
    return nodes[i]?.children ?? [];
  }
  const dimsCache = new Map<number, { w: number; h: number }>();
  function dims(i: number): { w: number; h: number } {
    const cached = dimsCache.get(i);
    if (cached) return cached;
    const n = nodes[i];
    let result: { w: number; h: number };
    if (n.operator) {
      result = { w: OP_SIZE, h: OP_SIZE };
    } else if (n.label == null) {
      const s = opts.compactSilent ? TAU_COMPACT_SIZE : OP_SIZE;
      result = { w: s, h: s };
    } else {
      const types = opts.showInteractionTable ? leafTypeFlags(n) : [];
      const table = types.length ? measureTypeTable(types) : null;
      result = {
        w: leafWidth(n.label, table?.width ?? 0),
        h: LEAF_H + (table ? table.height + TABLE_GAP : 0),
      };
    }
    dimsCache.set(i, result);
    return result;
  }

  const extent: number[] = new Array(nodes.length).fill(0);
  const order: number[] = [];
  function post(i: number) {
    const kids = children(i);
    kids.forEach(post);
    order.push(i);
    const own = horizontal ? dims(i).h : dims(i).w;
    if (!kids.length) {
      extent[i] = own;
      return;
    }
    const kidsExtent = kids.reduce((sum, k) => sum + extent[k], 0) + SIBLING_GAP * (kids.length - 1);
    extent[i] = Math.max(own, kidsExtent);
  }
  post(root);

  const cross: number[] = new Array(nodes.length).fill(0);
  const depth: number[] = new Array(nodes.length).fill(0);
  function pre(i: number, offset: number, d: number) {
    depth[i] = d;
    const kids = children(i);
    if (!kids.length) {
      cross[i] = offset + extent[i] / 2;
      return;
    }
    const kidsExtent = kids.reduce((sum, k) => sum + extent[k], 0) + SIBLING_GAP * (kids.length - 1);
    let cursor = offset + (extent[i] - kidsExtent) / 2;
    let firstCenter = 0;
    let lastCenter = 0;
    kids.forEach((k, idx) => {
      pre(k, cursor, d + 1);
      if (idx === 0) firstCenter = cross[k];
      lastCenter = cross[k];
      cursor += extent[k] + SIBLING_GAP;
    });
    cross[i] = (firstCenter + lastCenter) / 2;
  }
  pre(root, 0, 0);

  const positioned: LaidOutNode[] = [];
  let maxDepth = 0;
  let maxCross = 0;
  for (const i of order) {
    const { w, h } = dims(i);
    const n = nodes[i];
    const kind: NodeKind = n.operator ? 'operator' : n.label == null ? 'tau' : 'leaf';
    const mainPos = depth[i] * LEVEL_GAP;
    const crossPos = cross[i] - (horizontal ? h : w) / 2;
    positioned.push({
      id: i,
      kind,
      x: horizontal ? mainPos : crossPos,
      y: horizontal ? crossPos : mainPos,
      w,
      h,
    });
    maxDepth = Math.max(maxDepth, depth[i]);
    maxCross = Math.max(maxCross, cross[i] + (horizontal ? h : w) / 2);
  }

  const edges: LaidOutEdge[] = order.flatMap((i) =>
    children(i).map((c) => ({ id: `e:${i}:${c}`, source: String(i), target: String(c) })),
  );

  const mainExtent = (maxDepth + 1) * LEVEL_GAP;
  return {
    positioned,
    edges,
    width: horizontal ? mainExtent : maxCross + 40,
    height: horizontal ? maxCross + 40 : mainExtent,
  };
}
