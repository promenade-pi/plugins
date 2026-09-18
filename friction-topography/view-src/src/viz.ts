/**
 * Pure geometry and colour, with no React and no scene graph in it.
 *
 * Everything here is a function from data to a `BufferGeometry` or an RGB
 * triple, which keeps the R3F components in `Scene.tsx` down to placement and
 * lifecycle - and keeps the parts that are easy to get subtly wrong (ribbon
 * winding, tangent frames at a path's ends) in one place that can be reasoned
 * about on its own.
 *
 * Only standard materials are used anywhere in this plugin, and that is a
 * constraint rather than a preference: the frame may render through WebGPU or
 * through WebGL 2 (see `Scene.tsx`), and a hand-written GLSL `ShaderMaterial`
 * compiles on exactly one of those. So the surface's contour lines and colour
 * ramp are baked into a raster (`field.ts`), and every glowing thing here is
 * additively blended vertex colour, which behaves identically on both.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, NormalBlending, type Blending,
} from 'three';

import { EXTENT, gridToWorld, type HeightField } from './field';

export interface Vec3 { x: number; y: number; z: number }

/* ------------------------------------------------------------------ *
 * Palette.
 * ------------------------------------------------------------------ */

export interface Scheme {
  /** Scene background, top and bottom of the vertical gradient. */
  skyTop: string;
  skyBottom: string;
  /** The plate the terrain sits on. */
  plate: string;
  plateEdge: string;
  /** Stream colours by duration rank, fastest to slowest. */
  flowFast: string;
  flowMid: string;
  flowSlow: string;
  /** Rework (backward flow). */
  rework: string;
  /** The illuminated route of one selected case. */
  route: string;
  routeHead: string;
  /** Station rings, by relief. */
  stationLow: string;
  stationHigh: string;
  /** Grid, axis and text. */
  axis: string;
  ink: string;
  panel: string;
  panelBorder: string;
}

export const SCHEMES: Record<'topographic' | 'relief', Scheme> = {
  topographic: {
    skyTop: '#080d15',
    skyBottom: '#04070c',
    plate: '#0a1018',
    plateEdge: '#22303f',
    flowFast: '#4fc8ff',
    flowMid: '#7ee0c8',
    flowSlow: '#ffa53a',
    rework: '#ff5a47',
    route: '#ffb757',
    routeHead: '#fff3d6',
    stationLow: '#63d2ff',
    stationHigh: '#ffb04a',
    axis: '#7e8fa3',
    ink: '#e8eef6',
    panel: 'rgba(11,16,24,0.82)',
    panelBorder: 'rgba(120,150,180,0.28)',
  },
  relief: {
    skyTop: '#eef2f6',
    skyBottom: '#dfe6ed',
    plate: '#cbd5de',
    plateEdge: '#8fa2b2',
    flowFast: '#1f7fc4',
    flowMid: '#1f9e8a',
    flowSlow: '#d97a1f',
    rework: '#c53a2a',
    route: '#7b2fbe',
    routeHead: '#2b1240',
    stationLow: '#1f7fc4',
    stationHigh: '#b8431f',
    axis: '#5d6b78',
    ink: '#1b2530',
    panel: 'rgba(255,255,255,0.9)',
    panelBorder: 'rgba(40,60,80,0.2)',
  },
};

/** Stream colour from its duration rank among the kept flows. */
export function flowColor(scheme: Scheme, slowness: number, backward: boolean): Color {
  if (backward) return new Color(scheme.rework);
  const fast = new Color(scheme.flowFast);
  const mid = new Color(scheme.flowMid);
  const slow = new Color(scheme.flowSlow);
  return slowness < 0.5
    ? fast.clone().lerp(mid, slowness * 2)
    : mid.clone().lerp(slow, (slowness - 0.5) * 2);
}

export function stationColor(scheme: Scheme, relief: number): Color {
  return new Color(scheme.stationLow).lerp(new Color(scheme.stationHigh), Math.min(1, relief));
}

/* ------------------------------------------------------------------ *
 * Terrain.
 * ------------------------------------------------------------------ */

/**
 * A grid mesh whose vertices land exactly on the height field's cells.
 *
 * Built by hand rather than by displacing a `PlaneGeometry`: a plane has to be
 * rotated into the XZ plane, which puts its vertex data in a rotated frame,
 * and every subsequent read of "the height at this vertex" then has to
 * remember that. Here y is height, full stop.
 */
export function terrainGeometry(field: HeightField, yScale: number): BufferGeometry {
  const { n, h } = field;
  const scale = 1 / field.scale;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);

  for (let z = 0; z < n; z++) {
    const wz = gridToWorld(z, n);
    for (let x = 0; x < n; x++) {
      const index = z * n + x;
      positions[index * 3] = gridToWorld(x, n);
      positions[index * 3 + 1] = h[index] * scale * yScale;
      positions[index * 3 + 2] = wz;
      uvs[index * 2] = x / (n - 1);
      uvs[index * 2 + 1] = z / (n - 1);
    }
  }

  const quads = (n - 1) * (n - 1);
  const indices = quads * 6 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let cursor = 0;
  for (let z = 0; z < n - 1; z++) {
    for (let x = 0; x < n - 1; x++) {
      const a = z * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Counter-clockwise seen from +y, so the surface faces up.
      indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
      indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ *
 * Ribbons.
 * ------------------------------------------------------------------ */

export interface RibbonOptions {
  /** Half-width at the centre of the ribbon, in world units. */
  halfWidth: number;
  color: Color;
  /**
   * Brightness of the ribbon's own centre line, relative to `color`. The outer
   * rails always fall to black, which under additive blending is the same as
   * transparent - that is how a soft-edged glow is achieved without a shader.
   */
  core?: number;
  /** Taper: 0 keeps full width to both ends, 1 comes to a point. */
  taper?: number;
  /**
   * Brightness at the outer rails, as a fraction of the centre's.
   *
   * Zero is the additive default: black rails contribute no light, which is
   * what gives a glow its soft edge. The ink model needs a value here instead
   * - a ramp from white to the colour and back puts almost all of the ribbon's
   * area at nearly no tint, so a printed flow drawn that way is a faint smudge.
   * A raised edge keeps the band's colour across most of its width and softens
   * only the last sliver.
   */
  edge?: number;
  /** Brightness along the ribbon, sampled at `t` in 0..1. */
  intensityAt?: (t: number) => number;
}

/**
 * How a flow is drawn, which is not the same question on the two palettes.
 *
 * On the dark plate a flow is *light*: additive blending puts it on top of the
 * terrain, and a black vertex contributes nothing, which is what gives the
 * ribbon its soft edge across its width with no shader and no sorting.
 *
 * On the light plate that is invisible - adding to near-white changes nothing -
 * so a flow becomes *ink*: a flat coloured band, blended normally, the way a
 * printed map draws a river. Flat rather than ramped on purpose: a soft edge
 * only reads against a dark ground.
 */
export function flowStyle(dark: boolean): {
  blending: Blending;
  /** Brightness at the ribbon's outer rails, as a fraction of the centre's. */
  edge: number;
  /** Whether a wide, faint outer glow is worth drawing at all. */
  halo: boolean;
  opacity: number;
  /** The glow's opacity, relative to the core's. */
  haloOpacity: number;
  /** How far the glow's colour is washed toward white before it is drawn. */
  haloWash: number;
} {
  /**
   * The light scheme is not the dark one with the background swapped.
   *
   * Additive blending is what makes the dark ribbons look the way they do:
   * they *add* light, so they glow through one another and fade out across
   * their width for free (the outer rails are black, and black adds nothing).
   * None of that survives on a white ground — adding to white is still white —
   * so the light scheme used to fall back to a near-opaque normal blend with
   * no falloff and, on top of that, 15% wider ribbons. The result read as
   * strips of tape laid over the terrain, hiding it.
   *
   * The honest light analogue of "adds light" is "lays down translucent ink":
   * a core at low opacity, so crossings build up and the terrain stays
   * visible, and a glow that is the colour washed most of the way to white
   * rather than most of the way to black. Same two elements, inverted for the
   * ground they sit on.
   */
  return dark
    ? { blending: AdditiveBlending, edge: 0, halo: true, opacity: 1, haloOpacity: 1, haloWash: 0 }
    : { blending: NormalBlending, edge: 1, halo: true, opacity: 0.7, haloOpacity: 0.32, haloWash: 0.62 };
}

/**
 * A flat ribbon following a draped path, as two quad strips sharing a bright
 * centre rail.
 *
 * The outer rails are black on purpose. Under `AdditiveBlending` a black
 * vertex contributes nothing, so the ribbon fades out across its width with no
 * transparency sorting and no alpha texture - and therefore looks the same on
 * both render backends.
 */
export function ribbonGeometry(path: Vec3[], options: RibbonOptions): BufferGeometry {
  const count = path.length;
  const geometry = new BufferGeometry();
  if (count < 2) return geometry;

  const core = options.core ?? 1;
  const taper = options.taper ?? 0;
  const rails = 3;
  const positions = new Float32Array(count * rails * 3);
  const colors = new Float32Array(count * rails * 3);
  const uvs = new Float32Array(count * rails * 2);
  // Uniform up-facing normals. The ribbon is drawn with an unlit basic
  // material, so the direction is never actually looked at - but three's
  // WebGPU node-material system builds a `normalView` node unconditionally,
  // and on at least some GPU/driver combinations a geometry with no `normal`
  // attribute at all makes it rebuild that node graph from scratch on every
  // single draw call rather than caching it once, which is both a flood of
  // "vertex attribute normal not found" console warnings and, far more
  // importantly, the shader recompilation is expensive enough on those
  // machines to visibly destabilise frame timing - which is what was
  // actually driving reports of the camera and labels jittering that never
  // reproduced on hardware where the warning is merely logged once.
  const normals = new Float32Array(count * rails * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;

  const tangent = { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(count - 1, i + 1)];
    tangent.x = next.x - prev.x;
    tangent.z = next.z - prev.z;
    const length = Math.hypot(tangent.x, tangent.z) || 1;
    // Left-hand normal in the ground plane; the ribbon lies flat on the
    // terrain, so it never needs a full 3D frame.
    const nx = -tangent.z / length;
    const nz = tangent.x / length;

    const t = count > 1 ? i / (count - 1) : 0;
    const endFade = taper > 0
      ? 1 - taper * Math.pow(1 - Math.min(1, Math.min(t, 1 - t) * 6), 2)
      : 1;
    const width = options.halfWidth * endFade;
    const intensity = (options.intensityAt ? options.intensityAt(t) : 1) * core;

    const here = path[i];
    for (let rail = 0; rail < rails; rail++) {
      const offset = (rail - 1) * width;
      const index = i * rails + rail;
      positions[index * 3] = here.x + nx * offset;
      positions[index * 3 + 1] = here.y;
      positions[index * 3 + 2] = here.z + nz * offset;
      const brightness = rail === 1 ? intensity : intensity * (options.edge ?? 0);
      colors[index * 3] = options.color.r * brightness;
      colors[index * 3 + 1] = options.color.g * brightness;
      colors[index * 3 + 2] = options.color.b * brightness;
      uvs[index * 2] = t;
      uvs[index * 2 + 1] = rail / (rails - 1);
    }
  }

  const segments = (count - 1) * (rails - 1);
  const indices = new Uint32Array(segments * 6);
  let cursor = 0;
  for (let i = 0; i < count - 1; i++) {
    for (let rail = 0; rail < rails - 1; rail++) {
      const a = i * rails + rail;
      const b = a + 1;
      const c = a + rails;
      const d = c + 1;
      indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
      indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
    }
  }

  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Serpentine lateral offset, used to draw a backward flow as a switchback
 * rather than as a straight line back through the mountain.
 *
 * Rework does not travel in a straight line through a process - it doubles
 * back - and drawing it as a hairpin trail is both closer to what happened and
 * much easier to distinguish from the forward flows it runs alongside.
 */
export function switchback(path: Vec3[], amplitude: number, turns: number): Vec3[] {
  const count = path.length;
  if (count < 3) return path;
  return path.map((point, i) => {
    const t = i / (count - 1);
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(count - 1, i + 1)];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const length = Math.hypot(tx, tz) || 1;
    // Fade the wiggle out at both ends so the trail still meets its stations.
    const envelope = Math.sin(Math.PI * t);
    const offset = amplitude * envelope * Math.sin(turns * Math.PI * t);
    return {
      x: point.x + (-tz / length) * offset,
      y: point.y,
      z: point.z + (tx / length) * offset,
    };
  });
}

/** Lifts a path into an arc over the terrain, for a flow that flies back. */
export function overpass(path: Vec3[], height: number): Vec3[] {
  const count = path.length;
  return path.map((point, i) => {
    const t = count > 1 ? i / (count - 1) : 0;
    return { ...point, y: point.y + height * Math.sin(Math.PI * t) };
  });
}

/** Total ground-plane length of a path, for spacing animated marks along it. */
export function pathLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
  }
  return total;
}

/**
 * Position and ground-plane heading at fraction `t` of a path.
 *
 * Parameterised by arc length, not by sample index: the paths here come from
 * `smoothPath`, which is only approximately evenly spaced, and a mark moving
 * by index visibly speeds up and slows down around every corner.
 */
export function pointAt(path: Vec3[], t: number): { position: Vec3; heading: number } {
  const clamped = Math.min(1, Math.max(0, t));
  const total = pathLength(path);
  if (path.length < 2 || total <= 0) {
    return { position: path[0] ?? { x: 0, y: 0, z: 0 }, heading: 0 };
  }
  let target = clamped * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (target > length && i < path.length - 1) { target -= length; continue; }
    const k = length > 0 ? Math.min(1, target / length) : 0;
    return {
      position: {
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        z: a.z + (b.z - a.z) * k,
      },
      heading: Math.atan2(b.x - a.x, b.z - a.z),
    };
  }
  const last = path[path.length - 1];
  return { position: last, heading: 0 };
}

/** The plate's footprint, a touch larger than the terrain it carries. */
export const PLATE_HALF = EXTENT * 1.015;
export const PLATE_DEPTH = 0.11;
