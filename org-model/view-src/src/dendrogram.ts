/**
 * Dendrogram geometry.
 *
 * The merge list is a tree, and the whole reason the kernel emits it is that a
 * reader should be able to see *why* the cut produced these groups and what
 * the next merge would have joined. That only works if the drawing is honest
 * about height: a join's vertical position is the distance it happened at, so
 * a group that survives a long way up the axis is one nothing was close
 * enough to absorb.
 *
 * Separated from the renderer so it can be checked: every leaf placed once,
 * in the tree's own order, with no crossings — which is the property that
 * makes a dendrogram readable and the one that breaks silently.
 */

export interface Merge { a: number; b: number; distance: number; size: number }

export interface DendroNode {
  /** Cluster id: `< leafCount` is a person, above is a merge. */
  id: number;
  /** Horizontal position, in leaf units: a leaf sits at its own slot, an
   *  internal node midway between its children. */
  x: number;
  /** Vertical position: the distance this join happened at. Leaves sit at 0. */
  y: number;
  children?: [number, number];
}

export interface Dendrogram {
  nodes: Map<number, DendroNode>;
  /** Leaf ids left to right — the order the group list should follow. */
  order: number[];
  root: number | null;
  maxDistance: number;
}

/**
 * Lays the merge sequence out.
 *
 * Leaf order comes from an in-order walk of the tree rather than from the
 * input order: that is what guarantees no edge crosses another, since every
 * subtree then occupies one contiguous run of slots.
 */
export function layoutDendrogram(leafCount: number, merges: Merge[]): Dendrogram {
  const nodes = new Map<number, DendroNode>();
  const children = new Map<number, [number, number]>();
  for (let i = 0; i < merges.length; i++) {
    children.set(leafCount + i, [merges[i].a, merges[i].b]);
  }

  // The last merge is the root when the tree is complete. A partial or empty
  // merge list (connected components emits none) leaves several roots; every
  // cluster that is nobody's child is one.
  const isChild = new Set<number>();
  for (const [a, b] of children.values()) { isChild.add(a); isChild.add(b); }
  const roots: number[] = [];
  for (let id = 0; id < leafCount + merges.length; id++) {
    if (!isChild.has(id)) roots.push(id);
  }

  const order: number[] = [];
  // Explicit stack: a deep dendrogram is `leafCount` levels in the worst case,
  // and a recursive walk over a few hundred people would be fine — but the
  // iterative version costs nothing and cannot be the reason this breaks on
  // somebody's unusually chain-like organisation.
  for (const root of roots) {
    const stack: Array<{ id: number; expanded: boolean }> = [{ id: root, expanded: false }];
    while (stack.length) {
      const frame = stack.pop()!;
      const kids = children.get(frame.id);
      if (!kids || frame.expanded) {
        if (!kids) order.push(frame.id);
        continue;
      }
      // Push right first so the left child is visited first.
      stack.push({ id: frame.id, expanded: true });
      stack.push({ id: kids[1], expanded: false });
      stack.push({ id: kids[0], expanded: false });
    }
  }

  order.forEach((leaf, slot) => {
    nodes.set(leaf, { id: leaf, x: slot, y: 0 });
  });

  let maxDistance = 0;
  for (let i = 0; i < merges.length; i++) {
    const id = leafCount + i;
    const [a, b] = children.get(id)!;
    const na = nodes.get(a), nb = nodes.get(b);
    // A merge always follows its children in the sequence, so both are placed
    // by now; a malformed list is skipped rather than crashing the panel.
    if (!na || !nb) continue;
    nodes.set(id, {
      id,
      x: (na.x + nb.x) / 2,
      y: merges[i].distance,
      children: [a, b],
    });
    if (merges[i].distance > maxDistance) maxDistance = merges[i].distance;
  }

  return { nodes, order, root: roots.length === 1 ? roots[0] : null, maxDistance };
}

/**
 * The height at which the current cut sits, for the line drawn across the
 * dendrogram.
 *
 * For a threshold cut that is the threshold itself, in distance terms. For a
 * count cut it is between the last merge that happened and the first that did
 * not — drawn there rather than on either one, because the cut is what
 * separates them and sitting it exactly on a merge reads as ambiguous.
 */
export function cutHeight(
  merges: Merge[], cutBy: string, cut: number, leafCount: number,
): number | null {
  if (!merges.length) return null;
  if (cutBy === 'threshold') return cut;
  const groups = Math.max(1, Math.min(leafCount, Math.round(cut)));
  const applied = leafCount - groups; // how many merges the cut allows
  if (applied <= 0) return merges[0].distance / 2;
  if (applied >= merges.length) return merges[merges.length - 1].distance;
  return (merges[applied - 1].distance + merges[applied].distance) / 2;
}
