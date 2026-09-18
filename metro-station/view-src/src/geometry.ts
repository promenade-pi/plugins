/**
 * Geometry: plan polylines and durations in, three.js buffers out.
 *
 * Everything is built here rather than in the components so that the scene
 * graph stays declarative and so the shapes can be tested without a renderer.
 * Two decisions are worth knowing about:
 *
 * The **drop is part of the ribbon**, not a separate object. A route's path is
 * a 3D polyline in which the descent is two vertices at the same plan position
 * and different heights, so the ribbon that carries the coloured line simply
 * turns vertical for a moment — which is exactly what a station atlas draws
 * inside the glass of a lift shaft. The alternative, three unrelated meshes
 * per route, cannot be made to meet convincingly at the corners.
 *
 * A **chamfer, not a fillet.** The router emits right angles; a transit map
 * cuts them at 45°. Chamfering happens after the path is split at the drop, so
 * the drop corner itself stays square: that corner is a change of storey, not
 * a change of direction, and rounding it makes the descent look like a slide.
 */
import { BufferGeometry, CanvasTexture, Float32BufferAttribute } from 'three';

import type { Line, Pt } from './types';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Replaces each interior right angle with a 45° cut. */
export function chamfer(points: Pt[], cut: number): Pt[] {
  if (points.length < 3) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1];
    const here = points[i];
    const after = points[i + 1];
    const inLength = Math.hypot(here.x - before.x, here.z - before.z);
    const outLength = Math.hypot(after.x - here.x, after.z - here.z);
    const c = Math.min(cut, inLength * 0.48, outLength * 0.48);
    if (c < 1e-6 || inLength < 1e-9 || outLength < 1e-9) {
      out.push(here);
      continue;
    }
    out.push({
      x: here.x + ((before.x - here.x) / inLength) * c,
      z: here.z + ((before.z - here.z) / inLength) * c,
    });
    out.push({
      x: here.x + ((after.x - here.x) / outLength) * c,
      z: here.z + ((after.z - here.z) / outLength) * c,
    });
  }
  out.push(points[points.length - 1]);
  return out;
}

export interface PathOptions {
  /** World height of the route before the descent. */
  top: number;
  /** World height after it. */
  bottom: number;
  /** How wide a 45° cut to take out of each corner. */
  cut: number;
  /** A vertical drop, rather than a slope down the last stretch. */
  vertical: boolean;
}

/**
 * A route's drawn path in three dimensions.
 *
 * The returned `dropIndex` is the vertex the descent starts at; a shaft, a
 * staircase or nothing at all is drawn there depending on how far it falls.
 */
export function routePath(line: Line, options: PathOptions): { points: V3[]; dropIndex: number } {
  const { top, bottom, cut, vertical } = options;
  const plan = line.points;
  if (plan.length < 2) {
    return { points: plan.map((p) => ({ x: p.x, y: top, z: p.z })), dropIndex: 0 };
  }
  const at = Math.max(0, Math.min(plan.length - 2, line.dropAt));

  if (vertical) {
    const upper = chamfer(plan.slice(0, at + 1), cut);
    const lower = chamfer(plan.slice(at), cut);
    const points: V3[] = [
      ...upper.map((p) => ({ x: p.x, y: top, z: p.z })),
      ...lower.map((p) => ({ x: p.x, y: bottom, z: p.z })),
    ];
    return { points, dropIndex: upper.length - 1 };
  }

  // Ramp: one continuous path whose height eases across the descent, so the
  // route runs downhill into the platform instead of stepping.
  const smooth = chamfer(plan, cut);
  const anchor = plan[at];
  let nearest = 0;
  let best = Infinity;
  const lengths: number[] = [0];
  for (let i = 1; i < smooth.length; i++) {
    lengths.push(
      lengths[i - 1] + Math.hypot(smooth[i].x - smooth[i - 1].x, smooth[i].z - smooth[i - 1].z)
    );
  }
  smooth.forEach((p, i) => {
    const d = Math.hypot(p.x - anchor.x, p.z - anchor.z);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });
  const total = lengths[lengths.length - 1] || 1;
  const centre = lengths[nearest];
  const window = Math.max(total * 0.18, 0.22);
  const points = smooth.map((p, i) => {
    const f = clamp01((lengths[i] - (centre - window)) / (2 * window));
    const eased = f * f * (3 - 2 * f);
    return { x: p.x, y: top + (bottom - top) * eased, z: p.z };
  });
  return { points, dropIndex: nearest };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * An extruded ribbon along a 3D polyline: a top face and the two side walls
 * hanging off it, as separate geometries so they can take separate materials.
 *
 * The vertical stretch a descent introduces has no direction in plan, so its
 * cross-section is carried over from the last segment that did — which is why
 * a route entering a shaft keeps its width all the way down instead of
 * pinching to nothing at the corner.
 */
export function ribbon(
  path: V3[],
  halfWidth: number,
  thickness: number
): { top: BufferGeometry; side: BufferGeometry } {
  const n = path.length;
  const normals: Array<[number, number]> = new Array(n).fill(null).map(() => [0, 0]);
  const directions: Array<[number, number] | null> = new Array(n - 1).fill(null);
  for (let i = 0; i < n - 1; i++) {
    const dx = path[i + 1].x - path[i].x;
    const dz = path[i + 1].z - path[i].z;
    const length = Math.hypot(dx, dz);
    directions[i] = length < 1e-9 ? null : [dx / length, dz / length];
  }
  // Fill the plan-less (vertical) stretches from whichever side has one.
  for (let i = 0; i < directions.length; i++) {
    if (directions[i]) continue;
    let before = i - 1;
    while (before >= 0 && !directions[before]) before--;
    let after = i + 1;
    while (after < directions.length && !directions[after]) after++;
    directions[i] = directions[before] ?? directions[after] ?? [1, 0];
  }
  for (let i = 0; i < n; i++) {
    const a = directions[Math.max(0, i - 1)] ?? [1, 0];
    const b = directions[Math.min(directions.length - 1, i)] ?? a;
    const [ax, az] = [-a[1], a[0]];
    const [bx, bz] = [-b[1], b[0]];
    let mx = ax + bx;
    let mz = az + bz;
    const length = Math.hypot(mx, mz);
    if (length < 1e-6) {
      normals[i] = [ax, az];
    } else {
      // Miter, capped so a hairpin does not shoot a spike across the diagram.
      const scale = Math.min(2.4, 1 / Math.max(0.35, length / 2));
      normals[i] = [(mx / length) * scale, (mz / length) * scale];
    }
  }

  const topPositions: number[] = [];
  const sidePositions: number[] = [];
  const left = (i: number): V3 => ({
    x: path[i].x + normals[i][0] * halfWidth,
    y: path[i].y,
    z: path[i].z + normals[i][1] * halfWidth,
  });
  const right = (i: number): V3 => ({
    x: path[i].x - normals[i][0] * halfWidth,
    y: path[i].y,
    z: path[i].z - normals[i][1] * halfWidth,
  });
  const push = (into: number[], ...points: V3[]) => {
    for (const p of points) into.push(p.x, p.y, p.z);
  };
  const down = (p: V3): V3 => ({ x: p.x, y: p.y - thickness, z: p.z });

  for (let i = 0; i < n - 1; i++) {
    const l0 = left(i);
    const r0 = right(i);
    const l1 = left(i + 1);
    const r1 = right(i + 1);
    push(topPositions, l0, r0, r1, l0, r1, l1);
    if (thickness > 0) {
      const dl0 = down(l0);
      const dl1 = down(l1);
      const dr0 = down(r0);
      const dr1 = down(r1);
      push(sidePositions, l0, dl0, dl1, l0, dl1, l1);
      push(sidePositions, r1, dr1, dr0, r1, dr0, r0);
    }
  }
  if (thickness > 0 && n >= 2) {
    const capStart = [left(0), right(0)];
    const capEnd = [left(n - 1), right(n - 1)];
    push(sidePositions, capStart[1], capStart[0], down(capStart[0]));
    push(sidePositions, capStart[1], down(capStart[0]), down(capStart[1]));
    push(sidePositions, capEnd[0], capEnd[1], down(capEnd[1]));
    push(sidePositions, capEnd[0], down(capEnd[1]), down(capEnd[0]));
  }

  return { top: buffer(topPositions), side: buffer(sidePositions) };
}

function buffer(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A staircase between two heights: treads, risers, and the two side walls that
 * stop it reading as a floating zigzag from the side the camera is usually on.
 */
export function stairs(from: V3, to: V3, width: number, count: number): BufferGeometry {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const run = Math.hypot(dx, dz);
  if (run < 1e-6 || count < 1) return buffer([]);
  const ux = dx / run;
  const uz = dz / run;
  const nx = (-uz * width) / 2;
  const nz = (ux * width) / 2;
  const step = run / count;
  const rise = (to.y - from.y) / count;

  const positions: number[] = [];
  const quad = (a: V3, b: V3, c: V3, d: V3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  const at = (i: number, side: number, y: number): V3 => ({
    x: from.x + ux * step * i + nx * side,
    y,
    z: from.z + uz * step * i + nz * side,
  });

  for (let i = 0; i < count; i++) {
    const y = from.y + rise * i;
    const next = from.y + rise * (i + 1);
    // Tread.
    quad(at(i, 1, y), at(i, -1, y), at(i + 1, -1, y), at(i + 1, 1, y));
    // Riser, down to the next tread.
    quad(at(i + 1, 1, y), at(i + 1, -1, y), at(i + 1, -1, next), at(i + 1, 1, next));
    // The two flanks, so the flight is solid rather than a folded sheet.
    quad(at(i, 1, y), at(i + 1, 1, y), at(i + 1, 1, next), at(i, 1, next));
    quad(at(i, -1, next), at(i + 1, -1, next), at(i + 1, -1, y), at(i, -1, y));
  }
  return buffer(positions);
}

/**
 * The soft ellipse under a platform.
 *
 * A painted texture rather than a shadow map: the scene is an illustration,
 * one light, no occluders worth the cost — and a radial gradient is symmetric,
 * so it is also the one texture in this plugin that `flipY` cannot get wrong.
 */
export function shadowTexture(dark: boolean): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const ink = dark ? '0, 0, 0' : '30, 32, 40';
  gradient.addColorStop(0, `rgba(${ink}, ${dark ? 0.55 : 0.3})`);
  gradient.addColorStop(0.55, `rgba(${ink}, ${dark ? 0.22 : 0.12})`);
  gradient.addColorStop(1, `rgba(${ink}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/** Dashes along a straight run, as a flat pair list for `LineSegments`. */
export function dashedRun(
  from: V3,
  to: V3,
  dash: number,
  gap: number,
  into: number[]
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return;
  const step = dash + gap;
  for (let s = 0; s < length; s += step) {
    const a = s / length;
    const b = Math.min(1, (s + dash) / length);
    into.push(
      from.x + dx * a, from.y + dy * a, from.z + dz * a,
      from.x + dx * b, from.y + dy * b, from.z + dz * b
    );
  }
}
