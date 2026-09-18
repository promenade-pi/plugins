/**
 * The height field: how a table of per-activity friction becomes terrain.
 *
 * This is the whole semantic claim of the view, so it is written as one
 * explicit, testable function rather than as shader tricks:
 *
 *  1. **Elevation is interpolated friction.** Every activity contributes a
 *     Gaussian-weighted vote for the friction at each point of the plane
 *     (Shepard interpolation with a compact kernel), so the surface between
 *     two slow steps is itself high. That is the point of using a surface at
 *     all: a 2D model can colour a node, but it cannot show that a whole
 *     *region* of the process - a sub-chain, a department's worth of steps -
 *     is uniformly slow. On this map that region is a plateau, and an isolated
 *     slow step is a spike. Those look different at a glance; two red nodes do
 *     not.
 *
 *  2. **Volume carves valleys.** A busy flow cuts a channel along its route,
 *     deeper the busier it is. So the routine path through the process is
 *     literally the path of least resistance, and a case that leaves it is
 *     visibly climbing out of the riverbed.
 *
 *  3. **Carving is suppressed by friction.** The carve depth is scaled by
 *     `1 - friction`, which is what keeps a high-volume bottleneck a *ridge*
 *     rather than letting its own traffic flatten it. Without this the
 *     busiest step in the process - very often the slowest one too - would
 *     dig its own valley and disappear.
 *
 *  4. **Noise is proportional to height.** Plains stay smooth; peaks get
 *     ridges and gullies. This is cosmetic, but it is cosmetic in a way that
 *     encodes something: crinkle means altitude means friction.
 *
 * Everything is deterministic. The same log, metric and detail level produce
 * bit-identical terrain, so a screenshot in a report can be reproduced and two
 * analysts comparing notes are looking at the same mountain.
 */
import type { FilteredModel } from './model';
import { smoothPath, type Plan, type Point } from './path';
import { elevationOf, type ElevationCurve } from './types';

/**
 * Half-width of the terrain plane in world units.
 *
 * Sized to `PLAN_FIT` (`path.ts`) plus just enough skirt for the rim to taper
 * without a hard edge - not to some independently chosen round number. A
 * bigger `EXTENT` for the same content only ever adds dead, flat plate around
 * the outside; every other spatial constant here (`FRICTION_SIGMA`,
 * `STATION_SIGMA`, `CARVE_RADIUS`, the ribbon and station-ring sizes in
 * `viz.ts`) is tuned in absolute world units against station spacing under
 * `PLAN_FIT`, not against `EXTENT`, so this can be retuned on its own without
 * touching how any mountain actually looks.
 */
export const EXTENT = 0.9;

/** Baseline elevation of the plains, so a valley has something to cut into. */
const BASE = 0.13;
/** How deep the busiest flow cuts, in the same normalised units. */
const CARVE = 0.115;
/** Kernel radius for the regional friction field, in world units. */
const FRICTION_SIGMA = 0.21;
/**
 * Kernel radius of the per-station correction bump.
 *
 * Small enough that a station's own friction dominates its own summit, large
 * enough that the bump is a hill rather than a spike at every usable grid
 * resolution.
 */
const STATION_SIGMA = 0.1;
/** Kernel radius for valley carving, in world units, at full volume. */
const CARVE_RADIUS = 0.15;
/** Peak crinkle, as a fraction of local height. */
const NOISE = 0.24;
/** Spatial frequency of the crinkle, in cycles per world unit. */
const NOISE_FREQ = 8.5;
/**
 * Floor of the Shepard denominator.
 *
 * What makes the interpolated friction *decay* away from the stations instead
 * of extrapolating the nearest one outward forever - and therefore what
 * controls how broad a mountain's skirt is. Too small and one slow step floods
 * the whole plate with warm colour; too large and the terrain between two
 * genuinely slow neighbours drops away, which is the regional reading the
 * surface exists to give.
 */
const SHEPARD_FLOOR = 0.22;

export interface HeightField {
  /** Cells per side. */
  n: number;
  /** Row-major raw heights: plains at `BASE`, the summit at `BASE + 1`. */
  h: Float32Array;
  /** Interpolated friction before carving and noise, for texture shading. */
  friction: Float32Array;
  /** Carve strength 0..1, for tinting the riverbed. */
  carve: Float32Array;
  /**
   * Divisor that takes `h` to a 0..1 altitude.
   *
   * Deliberately the *nominal* summit (`BASE + 1`) and not the observed
   * maximum. Everything that has to agree with the surface - the graduated
   * pole, the contour levels, a draped ribbon - computes its own altitude from
   * a friction value without having a grid to look at, and it can only do that
   * if the mapping is a known constant rather than whatever the tallest cell
   * happened to come out at once the cosmetic crinkle was added.
   */
  scale: number;
  /** Observed maximum of `h`, for diagnostics and the invariant checks. */
  peak: number;
}

/**
 * Where a 0..1 friction altitude sits on the drawn surface.
 *
 * The single conversion between "how slow" and "how high", used by the
 * elevation pole, the contour levels and the terrain mesh alike.
 */
export function altitudeOf(elevation: number): number {
  return (BASE + Math.min(1, Math.max(0, elevation))) / (BASE + 1);
}

export function worldToGrid(value: number, n: number): number {
  return ((value + EXTENT) / (2 * EXTENT)) * (n - 1);
}
export function gridToWorld(index: number, n: number): number {
  return (index / (n - 1)) * 2 * EXTENT - EXTENT;
}

/** Bilinear sample of a row-major grid, clamped at the edges. */
export function sampleGrid(grid: ArrayLike<number>, n: number, x: number, z: number): number {
  const gx = Math.min(n - 1, Math.max(0, worldToGrid(x, n)));
  const gz = Math.min(n - 1, Math.max(0, worldToGrid(z, n)));
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(n - 1, x0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const a = grid[z0 * n + x0] as number;
  const b = grid[z0 * n + x1] as number;
  const c = grid[z1 * n + x0] as number;
  const d = grid[z1 * n + x1] as number;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function sampleField(field: HeightField, x: number, z: number): number {
  return sampleGrid(field.h, field.n, x, z);
}

/* ------------------------------------------------------------------ *
 * Deterministic value noise. Hash-based, so no state and no seeding
 * order to get wrong; the same coordinate always yields the same value.
 * ------------------------------------------------------------------ */

function hash2(ix: number, iz: number): number {
  let h = (ix | 0) * 374761393 + (iz | 0) * 668265263;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  // Quintic fade, so the interpolated field has continuous first and second
  // derivatives; a linear fade leaves visible grid creases under lighting.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  let fx = x;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(fx, fz);
    total += amplitude;
    amplitude *= 0.5;
    fx *= 2.03;
    fz *= 1.97;
  }
  return sum / total;
}

/** Smooth 0..1 ramp, the usual one. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-9)));
  return t * t * (3 - 2 * t);
}

/**
 * Rim window: the plate's terrain settles back to the plains at its border.
 *
 * Without it the surface is cut off mid-slope at the plate edge, which reads
 * as "the process continues past the edge of the picture" - a claim the log
 * does not make.
 */
/**
 * Fraction of `EXTENT` out to which the terrain is at full height. Beyond it
 * the rim window closes; see `RIM_START`'s use in `rimWindow`.
 */
export const RIM_START = 0.9;

function rimWindow(x: number, z: number): number {
  const rx = Math.abs(x) / EXTENT;
  const rz = Math.abs(z) / EXTENT;
  const r = Math.max(rx, rz);
  return 1 - smoothstep(RIM_START, 0.99, r);
}

/** Separable three-tap blur, in place, `passes` times. */
function blur(grid: Float32Array, n: number, passes: number): void {
  const tmp = new Float32Array(grid.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const left = grid[z * n + Math.max(0, x - 1)];
        const here = grid[z * n + x];
        const right = grid[z * n + Math.min(n - 1, x + 1)];
        tmp[z * n + x] = (left + here * 2 + right) * 0.25;
      }
    }
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const up = tmp[Math.max(0, z - 1) * n + x];
        const here = tmp[z * n + x];
        const down = tmp[Math.min(n - 1, z + 1) * n + x];
        grid[z * n + x] = (up + here * 2 + down) * 0.25;
      }
    }
  }
}

export interface FieldInput {
  model: FilteredModel;
  plan: Plan;
  n: number;
  /**
   * How a friction ratio becomes an altitude ratio. Applied to the station
   * values *before* interpolation, so a station's own altitude is still
   * exactly its own statistic put through the curve - the anchoring property
   * the ordering invariants depend on.
   */
  curve?: ElevationCurve;
}

export function buildField({ model, plan, n, curve = 'compressed' }: FieldInput): HeightField {
  const cells = n * n;
  const friction = new Float32Array(cells);
  const carve = new Float32Array(cells);

  // 1. The friction field, in two parts.
  //
  // The regional part is a Shepard interpolation: a convex combination of the
  // activities' friction, so it can never exceed the slowest activity in the
  // log. That property is worth more than it sounds - it means the terrain
  // cannot grow a mountain where no activity is slow, and an analyst can
  // trust that every summit on the map corresponds to something in the data.
  //
  // The local part corrects each station back toward its *own* friction.
  // Shepard alone lets a slow step that happens to sit among fast ones be
  // dragged down below a fast step surrounded by slow ones, which inverts the
  // one comparison the view exists to support (this is not hypothetical: the
  // randomised cases in `field.check.ts` found it). One compact bump per
  // station, of exactly the amount the regional field is off by, fixes that
  // without inventing any maximum away from a station.
  //
  // Sites closer together than a fraction of the correction radius are merged
  // first, keeping the higher friction. Two stations at (nearly) the same spot
  // genuinely share one piece of ground, and asking one bump to be at two
  // different heights at once is unsatisfiable - the correction passes would
  // oscillate and end up digging a pit exactly where the slower of the two
  // should be. `layout.ts` never places stations that close, so this is a
  // guard rather than a code path the real view exercises; keeping the *higher*
  // friction is the safe direction, because the alternative hides a
  // bottleneck.
  const sites: Array<{ x: number; z: number; value: number }> = [];
  const mergeRadius = STATION_SIGMA * 0.35;
  for (const node of plan.nodes) {
    const value = elevationOf(model.relief.get(node.activity) ?? 0, curve);
    const near = sites.find((s) => Math.hypot(s.x - node.x, s.z - node.y) < mergeRadius);
    if (near) near.value = Math.max(near.value, value);
    else sites.push({ x: node.x, z: node.y, value });
  }
  const invSigmaSq = 1 / (FRICTION_SIGMA * FRICTION_SIGMA);
  const invStationSq = 1 / (STATION_SIGMA * STATION_SIGMA);

  const regional = (wx: number, wz: number): number => {
    let weighted = 0;
    let weight = 0;
    for (const site of sites) {
      const dx = wx - site.x;
      const dz = wz - site.z;
      const w = Math.exp(-(dx * dx + dz * dz) * invSigmaSq);
      weighted += w * site.value;
      weight += w;
    }
    // The epsilon is what makes this decay to the plains far from every
    // activity instead of extrapolating the nearest one outward forever.
    return weighted / (weight + SHEPARD_FLOOR);
  };

  // Two passes: the first correction changes the field the second measures
  // against, and the residual after two is well inside the tolerance the
  // ordering invariant needs.
  const correction = new Float64Array(sites.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      let here = regional(site.x, site.z);
      for (let j = 0; j < sites.length; j++) {
        const dx = site.x - sites[j].x;
        const dz = site.z - sites[j].z;
        here += correction[j] * Math.exp(-(dx * dx + dz * dz) * invStationSq);
      }
      correction[i] += site.value - here;
    }
  }

  for (let z = 0; z < n; z++) {
    const wz = gridToWorld(z, n);
    for (let x = 0; x < n; x++) {
      const wx = gridToWorld(x, n);
      let value = regional(wx, wz);
      for (let i = 0; i < sites.length; i++) {
        const dx = wx - sites[i].x;
        const dz = wz - sites[i].z;
        value += correction[i] * Math.exp(-(dx * dx + dz * dz) * invStationSq);
      }
      // Clamped to the range the data actually spans: overlapping corrections
      // must not be allowed to push the surface past the slowest activity.
      friction[z * n + x] = value < 0 ? 0 : value > 1 ? 1 : value;
    }
  }
  blur(friction, n, 1);

  // 2. Valley carving, stamped rather than searched: for every sample of
  // every routed flow, splat a Gaussian brush and keep the maximum. Distance
  // to a polyline is what this approximates, and a brush is O(radius^2) per
  // sample instead of O(cells) per edge.
  const cellSize = (2 * EXTENT) / (n - 1);
  for (const edge of plan.edges) {
    const volume = model.volume.get(edge.key) ?? 0;
    if (volume <= 0.02) continue;
    const radius = CARVE_RADIUS * (0.45 + 0.55 * Math.sqrt(volume));
    const cellRadius = Math.max(1, Math.ceil(radius / cellSize));
    const invRadiusSq = 1 / (radius * radius);
    const path = smoothPath(edge.points, cellSize * 1.2);
    for (const point of path) {
      const cx = Math.round(worldToGrid(point.x, n));
      const cz = Math.round(worldToGrid(point.y, n));
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= n) continue;
        for (let dx = -cellRadius; dx <= cellRadius; dx++) {
          const gx = cx + dx;
          if (gx < 0 || gx >= n) continue;
          const wx = dx * cellSize;
          const wz = dz * cellSize;
          const strength = volume * Math.exp(-(wx * wx + wz * wz) * invRadiusSq * 2.2);
          const index = gz * n + gx;
          if (strength > carve[index]) carve[index] = strength;
        }
      }
    }
  }
  blur(carve, n, 1);

  // 3. Combine, window at the rim, then crinkle in proportion to altitude.
  const h = new Float32Array(cells);
  let peak = 0;
  for (let z = 0; z < n; z++) {
    const wz = gridToWorld(z, n);
    for (let x = 0; x < n; x++) {
      const wx = gridToWorld(x, n);
      const index = z * n + x;
      const f = friction[index];
      // `1 - f` is the rule that stops a bottleneck from digging itself flat.
      const cut = CARVE * carve[index] * (1 - Math.min(1, f));
      let value = (BASE + f - cut) * rimWindow(wx, wz);
      if (value < 0) value = 0;
      const crinkle = fbm(wx * NOISE_FREQ, wz * NOISE_FREQ) - 0.5;
      value *= 1 + NOISE * crinkle * smoothstep(0.1, 0.45, value);
      if (value < 0) value = 0;
      h[index] = value;
      if (value > peak) peak = value;
    }
  }

  return { n, h, friction, carve, scale: BASE + 1, peak };
}

/* ------------------------------------------------------------------ *
 * Surface colouring.
 * ------------------------------------------------------------------ */

export type Ramp = Array<[number, [number, number, number]]>;

/**
 * The topographic ramp: dark blue-black plains, blue lowlands, and a warm
 * ridge that runs orange to near-white at the summit.
 *
 * Blue-to-warm rather than a single hue because the eye reads a hue *change*
 * as a category boundary, and there genuinely is one here: below the
 * crossover a step is not a bottleneck, above it, it is.
 */
export const RAMPS: Record<string, Ramp> = {
  topographic: [
    [0.00, [6, 11, 19]],
    [0.10, [10, 22, 36]],
    [0.22, [15, 40, 66]],
    [0.32, [26, 66, 92]],
    [0.40, [46, 96, 112]],
    [0.47, [92, 74, 74]],
    [0.56, [143, 51, 32]],
    [0.68, [201, 83, 28]],
    [0.80, [236, 132, 32]],
    [0.90, [248, 181, 60]],
    [1.00, [255, 233, 168]],
  ],
  relief: [
    [0.00, [239, 243, 246]],
    [0.14, [214, 231, 238]],
    [0.28, [172, 210, 222]],
    [0.42, [176, 205, 178]],
    [0.54, [223, 205, 150]],
    [0.68, [223, 160, 96]],
    [0.82, [201, 92, 62]],
    [1.00, [122, 32, 30]],
  ],
};

export function rampColor(ramp: Ramp, t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i][0]) {
      const [t0, c0] = ramp[i - 1];
      const [t1, c1] = ramp[i];
      const k = (x - t0) / (t1 - t0 || 1e-9);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return ramp[ramp.length - 1][1];
}

export interface TextureOptions {
  size: number;
  palette: keyof typeof RAMPS;
  contours: boolean;
  /**
   * Contour lines as normalised heights, ascending.
   *
   * Explicit levels rather than one interval, because the elevation curve
   * (see `elevationOf`) makes even *value* steps land at uneven *height*
   * steps. Drawing them at even heights instead would put contour lines at
   * meaningless numbers, which is worse than having none: the whole point of
   * a contour is that it is an isoline of a quantity somebody can name.
   */
  levels: number[];
  /** Index within `levels` of the lines drawn heavier. */
  majorEvery?: number;
}

/**
 * Paints the surface into a canvas: colour ramp, contour lines, hillshade and
 * a cool tint in the riverbeds.
 *
 * Deliberately a raster rather than a custom shader. The frame's renderer may
 * be either WebGPU or WebGL 2 (see `scene/Renderer.tsx`), and a GLSL
 * `ShaderMaterial` silently does not compile on the WebGPU backend - a
 * texture and a standard material behave identically on both. It also means
 * the contour interval is chosen against the data in JS, where the number is
 * legible, instead of in a shader uniform.
 */
export function paintSurface(field: HeightField, options: TextureOptions): HTMLCanvasElement {
  const { size, contours } = options;
  const levels = options.levels ?? [];
  const majorEvery = Math.max(1, options.majorEvery ?? 5);
  /** Which contour band a height falls in: a binary search over the levels. */
  const bandOf = (value: number): number => {
    let lo = 0;
    let hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (levels[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const ramp = RAMPS[options.palette] ?? RAMPS.topographic;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const { n, h, carve } = field;
  const scale = 1 / field.scale;
  const step = 2 * EXTENT / (size - 1);

  // Hillshade from the analytic gradient of the sampled surface: cheap, and
  // it makes the contour spacing legible as slope rather than as decoration.
  const light = { x: -0.55, y: 0.62, z: -0.56 };

  for (let py = 0; py < size; py++) {
    const wz = -EXTENT + py * step;
    for (let px = 0; px < size; px++) {
      const wx = -EXTENT + px * step;
      const height = sampleGrid(h, n, wx, wz) * scale;
      const hx = sampleGrid(h, n, wx + step, wz) * scale - sampleGrid(h, n, wx - step, wz) * scale;
      const hz = sampleGrid(h, n, wx, wz + step) * scale - sampleGrid(h, n, wx, wz - step) * scale;
      // Surface normal of y = height(x, z), before normalising.
      const relief = 0.42;
      let nx = -hx * relief / (2 * step);
      let nz = -hz * relief / (2 * step);
      const len = Math.hypot(nx, 1, nz) || 1;
      nx /= len;
      nz /= len;
      const ny = 1 / len;
      const lambert = Math.max(0, nx * light.x + ny * light.y + nz * light.z);
      // Mild: the mesh carries the same relief and is really lit, so a strong
      // baked shade would darken every slope twice over. What this adds is the
      // sub-cell detail the 160-cell mesh cannot resolve.
      const shade = 0.8 + 0.32 * lambert;

      let [r, g, b] = rampColor(ramp, height);

      // A cool cast where flow has cut a channel, so a valley reads as a
      // riverbed even on the flat part of the plate.
      const wet = sampleGrid(carve, n, wx, wz);
      if (wet > 0.02) {
        const k = Math.min(0.5, wet * 0.5) * (1 - Math.min(1, height * 2.2));
        r += (28 - r) * k;
        g += (104 - g) * k;
        b += (150 - b) * k;
      }

      r *= shade;
      g *= shade;
      b *= shade;

      if (contours && levels.length > 0) {
        // A line wherever the band index changes between neighbouring texels:
        // automatically thin on flats and dense on steep ground, which is how
        // a topographic map encodes gradient for free.
        const band = bandOf(height);
        const bandX = bandOf(sampleGrid(h, n, wx + step, wz) * scale);
        const bandZ = bandOf(sampleGrid(h, n, wx, wz + step) * scale);
        if (band !== bandX || band !== bandZ) {
          const major = band % majorEvery === 0;
          const k = major ? 0.5 : 0.26;
          const tint = major ? 255 : 216;
          r += (tint - r) * k;
          g += (tint - g) * k;
          b += (tint * 0.94 - b) * k;
        }
      }

      const offset = (py * size + px) * 4;
      data[offset] = Math.max(0, Math.min(255, r));
      data[offset + 1] = Math.max(0, Math.min(255, g));
      data[offset + 2] = Math.max(0, Math.min(255, b));
      data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Paints the emissive companion to `paintSurface`: the same ramp, masked to
 * the high ground.
 *
 * This is what makes a ridge glow instead of merely being orange. Physically
 * it is nonsense - a slow activity does not emit light - but it is the visual
 * grammar of a heat map applied to a surface, and it is doing real work: an
 * emissive summit stays legible when the camera swings round to a shallow
 * angle where a lit-only surface falls into shadow exactly where the analyst
 * is looking.
 */
export function paintEmissive(field: HeightField, options: TextureOptions): HTMLCanvasElement {
  const { size } = options;
  const ramp = RAMPS[options.palette] ?? RAMPS.topographic;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const { n, h, carve } = field;
  const scale = 1 / field.scale;
  const step = 2 * EXTENT / (size - 1);

  for (let py = 0; py < size; py++) {
    const wz = -EXTENT + py * step;
    for (let px = 0; px < size; px++) {
      const wx = -EXTENT + px * step;
      const height = sampleGrid(h, n, wx, wz) * scale;
      const [r, g, b] = rampColor(ramp, height);
      // Ridges glow; so, faintly, do the riverbeds, which is what gives a
      // valley its cool inner light in a dark scene.
      const heat = smoothstep(0.42, 0.98, height);
      const wet = sampleGrid(carve, n, wx, wz) * (1 - smoothstep(0.2, 0.5, height)) * 0.34;
      const offset = (py * size + px) * 4;
      data[offset] = Math.min(255, r * heat + 18 * wet);
      data[offset + 1] = Math.min(255, g * heat + 92 * wet);
      data[offset + 2] = Math.min(255, b * heat + 140 * wet);
      data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface Graduation {
  /** The round value step between contours and axis ticks. */
  step: number;
  /** Ascending, one per graduation line: its value and where it sits. */
  ticks: Array<{ value: number; altitude: number }>;
}

/**
 * The single graduation the whole view shares: contour lines, axis ticks and
 * their labels.
 *
 * Computed once from the data and the elevation curve, so a contour on the
 * surface is always at the same value as the tick it lines up with on the
 * pole. Deriving them separately is how a 3D chart ends up with an axis that
 * quietly disagrees with the thing it is measuring.
 *
 * The step is a round number in the unit the user is reading (1, 2, 2.5 or 5
 * times a power of ten), so the labels beside the pole are "12h", not
 * "11.63h".
 */
export function graduation(
  maxFriction: number, curve: ElevationCurve, wanted = 8
): Graduation {
  const rough = Math.max(1e-9, maxFriction) / Math.max(1, wanted);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((c) => c >= rough)
    ?? 10 * magnitude;

  const ticks: Graduation['ticks'] = [];
  // The guard is against a pathological `maxFriction` (an all-zero metric)
  // turning this into an unbounded loop.
  for (let k = 0; k <= wanted * 4; k++) {
    const value = k * step;
    if (value > maxFriction * 1.0001) break;
    ticks.push({
      value,
      altitude: altitudeOf(elevationOf(value / Math.max(1e-9, maxFriction), curve)),
    });
  }
  // A metric that is zero everywhere (no rework at all, say) graduates to a
  // single line at zero, which is the truth. Anything else gets at least the
  // summit, so the axis always has a top.
  if (ticks.length < 2 && maxFriction > 0) ticks.push({ value: maxFriction, altitude: altitudeOf(1) });
  return { step, ticks };
}

/**
 * Lifts a plan-space polyline onto the surface.
 *
 * `lift` is a constant world-space offset above the terrain: a ribbon exactly
 * on the surface z-fights with it along its whole length, and the artefact
 * looks like a rendering bug rather than a river.
 */
export function drapePath(
  field: HeightField, points: Point[], yScale: number, lift: number
): Array<{ x: number; y: number; z: number }> {
  const scale = 1 / field.scale;
  return points.map((p) => ({
    x: p.x,
    y: sampleField(field, p.x, p.y) * scale * yScale + lift,
    z: p.y,
  }));
}
