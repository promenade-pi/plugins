import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clipToRect, curvedPath, edgePath, orthogonalPath, pathLength, polylinePath,
  simplify, strokeWidth, trimToNodes, type Point, type Rect,
} from './geometry.ts';

const box: Rect = { x: 0, y: 0, width: 100, height: 40 };

function commands(path: string): string[] {
  return path.match(/[MLC]/g) ?? [];
}

/** Every point of a path's `M`/`L` commands. */
function vertices(path: string): Point[] {
  const out: Point[] = [];
  for (const match of path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)) {
    out.push({ x: Number(match[1]), y: Number(match[2]) });
  }
  return out;
}

test('clipToRect lands on the border, on the side it leaves through', () => {
  // Straight down: the bottom edge, half the height away.
  assert.deepEqual(clipToRect(box, { x: 0, y: 0 }, { x: 0, y: 200 }), { x: 0, y: 20 });
  // Straight right: the right edge, half the width away.
  assert.deepEqual(clipToRect(box, { x: 0, y: 0 }, { x: 500, y: 0 }), { x: 50, y: 0 });
  // Diagonal: whichever edge is reached first — here the top, not the side.
  const corner = clipToRect(box, { x: 0, y: 0 }, { x: -60, y: -60 });
  assert.equal(corner.y, -20);
  assert.equal(corner.x, -20);
});

test('clipToRect never overshoots a target inside the box', () => {
  const point = clipToRect(box, { x: 0, y: 0 }, { x: 4, y: 3 });
  assert.deepEqual(point, { x: 4, y: 3 });
});

test('clipToRect tolerates a zero-length segment', () => {
  assert.deepEqual(clipToRect(box, { x: 7, y: 9 }, { x: 7, y: 9 }), { x: 7, y: 9 });
});

test('simplify drops duplicates and collinear midpoints, keeping the ends', () => {
  const points = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }, { x: 40, y: 150 },
  ];
  assert.deepEqual(simplify(points), [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 40, y: 150 }]);
});

test('simplify keeps a genuine bend', () => {
  const points = [{ x: 0, y: 0 }, { x: 60, y: 50 }, { x: 0, y: 100 }];
  assert.equal(simplify(points).length, 3);
});

test('polylinePath emits one L per segment', () => {
  const path = polylinePath([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(commands(path), ['M', 'L', 'L']);
});

test('curvedPath starts and ends on the given points', () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 60 }, { x: -10, y: 120 }, { x: 5, y: 180 }];
  const path = curvedPath(points);
  assert.match(path, /^M 0 0 /);
  assert.match(path, / 5 180$/);
  assert.equal(commands(path).filter((c) => c === 'C').length, points.length - 1);
});

test('curvedPath degenerates to a straight line for two points', () => {
  assert.deepEqual(commands(curvedPath([{ x: 0, y: 0 }, { x: 1, y: 1 }])), ['M', 'L']);
});

test('orthogonalPath emits only axis-aligned segments', () => {
  const path = orthogonalPath([{ x: 0, y: 0 }, { x: 80, y: 100 }, { x: 30, y: 200 }]);
  const points = vertices(path);
  assert.ok(points.length >= 4);
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i].x - points[i - 1].x);
    const dy = Math.abs(points[i].y - points[i - 1].y);
    assert.ok(dx < 0.5 || dy < 0.5,
      `segment ${i} is neither horizontal nor vertical (dx=${dx}, dy=${dy})`);
  }
  // It still gets there.
  assert.deepEqual(points[points.length - 1], { x: 30, y: 200 });
});

test('orthogonalPath leaves an already-horizontal segment alone', () => {
  const path = orthogonalPath([{ x: 0, y: 0 }, { x: 90, y: 0 }]);
  assert.deepEqual(commands(path), ['M', 'L']);
});

test('edgePath dispatches on style and always reaches the last point', () => {
  const points = [{ x: 0, y: 0 }, { x: 40, y: 60 }, { x: 10, y: 120 }];
  for (const style of ['polyline', 'curved', 'orthogonal'] as const) {
    const path = edgePath(points, style);
    assert.ok(path.startsWith('M 0 0'), style);
    assert.ok(path.endsWith('10 120'), `${style}: ${path}`);
  }
});

test('trimToNodes pulls both ends onto their borders and leaves the middle', () => {
  const points = [{ x: 0, y: 0 }, { x: 0, y: 110 }, { x: 0, y: 220 }];
  const source: Rect = { x: 0, y: 0, width: 100, height: 40 };
  const target: Rect = { x: 0, y: 220, width: 100, height: 40 };
  const trimmed = trimToNodes(points, source, target);
  assert.deepEqual(trimmed[0], { x: 0, y: 20 });
  assert.deepEqual(trimmed[1], { x: 0, y: 110 });
  assert.deepEqual(trimmed[2], { x: 0, y: 200 });
  // The input is not mutated.
  assert.deepEqual(points[0], { x: 0, y: 0 });
});

test('trimToNodes without boxes is the identity', () => {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  assert.deepEqual(trimToNodes(points), points);
});

test('pathLength sums the segments', () => {
  assert.equal(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }]), 15);
  assert.equal(pathLength([{ x: 0, y: 0 }]), 0);
});

test('strokeWidth rises with frequency and a backbone is always thicker', () => {
  assert.ok(strokeWidth(100, 100, false) > strokeWidth(1, 100, false));
  assert.ok(strokeWidth(50, 100, true) > strokeWidth(50, 100, false));
  // Degenerate inputs still give a drawable width.
  for (const width of [strokeWidth(0, 0, false), strokeWidth(0, 10, false)]) {
    assert.ok(Number.isFinite(width) && width > 0);
  }
});
