import type { InternalNode, Node } from '@xyflow/react';

/**
 * "Floating edges" — React Flow's own pattern for a graph where nodes can
 * sit anywhere relative to each other (a force layout, not a fixed
 * top-down/left-right hierarchy), so a fixed per-side Handle is the wrong
 * idiom: with only top/bottom/left/right attachment points, an edge between
 * two nodes that end up diagonal to each other either picks a visually
 * arbitrary handle or crosses through the node body. Instead, each node
 * exposes exactly one (invisible, centered) source and target handle, and
 * the edge computes its own endpoints as the intersection of the
 * source-center -> target-center line with each node's rectangle boundary
 * — recomputed every render, so it stays correct as nodes are dragged.
 */

function nodeCenterAndSize(node: InternalNode<Node>) {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? node.width ?? 140;
  const height = node.measured?.height ?? node.height ?? 40;
  return { x: x + width / 2, y: y + height / 2, width, height };
}

/** Where the line from `node`'s center towards `opposite`'s center crosses
 * `node`'s own rectangle boundary. */
function getNodeIntersection(node: InternalNode<Node>, opposite: InternalNode<Node>) {
  const { x: x2, y: y2, width, height } = nodeCenterAndSize(node);
  const { x: x1, y: y1 } = nodeCenterAndSize(opposite);

  const w2 = width / 2, h2 = height / 2;
  const xx1 = (x1 - x2) / (2 * w2) - (y1 - y2) / (2 * h2);
  const yy1 = (x1 - x2) / (2 * w2) + (y1 - y2) / (2 * h2);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1, yy3 = a * yy1;

  return { x: w2 * (xx3 + yy3) + x2, y: h2 * (-xx3 + yy3) + y2 };
}

export function getEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const sourcePoint = getNodeIntersection(source, target);
  const targetPoint = getNodeIntersection(target, source);
  return { sx: sourcePoint.x, sy: sourcePoint.y, tx: targetPoint.x, ty: targetPoint.y };
}
