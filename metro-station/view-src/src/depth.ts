/**
 * Seconds to world height, and the axis that makes the result readable.
 *
 * The payload carries durations, not heights, so this is where the drawing's
 * whole vertical dimension is decided — and it is deliberately the *only*
 * place, because switching between a linear and a logarithmic depth axis must
 * not move a single platform sideways. The plan stays exactly where it was;
 * only the building's storeys change height.
 *
 * Three things happen here, in order.
 *
 * 1. A raw curve maps a duration to a height. `linear` reads literally.
 *    `logarithmic` is the default because on a real process one two-day wait
 *    would otherwise press every minute-scale step into a single floor.
 *
 * 2. A **monotone refinement** walks the hand-offs in topological order and
 *    pushes a platform down until it is at least `MIN_GAP` below every
 *    platform that hands off to it. Without it, two steps a few seconds apart
 *    render at the same height under a logarithmic curve at the deep end, and
 *    a route between them is drawn dead level with no readable direction of
 *    travel. `added` reports exactly how much depth this bought, and
 *    `check.ts` holds it to a budget — a legibility fix allowed to run away
 *    would be a drawing that lies about its own axis.
 *
 * 3. The axis is then graduated through the *refined* mapping, not the raw
 *    one, by interpolating between the platforms' own (duration, height)
 *    pairs. So a tick reading "2 d" sits where two days actually is in this
 *    particular drawing, refinement included, rather than where it would have
 *    been in a drawing nobody is looking at.
 */
import type { Line, StationMap, ViewParams } from './types';
import { formatDuration } from './types';

/**
 * How deep the drawing is, as a fraction of how wide it is, before the relief
 * slider.
 *
 * Relative rather than absolute because the plan's own size is not fixed: a
 * nine-platform process is a dozen plan units across and a twenty-platform one
 * is thirty, and a constant height turns the second into a flat ribbon in
 * which the axis this plugin exists for is invisible. Two fifths is roughly
 * the proportion a station atlas draws a multi-level interchange at — enough
 * that a storey reads as a storey, not so much that the diagram becomes a
 * tower nobody can trace a route across.
 */
export const DEPTH_RATIO = 0.4;
/** Bounds on that, for a plan that is degenerate in one direction or another. */
const MIN_HEIGHT = 1.1;
const MAX_HEIGHT = 9;
/**
 * Smallest descent between two platforms, as a fraction of the drawing's own
 * depth.
 *
 * A fraction rather than a world constant, and capped again by the longest
 * chain of hand-offs (see `buildDepth`), because the two things this has to
 * satisfy pull against each other: a descent has to be *visible*, and every
 * descent in the longest chain has to *fit* inside one drawing. A fixed world
 * gap satisfies the first and, on a twenty-step process at a quarter of the
 * relief, quietly fails the second — the refinement then pushes the floor far
 * past the depth the slider asked for, and the axis is describing a drawing
 * nobody is looking at.
 */
const GAP_FRACTION = 0.035;
/** The most of a drawing's depth the refinement may account for. */
const GAP_TOTAL = 0.55;

export interface DepthTick {
  value: number;
  y: number;
  label: string;
}

export interface DepthBand {
  label: string;
  top: number;
  bottom: number;
}

export interface Depth {
  /** Refined world y per platform id. Zero at the top, negative downward. */
  y: Map<string, number>;
  /** Where a duration sits on this drawing's own axis. */
  at(seconds: number): number;
  /** The deepest y (a negative number). */
  floor: number;
  ticks: DepthTick[];
  bands: DepthBand[];
  unit: 'time' | 'steps';
  /**
   * The descent every forward hand-off is guaranteed, in world units. Smaller
   * than `GAP_FRACTION` of the depth where a long chain of hand-offs needed
   * the room, and this — not a constant — is what the invariant check holds
   * the drawing to.
   */
  gap: number;
  /**
   * The largest distance the monotone refinement moved any one platform from
   * where its own duration put it, in world units.
   *
   * The *maximum*, not the sum: a platform pushed down carries everything
   * below it, so adding the pushes up would count the same displacement once
   * per platform downstream of it and say the drawing was ten times deeper
   * than it is.
   */
  added: number;
  /** The refinement's budget; `added` above it is a defect, not a taste. */
  budget: number;
}

/** How far the plan reaches, when the caller has not measured it already. */
export function planSpan(map: StationMap): number {
  if (map.platforms.length === 0) return 1;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const platform of map.platforms) {
    minX = Math.min(minX, platform.x - platform.radius);
    maxX = Math.max(maxX, platform.x + platform.radius);
    minZ = Math.min(minZ, platform.z - platform.radius);
    maxZ = Math.max(maxZ, platform.z + platform.radius);
  }
  return Math.max(maxX - minX, maxZ - minZ, 1);
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 7 * DAY;

const TICK_CANDIDATES = [
  1, 5, 15, 30,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 3 * DAY, 5 * DAY,
  WEEK, 2 * WEEK, 4 * WEEK, 13 * WEEK, 26 * WEEK, 52 * WEEK,
];

const BANDS: Array<{ label: string; from: number; to: number }> = [
  { label: 'SECONDS', from: 0, to: MINUTE },
  { label: 'MINUTES', from: MINUTE, to: HOUR },
  { label: 'HOURS', from: HOUR, to: DAY },
  { label: 'DAYS', from: DAY, to: WEEK },
  { label: 'WEEKS', from: WEEK, to: Number.POSITIVE_INFINITY },
];

export function buildDepth(map: StationMap, params: ViewParams, span?: number): Depth {
  const scale = Math.max(0.05, Math.min(3, params.depthScale || 1));
  const across = span ?? planSpan(map);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, across * DEPTH_RATIO)) * scale;
  const maxT = Math.max(1e-9, map.stats.maxTimeSecs);
  const unit: Depth['unit'] = map.stats.hasTiming ? 'time' : 'steps';

  // The knee of the logarithmic curve: below it the axis is nearly linear,
  // above it nearly logarithmic. Derived from the data rather than fixed, so a
  // process measured in seconds and one measured in weeks both spend their
  // range on the part of the axis that has something in it — and deliberately
  // not *too* small, because a knee down at a thousandth of the deepest wait
  // gives a fifty-second hand-off a taller shaft than an eight-hour one.
  const knee = Math.max(1e-6, maxT / 500);
  // Everything below works in a unit drawing, -1 deep, and is scaled to world
  // units once at the very end. That is what lets the refinement overshoot and
  // still produce a drawing exactly as deep as the relief slider asked for.
  const raw = (t: number): number => {
    const clamped = Math.max(0, Math.min(maxT, t));
    if (params.timeScale === 'linear' || unit === 'steps') return -(clamped / maxT);
    return -(Math.log1p(clamped / knee) / Math.log1p(maxT / knee));
  };

  // ------------------------------------------------------------- refinement
  const forward: Line[] = map.lines.filter((line) => !line.backward && !line.selfLoop);
  const rank = new Map<string, number>();
  map.order.forEach((id, index) => rank.set(id, index));
  const ordered = [...forward].sort(
    (a, b) => (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0)
  );

  // The longest chain of hand-offs, which is how many gaps have to fit.
  const hops = new Map<string, number>();
  for (const id of map.order) hops.set(id, 0);
  for (const line of ordered) {
    const from = hops.get(line.source) ?? 0;
    if ((hops.get(line.target) ?? 0) < from + 1) hops.set(line.target, from + 1);
  }
  const chain = Math.max(1, ...hops.values());
  const gap = Math.min(GAP_FRACTION, GAP_TOTAL / chain);

  const y = new Map<string, number>();
  for (const platform of map.platforms) y.set(platform.id, raw(platform.t));
  for (const line of ordered) {
    const above = y.get(line.source);
    const below = y.get(line.target);
    if (above === undefined || below === undefined) continue;
    const wanted = above - gap;
    if (below > wanted) y.set(line.target, wanted);
  }

  // Renormalise, so the drawing is as deep as it was asked to be however far
  // the refinement had to push. A single uniform factor, so it cannot undo the
  // ordering or the gap — it only shrinks both, and `gap` below reports what
  // survived.
  let depth = 0;
  for (const value of y.values()) depth = Math.min(depth, value);
  const factor = (depth < -1 ? 1 / -depth : 1) * height;
  let added = 0;
  for (const platform of map.platforms) {
    const refined = (y.get(platform.id) ?? 0) * factor;
    added = Math.max(added, Math.abs(refined - raw(platform.t) * height));
    y.set(platform.id, refined);
  }

  let floor = 0;
  for (const value of y.values()) floor = Math.min(floor, value);

  // ------------------------------------------------------------------- axis
  // Built from the platforms' own (duration, height) pairs, so the axis
  // describes the drawing that exists rather than the one before refinement.
  const knots: Array<[number, number]> = [[0, 0]];
  for (const platform of map.platforms) knots.push([platform.t, y.get(platform.id) ?? 0]);
  knots.sort((a, b) => a[0] - b[0]);
  // Monotone by construction downward: a later duration can never be drawn
  // above an earlier one, whatever the refinement did to individual platforms.
  const curve: Array<[number, number]> = [];
  let deepest = 0;
  for (const [t, value] of knots) {
    const monotone = Math.min(deepest, value);
    deepest = monotone;
    const last = curve[curve.length - 1];
    if (last && Math.abs(last[0] - t) < 1e-9) curve[curve.length - 1] = [t, monotone];
    else curve.push([t, monotone]);
  }
  if (curve[curve.length - 1][0] < maxT) curve.push([maxT, floor]);

  const at = (seconds: number): number => {
    const t = Math.max(0, seconds);
    if (t <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      if (t <= curve[i][0]) {
        const [t0, y0] = curve[i - 1];
        const [t1, y1] = curve[i];
        const f = t1 - t0 < 1e-12 ? 1 : (t - t0) / (t1 - t0);
        return y0 + (y1 - y0) * f;
      }
    }
    return curve[curve.length - 1][1];
  };

  const ticks: DepthTick[] = [];
  if (unit === 'time') {
    const spacing = Math.abs(floor) * 0.085;
    for (const value of TICK_CANDIDATES) {
      if (value > maxT) break;
      const position = at(value);
      if (ticks.length && Math.abs(position - ticks[ticks.length - 1].y) < spacing) continue;
      ticks.push({ value, y: position, label: formatDuration(value) });
      if (ticks.length >= 6) break;
    }
  } else {
    const steps = Math.round(maxT);
    const every = Math.max(1, Math.ceil(steps / 5));
    for (let step = every; step <= steps; step += every) {
      ticks.push({ value: step, y: at(step), label: `${step} steps` });
    }
  }

  const bands: DepthBand[] = [];
  if (unit === 'time') {
    for (const band of BANDS) {
      if (band.from > maxT) continue;
      const to = Math.min(band.to, maxT);
      if (to <= band.from) continue;
      const top = at(band.from);
      const bottom = at(to);
      // A band thinner than a label is noise on the axis, not information.
      if (Math.abs(bottom - top) < Math.abs(floor) * 0.07) continue;
      bands.push({ label: band.label, top, bottom });
    }
  }

  return {
    y,
    at,
    floor,
    ticks,
    bands,
    unit,
    gap: gap * factor,
    added,
    // The refinement may account for a little over half the drawing's depth —
    // the whole of `GAP_TOTAL`, plus room for a curve that was already nearly
    // flat before it started. Past that it is not adjusting a drawing, it is
    // drawing something else.
    budget: height * (GAP_TOTAL + 0.1),
  };
}
