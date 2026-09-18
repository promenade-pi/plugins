/**
 * Invariants of the height field, over hand-picked and randomised plans.
 *
 * The terrain is the argument this view makes, so its claims have to be
 * checkable rather than eyeballed. A screenshot proves that *something*
 * rendered; it does not prove that the tallest thing on the map is the slowest
 * step in the log, and the two are easy to decouple by accident - a carve
 * radius one notch too generous is enough to sink a bottleneck below its
 * neighbours while every frame still looks like a plausible mountain range.
 *
 * Run by `npm run check`, which `package.sh` gates the build on.
 */
import {
  buildField, EXTENT, gridToWorld, graduation, RIM_START, sampleField, rampColor, RAMPS,
} from './field';
import { filterModel, edgeKey, type FilteredModel } from './model';
import type { Plan, PlanEdge, PlanNode } from './path';
import { PLAN_FIT, smoothPath } from './path';
import {
  defaultViewParams, elevationOf, frictionAt,
  type ActivityStat, type EdgeStat, type TopographyData,
} from './types';

// This file runs under plain node via `check.js`; @types/node is not a
// dependency of a browser-only bundle just for one exit code.
declare const process: { exit(code: number): void };

let failures = 0;
let checks = 0;

function ok(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

/* ------------------------------------------------------------------ *
 * A tiny deterministic PRNG, so a failure is reproducible from its seed.
 * ------------------------------------------------------------------ */
function rng(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

interface Case {
  name: string;
  model: FilteredModel;
  plan: Plan;
}

/** Builds a plan directly, bypassing ELK: this check runs under plain node. */
function makeCase(
  name: string,
  nodes: Array<{ activity: string; x: number; y: number; rank: number; relief: number }>,
  links: Array<{ source: string; target: string; volume: number }>
): Case {
  const planNodes: PlanNode[] = nodes.map((n) => ({
    activity: n.activity, x: n.x, y: n.y, rank: n.rank,
  }));
  const byActivity = new Map(planNodes.map((n) => [n.activity, n]));
  const rank = new Map(planNodes.map((n) => [n.activity, n.rank]));
  const edges: PlanEdge[] = links.map((l) => {
    const from = byActivity.get(l.source)!;
    const to = byActivity.get(l.target)!;
    return {
      source: l.source, target: l.target, key: edgeKey(l.source, l.target),
      points: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }],
      backward: to.rank < from.rank,
    };
  });

  const relief = new Map(nodes.map((n) => [n.activity, n.relief]));
  const friction = new Map(nodes.map((n) => [n.activity, n.relief * 1000]));
  const volume = new Map(links.map((l) => [edgeKey(l.source, l.target), l.volume]));
  const slowness = new Map(links.map((l) => [edgeKey(l.source, l.target), 0.5]));

  const activities: ActivityStat[] = nodes.map((n) => ({
    activity: n.activity, occurrences: 100, entities: 100, starts: 0, ends: 0, selfLoops: 0,
    medianWait: n.relief * 1000, p90Wait: n.relief * 2000, meanWait: n.relief * 1100,
    minWait: 0, maxWait: n.relief * 5000, totalWait: n.relief * 100000, reworkRate: 0,
    medianPos: n.rank + 1,
  }));
  const edgeStats: EdgeStat[] = links.map((l) => ({
    source: l.source, target: l.target, count: Math.round(l.volume * 1000),
    entities: Math.round(l.volume * 900), medianMs: 1000, p90Ms: 2000, totalMs: 100000,
  }));

  const model: FilteredModel = {
    activities, edges: edgeStats, selfLoops: new Map(), friction, relief, volume, slowness,
    isolated: [], maxFriction: 1000, edgeCoverage: 1, hiddenEdges: 0,
  };
  return { name, model, plan: { nodes: planNodes, edges, byActivity, rank, aspect: 1 } };
}

/** A straight chain with one tall step in the middle: the reference shape. */
function chainCase(seed: number, count: number, peakAt: number, volume: number): Case {
  const random = rng(seed);
  const nodes = Array.from({ length: count }, (_, i) => ({
    activity: `A${i}`,
    x: -PLAN_FIT + (2 * PLAN_FIT * i) / Math.max(1, count - 1),
    y: (random() - 0.5) * PLAN_FIT * 0.7,
    rank: i,
    relief: i === peakAt ? 1 : random() * 0.18,
  }));
  const links = nodes.slice(1).map((n, i) => ({
    source: nodes[i].activity, target: n.activity, volume,
  }));
  return makeCase(`chain(seed=${seed},n=${count},peak=${peakAt},v=${volume})`, nodes, links);
}

/**
 * A plan with arbitrary, possibly overlapping station positions.
 *
 * Nothing about the terrain may break on one of these - no NaN, no negative
 * height, no invented peak - but the *ordering* guarantee is deliberately not
 * asserted on them. Stations piled on top of each other genuinely share one
 * summit, and pretending otherwise would mean asserting something the
 * interpolation cannot and should not deliver.
 */
function arbitraryCase(seed: number): Case {
  const random = rng(seed);
  const count = 3 + Math.floor(random() * 14);
  const nodes = Array.from({ length: count }, (_, i) => ({
    activity: `A${i}`,
    x: (random() * 2 - 1) * PLAN_FIT,
    y: (random() * 2 - 1) * PLAN_FIT,
    rank: i,
    relief: random(),
  }));
  return makeCase(`arbitrary(seed=${seed},n=${count})`, nodes, randomLinks(nodes, random));
}

/**
 * A plan whose stations keep their distance, the way a layered layout's do.
 *
 * `layout.ts` asks ELK for 70px between stations in a column and 130px
 * between columns, over a plan normalised to span 2 units - so a real map's
 * stations are never closer than roughly a fifth of the plate. This generator
 * reproduces that constraint by rejection sampling, and it is the population
 * the ordering invariant is claimed over.
 */
function separatedCase(seed: number): Case {
  const random = rng(seed);
  const count = 3 + Math.floor(random() * 12);
  const minGap = 0.28;
  const nodes: Array<{ activity: string; x: number; y: number; rank: number; relief: number }> = [];
  let guard = 0;
  while (nodes.length < count && guard++ < 4000) {
    const x = (random() * 2 - 1) * PLAN_FIT;
    const y = (random() * 2 - 1) * PLAN_FIT;
    if (nodes.some((o) => Math.hypot(o.x - x, o.y - y) < minGap)) continue;
    nodes.push({ activity: `A${nodes.length}`, x, y, rank: nodes.length, relief: random() });
  }
  return makeCase(`separated(seed=${seed},n=${nodes.length})`, nodes, randomLinks(nodes, random));
}

function randomLinks(
  nodes: Array<{ activity: string }>, random: () => number
): Array<{ source: string; target: string; volume: number }> {
  const links: Array<{ source: string; target: string; volume: number }> = [];
  for (let i = 1; i < nodes.length; i++) {
    links.push({ source: nodes[i - 1].activity, target: nodes[i].activity, volume: 0.1 + random() * 0.9 });
  }
  const extra = Math.floor(random() * nodes.length);
  for (let k = 0; k < extra; k++) {
    const a = Math.floor(random() * nodes.length);
    const b = Math.floor(random() * nodes.length);
    if (a === b) continue;
    links.push({ source: nodes[a].activity, target: nodes[b].activity, volume: random() });
  }
  return links;
}

/* ------------------------------------------------------------------ *
 * The invariants.
 * ------------------------------------------------------------------ */

function checkWellFormed(c: Case, n: number): void {
  const field = buildField({ model: c.model, plan: c.plan, n });

  let finite = true;
  let negative = false;
  let max = 0;
  for (let i = 0; i < field.h.length; i++) {
    const value = field.h[i];
    if (!Number.isFinite(value)) finite = false;
    if (value < 0) negative = true;
    if (value > max) max = value;
  }
  ok(finite, `${c.name}: every height is finite`);
  ok(!negative, `${c.name}: no height is negative`);
  ok(max <= 2, `${c.name}: heights stay bounded (max ${max.toFixed(3)})`);
  ok(Math.abs(max - field.peak) < 1e-6, `${c.name}: reported peak equals the actual maximum`);

  // The rim window has to actually close, or the plate is cut off mid-slope.
  const rimSamples = [
    [-EXTENT, 0], [EXTENT, 0], [0, -EXTENT], [0, EXTENT],
    [-EXTENT, -EXTENT], [EXTENT, EXTENT],
  ] as const;
  for (const [x, z] of rimSamples) {
    ok(sampleField(field, x, z) < 1e-4, `${c.name}: terrain settles to zero at the rim (${x}, ${z})`);
  }
}

/**
 * The load-bearing claim: the terrain's summit is one of the log's slowest
 * steps, and no decisively slower step is drawn below a faster one.
 *
 * Stated as an ordering rather than an equality, because interpolation between
 * neighbours legitimately lifts a fast step that sits next to a slow one - that
 * regional blending is the whole reason for using a surface. What may never
 * happen is an *inversion*: a clearly slower step drawn lower than a clearly
 * faster one.
 *
 * The summit half is phrased on relief, not on identity: where two activities
 * are within a whisker of each other in friction, which of them wins the
 * summit by a hair is not a claim the view makes, and asserting it would be
 * asserting noise.
 */
function checkOrdering(c: Case, n: number, tolerance = 0.04): void {
  const field = buildField({ model: c.model, plan: c.plan, n });
  const scale = field.peak > 1e-9 ? 1 / field.peak : 1;
  const sampled = c.plan.nodes.map((node) => ({
    activity: node.activity,
    relief: c.model.relief.get(node.activity) ?? 0,
    height: sampleField(field, node.x, node.y) * scale,
  }));

  const maxRelief = Math.max(...sampled.map((s) => s.relief));
  const tallest = [...sampled].sort((a, b) => b.height - a.height)[0];
  ok(
    tallest.relief >= maxRelief - 0.1,
    `${c.name}: the summit is one of the slowest steps ` +
      `(summit ${tallest.activity} at relief ${tallest.relief.toFixed(3)}, max ${maxRelief.toFixed(3)})`
  );

  let inversions = 0;
  let worst = '';
  for (const a of sampled) {
    for (const b of sampled) {
      // Only pairs whose friction differs decisively; a small gap is noise
      // against neighbourhood blending and is not a claim the map makes.
      if (a.relief - b.relief < 0.35) continue;
      if (a.height < b.height - tolerance) {
        inversions++;
        worst = `${a.activity}(f=${a.relief.toFixed(2)},h=${a.height.toFixed(2)}) < ` +
          `${b.activity}(f=${b.relief.toFixed(2)},h=${b.height.toFixed(2)})`;
      }
    }
  }
  ok(inversions === 0, `${c.name}: no decisive friction pair is inverted (${inversions}; e.g. ${worst})`);
}

/**
 * The terrain never invents a bottleneck.
 *
 * The claim is specifically about the *summit*: the highest point on the plate
 * has to belong to a station, not to the open ground between two of them. An
 * analyst who cannot rely on this cannot use the map at all - a peak with
 * nothing under it is a false finding, and it would be an extremely
 * convincing-looking one.
 *
 * Skipped where the log has no relief to speak of: on a genuinely flat plate
 * the argmax is decided by the cosmetic crinkle, and asserting anything about
 * where it lands would be asserting noise.
 */
function checkNoInventedPeaks(c: Case, n: number): void {
  const reliefs = c.plan.nodes.map((node) => c.model.relief.get(node.activity) ?? 0);
  if (Math.max(...reliefs) - Math.min(...reliefs) < 0.2) return;

  const field = buildField({ model: c.model, plan: c.plan, n });
  let best = -1;
  let bx = 0;
  let bz = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const value = field.h[z * n + x];
      if (value > best) { best = value; bx = gridToWorld(x, n); bz = gridToWorld(z, n); }
    }
  }
  const nearest = Math.min(...c.plan.nodes.map((node) => Math.hypot(node.x - bx, node.y - bz)));
  ok(
    nearest < 0.22,
    `${c.name}: the summit belongs to a station (argmax is ${nearest.toFixed(3)} from the nearest)`
  );
}

/**
 * Anchored and monotone in the data: making one step slower raises the terrain
 * at that step, leaves every *other* station where it was, and dips nothing
 * anywhere by more than a cosmetic amount.
 *
 * This is what makes the metric switch and the sliders trustworthy. Station
 * anchoring is the sharp half: an activity's own altitude is its own
 * statistic, so a neighbour getting slower must not visibly raise or lower it.
 * Without that, "compare the map before and after the process change" - the
 * main thing anyone actually does with a performance map - quietly stops
 * working, because every reading depends on every other.
 */
function checkAnchoredMonotone(c: Case, n: number): void {
  const target = c.plan.nodes[Math.floor(c.plan.nodes.length / 2)];
  const before = c.model.relief.get(target.activity) ?? 0;
  if (before > 0.6) return; // No headroom to raise it into.

  const baseline = buildField({ model: c.model, plan: c.plan, n });
  const raisedModel: FilteredModel = {
    ...c.model,
    relief: new Map(c.model.relief).set(target.activity, Math.min(1, before + 0.3)),
  };
  const raised = buildField({ model: raisedModel, plan: c.plan, n });

  const own = {
    before: sampleField(baseline, target.x, target.y),
    after: sampleField(raised, target.x, target.y),
  };
  ok(
    own.after > own.before + 1e-3,
    `${c.name}: raising ${target.activity} raises its own ground ` +
      `(${own.before.toFixed(4)} -> ${own.after.toFixed(4)})`
  );

  let worstStation = 0;
  let worstName = '';
  for (const node of c.plan.nodes) {
    if (node.activity === target.activity) continue;
    // Stations sitting on top of the one being raised genuinely share its
    // ground; anchoring is a claim about distinguishable stations.
    if (Math.hypot(node.x - target.x, node.y - target.y) < 0.2) continue;
    const drift = Math.abs(
      sampleField(raised, node.x, node.y) - sampleField(baseline, node.x, node.y)
    );
    if (drift > worstStation) { worstStation = drift; worstName = node.activity; }
  }
  ok(
    worstStation < 0.035,
    `${c.name}: other stations stay anchored when ${target.activity} rises ` +
      `(worst drift ${worstStation.toFixed(4)} at ${worstName})`
  );

  let worstDip = 0;
  for (let i = 0; i < baseline.h.length; i++) {
    const dip = baseline.h[i] - raised.h[i];
    if (dip > worstDip) worstDip = dip;
  }
  ok(
    worstDip < 0.025,
    `${c.name}: no ground dips more than cosmetically (worst ${worstDip.toFixed(4)})`
  );
}

/**
 * A busy flow between two low-friction steps really does cut a channel: the
 * terrain on the route is lower than the terrain just beside it.
 */
function checkValley(): void {
  const nodes = [
    { activity: 'Start', x: -PLAN_FIT, y: 0, rank: 0, relief: 0.05 },
    { activity: 'End', x: PLAN_FIT, y: 0, rank: 1, relief: 0.05 },
    // A tall step well away from the route, so there is relief to carve into.
    { activity: 'Slow', x: 0, y: PLAN_FIT, rank: 2, relief: 1 },
  ];
  const busy = makeCase('valley/busy', nodes, [
    { source: 'Start', target: 'End', volume: 1 },
    { source: 'End', target: 'Slow', volume: 0.05 },
  ]);
  const quiet = makeCase('valley/quiet', nodes, [
    { source: 'Start', target: 'End', volume: 0.02 },
    { source: 'End', target: 'Slow', volume: 0.05 },
  ]);

  const n = 160;
  const busyField = buildField({ model: busy.model, plan: busy.plan, n });
  const quietField = buildField({ model: quiet.model, plan: quiet.plan, n });

  const onRoute = sampleField(busyField, 0, 0);
  const beside = (sampleField(busyField, 0, -0.3) + sampleField(busyField, 0, 0.3)) / 2;
  ok(onRoute < beside, `valley: a busy route sits below its own banks (${onRoute.toFixed(4)} < ${beside.toFixed(4)})`);

  const quietOnRoute = sampleField(quietField, 0, 0);
  ok(
    onRoute < quietOnRoute,
    `valley: more volume cuts deeper (${onRoute.toFixed(4)} < ${quietOnRoute.toFixed(4)})`
  );
}

/**
 * The rule that keeps a bottleneck visible: a high-friction step carrying the
 * log's busiest flow stays a peak instead of being carved flat by its own
 * traffic.
 *
 * This is the invariant a plausible-looking parameter tweak breaks, and
 * breaking it silently turns the view into a volume map with a colour ramp.
 */
function checkBottleneckSurvivesItsOwnTraffic(): void {
  const n = 160;
  for (const volume of [0.25, 0.6, 1]) {
    const c = chainCase(7, 5, 2, volume);
    const field = buildField({ model: c.model, plan: c.plan, n });
    const scale = 1 / Math.max(1e-9, field.peak);
    const peakNode = c.plan.byActivity.get('A2')!;
    const here = sampleField(field, peakNode.x, peakNode.y) * scale;
    const others = c.plan.nodes
      .filter((node) => node.activity !== 'A2')
      .map((node) => sampleField(field, node.x, node.y) * scale);
    const tallestOther = Math.max(...others);
    ok(
      here > tallestOther + 0.25,
      `traffic(v=${volume}): the busy bottleneck stays a clear peak ` +
        `(${here.toFixed(3)} vs ${tallestOther.toFixed(3)})`
    );
  }
}

/** Same input, same terrain: a reproducible map is a citable map. */
function checkDeterminism(): void {
  const c = arbitraryCase(4242);
  const a = buildField({ model: c.model, plan: c.plan, n: 128 });
  const b = buildField({ model: c.model, plan: c.plan, n: 128 });
  let identical = a.h.length === b.h.length;
  for (let i = 0; identical && i < a.h.length; i++) if (a.h[i] !== b.h[i]) identical = false;
  ok(identical, 'determinism: two builds of the same plan are bit-identical');
}

/** Detail level changes resolution, not the shape of the landscape. */
function checkDetailStability(): void {
  const c = chainCase(11, 6, 3, 0.8);
  const coarse = buildField({ model: c.model, plan: c.plan, n: 96 });
  const fine = buildField({ model: c.model, plan: c.plan, n: 240 });
  const coarseScale = 1 / Math.max(1e-9, coarse.peak);
  const fineScale = 1 / Math.max(1e-9, fine.peak);
  let worst = 0;
  for (const node of c.plan.nodes) {
    const a = sampleField(coarse, node.x, node.y) * coarseScale;
    const b = sampleField(fine, node.x, node.y) * fineScale;
    worst = Math.max(worst, Math.abs(a - b));
  }
  ok(worst < 0.12, `detail: activity elevations agree across resolutions (worst ${worst.toFixed(4)})`);
}

/** The plan's own polyline resampling keeps its endpoints and stays bounded. */
function checkPathResampling(): void {
  const points = [{ x: -1, y: -1 }, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  const smoothed = smoothPath(points, 0.02);
  ok(smoothed.length > points.length, 'path: resampling adds intermediate samples');
  ok(
    Math.hypot(smoothed[0].x - points[0].x, smoothed[0].y - points[0].y) < 1e-9,
    'path: the first point is preserved exactly'
  );
  const last = smoothed[smoothed.length - 1];
  ok(
    Math.hypot(last.x - points[3].x, last.y - points[3].y) < 1e-6,
    'path: the last point is preserved'
  );
  let maxGap = 0;
  for (let i = 1; i < smoothed.length; i++) {
    maxGap = Math.max(maxGap, Math.hypot(smoothed[i].x - smoothed[i - 1].x, smoothed[i].y - smoothed[i - 1].y));
  }
  ok(maxGap < 0.05, `path: samples stay evenly spaced (max gap ${maxGap.toFixed(4)})`);
  ok(smoothPath([{ x: 0, y: 0 }, { x: 0, y: 0 }], 0.02).length >= 2, 'path: a degenerate input still yields a path');
}

/** The colour ramp is total and monotone in the sense the legend claims. */
function checkRamp(): void {
  for (const name of Object.keys(RAMPS)) {
    const ramp = RAMPS[name];
    for (const t of [-1, 0, 0.001, 0.5, 0.999, 1, 2, NaN]) {
      const [r, g, b] = rampColor(ramp, t);
      const finite = [r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
      ok(finite, `ramp ${name}: t=${t} yields a valid colour`);
    }
    const low = rampColor(ramp, 0.02);
    const high = rampColor(ramp, 0.98);
    ok(
      name === 'relief' ? high[0] !== low[0] : high[0] > low[0],
      `ramp ${name}: the summit is distinguishable from the plains`
    );
  }
}

/**
 * The layout's fit and the terrain's rim window agree.
 *
 * `layout.ts` promises never to place a station outside `PLAN_FIT`; `field.ts`
 * promises full height inside `RIM_START * EXTENT`. If the first ever exceeds
 * the second, stations near the border are quietly pressed down by the window
 * and the map can name the wrong summit - which is precisely the failure the
 * randomised ordering check found when these two numbers were edited
 * independently.
 */
function checkPlanFitInsideRim(): void {
  ok(
    PLAN_FIT <= RIM_START * EXTENT - 0.02,
    `plan fit (${PLAN_FIT}) stays inside the rim window's flat radius ` +
      `(${(RIM_START * EXTENT).toFixed(3)})`
  );
}

/**
 * Graduations are round numbers, densely enough spaced to read, and they agree
 * with the elevation curve.
 */
function checkGraduation(): void {
  for (const max of [1, 37, 900, 14 * 3600_000, 0.42, 1e9, 0]) {
    for (const curve of ['linear', 'compressed'] as const) {
      const g = graduation(max, curve, 8);
      const label = `graduation(max=${max},${curve})`;
      ok(g.step > 0 && Number.isFinite(g.step), `${label}: the step is a positive number`);
      ok(
        g.ticks.length >= (max > 0 ? 2 : 1),
        `${label}: enough graduations to read (${g.ticks.length})`
      );
      ok(g.ticks.length <= 40, `${label}: not an unreadable thicket (${g.ticks.length})`);
      ok(g.ticks[0].value === 0 || max === 0, `${label}: the first graduation is the plains`);
      let ascending = true;
      for (let i = 1; i < g.ticks.length; i++) {
        if (g.ticks[i].value <= g.ticks[i - 1].value) ascending = false;
        if (g.ticks[i].altitude < g.ticks[i - 1].altitude) ascending = false;
      }
      ok(ascending, `${label}: values and altitudes both ascend`);
      ok(
        g.ticks.every((t) => t.altitude >= 0 && t.altitude <= 1.0001),
        `${label}: every altitude is on the terrain`
      );
      // The round-number rule: the step is 1, 2, 2.5 or 5 times a power of ten.
      const mantissa = g.step / Math.pow(10, Math.floor(Math.log10(g.step)));
      ok(
        [1, 2, 2.5, 5, 10].some((m) => Math.abs(mantissa - m) < 1e-9),
        `${label}: the step is a round number (mantissa ${mantissa})`
      );
    }
  }
}

/**
 * The elevation curve reorders nothing.
 *
 * `compressed` exists to make the lowlands readable, and it is only allowed to
 * do that by being strictly increasing: if it could swap two peaks, the map
 * would answer "which step is slowest" differently depending on a display
 * setting.
 */
function checkElevationCurve(): void {
  for (const curve of ['linear', 'compressed'] as const) {
    ok(Math.abs(elevationOf(0, curve)) < 1e-12, `curve ${curve}: the plains stay at zero`);
    ok(Math.abs(elevationOf(1, curve) - 1) < 1e-12, `curve ${curve}: the summit stays at one`);
    let monotone = true;
    let roundTrips = true;
    for (let i = 1; i <= 200; i++) {
      const a = elevationOf((i - 1) / 200, curve);
      const b = elevationOf(i / 200, curve);
      if (b <= a) monotone = false;
      if (Math.abs(frictionAt(b, curve) - i / 200) > 1e-9) roundTrips = false;
    }
    ok(monotone, `curve ${curve}: strictly increasing, so no peak overtakes another`);
    ok(roundTrips, `curve ${curve}: frictionAt inverts elevationOf`);
    ok(
      elevationOf(0.1, 'compressed') > elevationOf(0.1, 'linear'),
      'curve: compression lifts the lowlands'
    );
  }
}

/**
 * `filterModel` never strands an activity it decided to keep, however
 * aggressive the coverage cut: a summit nothing flows to is a map that lies.
 */
function checkFilterConnectivity(): void {
  const activities: ActivityStat[] = Array.from({ length: 12 }, (_, i) => ({
    activity: `A${i}`, occurrences: 1000 - i * 40, entities: 500, starts: 0, ends: 0, selfLoops: 0,
    medianWait: i * 100, p90Wait: i * 300, meanWait: i * 150, minWait: 0, maxWait: i * 900,
    totalWait: i * 10000, reworkRate: i / 24, medianPos: i + 1,
  }));
  const edges: EdgeStat[] = [];
  for (let i = 1; i < 12; i++) {
    // Steeply decaying volumes, so a 50% coverage cut drops most of the chain.
    edges.push({
      source: `A${i - 1}`, target: `A${i}`, count: Math.round(10000 / (i * i)),
      entities: 100, medianMs: 1000, p90Ms: 2000, totalMs: 5000,
    });
  }
  edges.push({ source: 'A5', target: 'A5', count: 400, entities: 200, medianMs: 10, p90Ms: 20, totalMs: 100 });
  const data: TopographyData = {
    overview: {
      entities: 500, events: 6000, activities: 12, medianCycleMs: 1000, p90CycleMs: 2000,
      firstMs: 0, lastMs: 1000, totalWaitMs: 999999,
    },
    activities, edges, objectCentric: false,
  };

  for (const coverage of [10, 40, 60, 92, 100]) {
    const model = filterModel(data, { ...defaultViewParams, edgeCoverage: coverage, maxActivities: 12 });
    ok(model.isolated.length === 0, `filter(coverage=${coverage}): no kept activity is stranded`);
    ok(
      model.selfLoops.get('A5') === 400,
      `filter(coverage=${coverage}): a self-loop is recorded rather than laid out`
    );
    ok(
      !model.edges.some((e) => e.source === e.target),
      `filter(coverage=${coverage}): no self-loop reaches the layout`
    );
    ok(
      model.edgeCoverage >= coverage / 100 - 1e-9,
      `filter(coverage=${coverage}): the kept edges cover at least what was asked`
    );
    for (const value of model.relief.values()) {
      ok(value >= 0 && value <= 1, `filter(coverage=${coverage}): relief stays normalised`);
    }
  }

  const capped = filterModel(data, { ...defaultViewParams, maxActivities: 5 });
  ok(capped.activities.length === 5, 'filter: the activity cap is respected');
  ok(
    capped.activities.every((a) => a.occurrences >= capped.activities[4].occurrences),
    'filter: the cap keeps the most frequent activities'
  );
}

/* ------------------------------------------------------------------ */

console.log('friction topography: field invariants');

checkPlanFitInsideRim();
checkPathResampling();
checkRamp();
checkGraduation();
 checkElevationCurve();
checkFilterConnectivity();
checkValley();
checkBottleneckSurvivesItsOwnTraffic();
checkDeterminism();
checkDetailStability();

// Hand-picked shapes first, then randomised plans: the fixed ones make a
// regression legible, the random ones find the case nobody thought of.
const fixtures: Case[] = [
  chainCase(1, 2, 0, 0.9),
  chainCase(2, 3, 1, 1),
  chainCase(3, 8, 7, 0.5),
  chainCase(5, 12, 6, 1),
  makeCase(
    'coincident',
    [
      { activity: 'A', x: 0, y: 0, rank: 0, relief: 1 },
      { activity: 'B', x: 0, y: 0, rank: 1, relief: 0 },
    ],
    [{ source: 'A', target: 'B', volume: 1 }]
  ),
  makeCase(
    'flat',
    [
      { activity: 'A', x: -0.5, y: 0, rank: 0, relief: 0 },
      { activity: 'B', x: 0.5, y: 0, rank: 1, relief: 0 },
    ],
    [{ source: 'A', target: 'B', volume: 1 }]
  ),
  makeCase(
    'single',
    [{ activity: 'Only', x: 0, y: 0, rank: 0, relief: 1 }],
    []
  ),
];

for (const c of fixtures) {
  checkWellFormed(c, 128);
  checkNoInventedPeaks(c, 128);
  if (c.name.startsWith('chain')) {
    checkOrdering(c, 160);
    checkAnchoredMonotone(c, 96);
  }
}

// Arbitrary placement: must not break, ordering not claimed.
for (let seed = 1; seed <= 25; seed++) {
  const c = arbitraryCase(seed * 977);
  checkWellFormed(c, 96);
  checkNoInventedPeaks(c, 96);
  checkAnchoredMonotone(c, 96);
}

// Layout-realistic placement: ordering is claimed and checked.
for (let seed = 1; seed <= 25; seed++) {
  const c = separatedCase(seed * 613 + 7);
  checkWellFormed(c, 96);
  checkNoInventedPeaks(c, 96);
  checkOrdering(c, 160);
}

console.log(`  ${checks - failures}/${checks} invariants held`);
if (failures > 0) {
  console.error(`${failures} invariant(s) violated`);
  process.exit(1);
}
