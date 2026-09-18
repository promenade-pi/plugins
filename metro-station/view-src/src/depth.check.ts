/**
 * The view's own invariants: everything about the third dimension.
 *
 * The plan is already proved correct in Rust — no two routes share a line, no
 * platform sits on another, every hand-off descends *in seconds*. None of that
 * says the drawing descends in *world units*, which is a different claim and
 * the one the view is responsible for: a logarithmic axis at the deep end can
 * map two genuinely different durations onto the same height, and a route
 * drawn dead level has no readable direction of travel at all.
 *
 * Randomised inputs rather than fixtures, for the reason they always matter:
 * the fixture is the case that was in mind while the code was written.
 */
// Runs under node, not in the frame; `@types/node` is not a dependency of a
// browser bundle just for one call.
declare const process: { exit(code: number): never };

import { buildDepth, planSpan } from './depth';
import { chamfer, ribbon, routePath } from './geometry';
import { defaultViewParams, type Line, type Platform, type StationMap, type ViewParams } from './types';

let failures = 0;
function fail(message: string): void {
  failures++;
  if (failures <= 20) console.error(`  ✗ ${message}`);
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** A payload shaped like the kernel's, with the awkward parts on purpose. */
function synthetic(seed: number): StationMap {
  const random = rng(seed * 2654435761);
  const count = 3 + Math.floor(random() * 12);
  const timed = random() < 0.8;
  // A third of the graphs have a wait several orders of magnitude past the
  // rest of them, which is the case a linear axis cannot draw and the case a
  // logarithmic one flattens if the refinement is not there.
  const spike = random() < 0.34;
  const platforms: Platform[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const gap = !timed
      ? 1
      : random() < 0.3
        ? 0
        : random() * (spike && i === Math.floor(count / 2) ? 400_000 : 900);
    t += gap;
    platforms.push({
      id: `A${i}`,
      activity: `A${i}`,
      x: i * 1.5,
      z: 0,
      t,
      radius: 0.3,
      rank: i,
      lane: 0,
      objectTypes: ['T0'],
      counts: [1],
      count: 1,
      isStart: i === 0,
      isEnd: i === count - 1,
    });
  }
  const lines: Line[] = [];
  for (let i = 0; i + 1 < count; i++) {
    lines.push(line(`A${i}`, `A${i + 1}`, false));
    if (random() < 0.3 && i + 3 < count) lines.push(line(`A${i}`, `A${i + 3}`, false));
    if (random() < 0.2 && i > 1) lines.push(line(`A${i}`, `A${i - 2}`, true));
  }
  return {
    objectTypes: [{ name: 'T0', count: 10, route: platforms.map((p) => p.id) }],
    platforms,
    lines,
    shafts: [],
    order: platforms.map((p) => p.id),
    extent: { x: count * 1.5, z: 1 },
    stats: {
      activities: count,
      lines: lines.length,
      shafts: 0,
      objectTypes: 1,
      maxTimeSecs: timed ? t : count - 1,
      hasTiming: timed && t > 0,
      droppedActivities: 0,
      droppedEdges: 0,
      coverage: 1,
      basis: 'OCDFG',
    },
  };
}

function line(source: string, target: string, backward: boolean): Line {
  return {
    id: `${source}>${target}`,
    link: `${source}>${target}`,
    objectType: 'T0',
    source,
    target,
    freq: 10,
    waitSecs: 60,
    backward,
    selfLoop: false,
    critical: !backward,
    points: [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 2, z: 1 },
    ],
    dropAt: 2,
    ...(backward ? {} : {}),
  };
}

const SCALES: Array<Partial<ViewParams>> = [
  { timeScale: 'logarithmic', depthScale: 1 },
  { timeScale: 'linear', depthScale: 1 },
  { timeScale: 'logarithmic', depthScale: 0.25 },
  { timeScale: 'logarithmic', depthScale: 2.5 },
  { timeScale: 'linear', depthScale: 0.25 },
];

console.log('metro-station: view invariants');

// 1. Every forward hand-off descends by a visible amount, at every scale.
let maps = 0;
for (let seed = 1; seed <= 200; seed++) {
  const map = synthetic(seed);
  for (const patch of SCALES) {
    const params: ViewParams = { ...defaultViewParams, ...patch };
    const depth = buildDepth(map, params);
    maps++;
    for (const l of map.lines) {
      if (l.backward || l.selfLoop) continue;
      const above = depth.y.get(l.source)!;
      const below = depth.y.get(l.target)!;
      if (!(above - below >= depth.gap - 1e-9)) {
        fail(`seed ${seed} ${patch.timeScale}@${patch.depthScale}: ${l.id} descends ${(above - below).toFixed(5)}, guaranteed ${depth.gap.toFixed(5)}`);
      }
    }
    // 2. The refinement is a legibility fix, not a licence to invent depth.
    if (depth.added > depth.budget) {
      fail(`seed ${seed} ${patch.timeScale}: refinement added ${depth.added.toFixed(3)} over a budget of ${depth.budget.toFixed(3)}`);
    }
    // 3. The drawing is exactly as deep as the relief slider asked for, so
    //    the camera fit and the axis both describe the same object.
    const wanted = Math.min(9, Math.max(1.1, planSpan(map) * 0.4)) * (patch.depthScale ?? 1);
    if (map.stats.maxTimeSecs > 0 && Math.abs(Math.abs(depth.floor) - wanted) > 1e-6) {
      fail(`seed ${seed} ${patch.timeScale}@${patch.depthScale}: floor ${depth.floor.toFixed(4)}, wanted -${wanted.toFixed(4)}`);
    }
    // 4. The axis never goes back up, and stays inside the drawing.
    let previous = 1;
    for (let f = 0; f <= 1.0001; f += 0.02) {
      const y = depth.at(f * map.stats.maxTimeSecs);
      if (y > previous + 1e-9) fail(`seed ${seed}: axis rises at ${f.toFixed(2)}`);
      if (y < depth.floor - 1e-6) fail(`seed ${seed}: axis passes the floor at ${f.toFixed(2)}`);
      previous = y;
    }
    // 5. Ticks read downward and are inside the drawing.
    for (let i = 1; i < depth.ticks.length; i++) {
      if (!(depth.ticks[i].y <= depth.ticks[i - 1].y + 1e-9)) {
        fail(`seed ${seed}: tick ${depth.ticks[i].label} is above ${depth.ticks[i - 1].label}`);
      }
    }
    for (const tick of depth.ticks) {
      if (tick.y > 1e-9 || tick.y < depth.floor - 1e-6) fail(`seed ${seed}: tick ${tick.label} is off the axis`);
    }
  }
}

// 6. Chamfering keeps the ends and never wanders far from the original.
for (let seed = 1; seed <= 120; seed++) {
  const random = rng(seed * 40503);
  const points = [];
  let x = 0;
  let z = 0;
  for (let i = 0; i < 3 + Math.floor(random() * 6); i++) {
    if (i % 2 === 0) x += 0.2 + random() * 2;
    else z += (random() < 0.5 ? -1 : 1) * (0.2 + random() * 2);
    points.push({ x, z });
  }
  const cut = 0.14;
  const cutted = chamfer(points, cut);
  const first = cutted[0];
  const last = cutted[cutted.length - 1];
  if (first.x !== points[0].x || first.z !== points[0].z) fail(`chamfer ${seed}: moved the start`);
  if (last.x !== points[points.length - 1].x || last.z !== points[points.length - 1].z) {
    fail(`chamfer ${seed}: moved the end`);
  }
  for (const p of cutted) {
    const near = Math.min(...points.map((q) => Math.hypot(p.x - q.x, p.z - q.z)));
    if (near > cut + 1e-6) fail(`chamfer ${seed}: a vertex wandered ${near.toFixed(3)} from the path`);
  }
}

// 7. A vertical descent really is vertical, and the ribbon over it is finite.
for (let seed = 1; seed <= 120; seed++) {
  const map = synthetic(seed);
  const l = map.lines[0];
  if (!l) continue;
  const { points, dropIndex } = routePath(l, { top: 0, bottom: -0.8, cut: 0.12, vertical: true });
  const a = points[dropIndex];
  const b = points[dropIndex + 1];
  if (!a || !b) {
    fail(`route ${seed}: no descent in the path`);
  } else {
    if (Math.hypot(a.x - b.x, a.z - b.z) > 1e-9) fail(`route ${seed}: the descent moves sideways`);
    if (!(b.y < a.y - 1e-9)) fail(`route ${seed}: the descent does not descend`);
  }
  const ramp = routePath(l, { top: 0, bottom: -0.8, cut: 0.12, vertical: false });
  for (let i = 1; i < ramp.points.length; i++) {
    if (ramp.points[i].y > ramp.points[i - 1].y + 1e-9) fail(`ramp ${seed}: rises on the way down`);
  }
  const built = ribbon(points, 0.05, 0.03);
  for (const name of ['top', 'side'] as const) {
    const array = built[name].getAttribute('position').array as ArrayLike<number>;
    if (array.length === 0) fail(`ribbon ${seed}: empty ${name}`);
    for (let i = 0; i < array.length; i++) {
      if (!Number.isFinite(array[i])) {
        fail(`ribbon ${seed}: non-finite ${name} coordinate`);
        break;
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} violation(s)`);
  process.exit(1);
}
console.log(`  ✓ ${maps} depth maps, 120 chamfered paths, 120 ribbons — clean`);
