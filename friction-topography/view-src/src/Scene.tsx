/**
 * The scene: React Three Fiber components over the geometry in `viz.ts`.
 *
 * The renderer is three's `WebGPURenderer`, which targets WebGPU where the
 * browser offers it and falls back to its own WebGL 2 backend where it does
 * not - one code path, progressive enhancement for free. Every material here
 * is a standard one for exactly that reason; see `viz.ts`.
 *
 * Nothing in this file loads a subresource. The plugin frame runs under
 * `default-src 'none'` (see `app/src/ui/plugin-frame.html`), so there is no
 * font file for a 3D text label and no texture to fetch: labels are projected
 * DOM (`Labels.tsx`) and the only texture is a canvas painted in JS.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  CanvasTexture, Color, DoubleSide, InstancedMesh, Object3D, SRGBColorSpace, Vector3,
  type BufferGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGPURenderer } from 'three/webgpu';

import {
  drapePath, EXTENT, paintEmissive, paintSurface, sampleField,
  type Graduation, type HeightField,
} from './field';
import type { FilteredModel } from './model';
import { PLAN_FIT, smoothPath, type Plan } from './path';
import type { RouteStep } from './query';
import type { ViewParams } from './types';
import {
  flowColor, flowStyle, overpass, pathLength, PLATE_DEPTH, PLATE_HALF, pointAt,
  ribbonGeometry, stationColor, switchback, terrainGeometry, type Scheme, type Vec3,
} from './viz';

/** Height of the tallest peak, in world units, at vertical scale 1. */
export const RELIEF_HEIGHT = 0.82;

/** How far above the surface a ribbon floats, to stay out of a z-fight. */
const STREAM_LIFT = 0.006;
const ROUTE_LIFT = 0.022;

/**
 * Click-vs-drag threshold for the terrain.
 *
 * OrbitControls' own drag and this view's "select the station under the
 * pointer" both start from the same `pointerdown` on the same mesh, so
 * picking on `pointerdown` fires on every orbit gesture too - including one
 * that starts on open ground far from the previously selected peak, which
 * silently clears the selection the instant a drag begins. A real click
 * barely moves the pointer and releases promptly; anything past these
 * thresholds is the start (or middle) of a drag and must leave the current
 * selection alone.
 */
const CLICK_SLOP_PX = 6;
const CLICK_TIMEOUT_MS = 600;

export interface SceneModel {
  field: HeightField;
  plan: Plan;
  model: FilteredModel;
  scheme: Scheme;
  params: ViewParams;
  /** Draped, resampled stream paths, keyed by edge. */
  streams: StreamPath[];
  route: RoutePath | null;
  hovered: string | null;
  selected: string | null;
  /** Activities on the highlighted variant, if one is chosen. */
  variantPath: string[] | null;
}

export interface StreamPath {
  key: string;
  source: string;
  target: string;
  backward: boolean;
  volume: number;
  slowness: number;
  path: Vec3[];
}

export interface RoutePath {
  entity: string;
  label: string;
  path: Vec3[];
  /** Where each step of the case sits along the drawn path, 0..1. */
  marks: Array<{ t: number; step: RouteStep }>;
}

/** World-space y of the terrain at a plan position. */
export function terrainY(field: HeightField, x: number, z: number, yScale: number): number {
  return (sampleField(field, x, z) / field.scale) * yScale;
}

export function verticalScaleOf(params: ViewParams): number {
  return RELIEF_HEIGHT * Math.max(0.15, Math.min(3, params.verticalScale || 1));
}

/* ------------------------------------------------------------------ *
 * Draping: plan polylines onto the surface.
 * ------------------------------------------------------------------ */

export function buildStreams(
  field: HeightField, plan: Plan, model: FilteredModel, yScale: number
): StreamPath[] {
  return plan.edges.map((edge) => {
    const volume = model.volume.get(edge.key) ?? 0;
    const slowness = model.slowness.get(edge.key) ?? 0.5;
    const resampled = smoothPath(edge.points, 0.014);
    let path = drapePath(field, resampled, yScale, STREAM_LIFT);
    if (edge.backward) {
      // Rework flies back over the terrain on a switchback trail rather than
      // burrowing through whatever stands between the two steps.
      path = overpass(switchback(path, 0.055, 5), 0.075 * yScale + 0.03);
    }
    return { key: edge.key, source: edge.source, target: edge.target, backward: edge.backward, volume, slowness, path };
  });
}

/**
 * The illuminated route: one entity's actual sequence, drawn over the map.
 *
 * Where consecutive steps have a routed flow between them the route follows
 * it, so the case is seen travelling down the process's own valleys. Where
 * they do not - a hand-off rare enough to have been filtered out, or one this
 * log only ever shows once - it takes a lifted arc, which is the honest
 * drawing: this case went somewhere the map does not have a road for.
 */
export function buildRoute(
  field: HeightField, plan: Plan, steps: RouteStep[], entity: string, label: string, yScale: number
): RoutePath | null {
  const usable = steps.filter((step) => plan.byActivity.has(step.activity));
  if (usable.length < 1) return null;

  const segments: Vec3[][] = [];
  const stepAt: number[] = [];
  for (let i = 0; i < usable.length - 1; i++) {
    const from = usable[i];
    const to = usable[i + 1];
    const edge = plan.edges.find((e) => e.source === from.activity && e.target === to.activity);
    const a = plan.byActivity.get(from.activity)!;
    const b = plan.byActivity.get(to.activity)!;
    if (edge) {
      segments.push(drapePath(field, smoothPath(edge.points, 0.014), yScale, ROUTE_LIFT));
    } else if (from.activity === to.activity) {
      // A repeat in place: a small loop beside the station, so the route shows
      // the case going round again instead of standing still.
      const loop: Vec3[] = [];
      for (let k = 0; k <= 24; k++) {
        const angle = (k / 24) * Math.PI * 2;
        const x = a.x + Math.cos(angle) * 0.055;
        const z = a.y + Math.sin(angle) * 0.055 - 0.055;
        loop.push({ x, y: terrainY(field, x, z, yScale) + ROUTE_LIFT, z });
      }
      segments.push(loop);
    } else {
      const straight = smoothPath([{ x: a.x, y: a.y }, { x: b.x, y: b.y }], 0.02, 0);
      segments.push(overpass(drapePath(field, straight, yScale, ROUTE_LIFT), 0.06));
    }
  }
  if (segments.length === 0) {
    const only = plan.byActivity.get(usable[0].activity)!;
    const y = terrainY(field, only.x, only.y, yScale) + ROUTE_LIFT;
    segments.push([{ x: only.x, y, z: only.y }, { x: only.x + 1e-3, y, z: only.y }]);
  }

  const path: Vec3[] = [];
  const lengths = segments.map(pathLength);
  const total = lengths.reduce((s, v) => s + v, 0) || 1;
  let travelled = 0;
  segments.forEach((segment, i) => {
    stepAt.push(travelled / total);
    for (const point of segment) {
      const last = path[path.length - 1];
      if (last && Math.hypot(last.x - point.x, last.y - point.y, last.z - point.z) < 1e-6) continue;
      path.push(point);
    }
    travelled += lengths[i];
  });
  stepAt.push(1);

  const marks = usable.map((step, i) => ({ t: stepAt[Math.min(i, stepAt.length - 1)], step }));
  return { entity, label, path, marks };
}

/* ------------------------------------------------------------------ *
 * Components.
 * ------------------------------------------------------------------ */

function Terrain({
  scene, graduation, onPick, onHover,
}: {
  scene: SceneModel;
  graduation: Graduation;
  onPick: (x: number, z: number, shift: boolean) => void;
  onHover: (x: number | null, z: number) => void;
}) {
  const { field, params } = scene;
  const yScale = verticalScaleOf(params);

  // A pending press: recorded on pointerdown, resolved on the next window
  // 'pointerup' regardless of where the pointer ends up (OrbitControls can
  // carry it well outside the canvas). Comparing screen-space movement here,
  // rather than trusting a second raycast at release time, is what makes this
  // reliable through a drag that swings the camera around.
  const pending = useRef<{ x: number; y: number; time: number; worldX: number; worldZ: number; shift: boolean } | null>(null);

  useEffect(() => {
    const handleUp = (event: PointerEvent) => {
      const start = pending.current;
      pending.current = null;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const elapsed = performance.now() - start.time;
      if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX || elapsed > CLICK_TIMEOUT_MS) return;
      onPick(start.worldX, start.worldZ, start.shift);
    };
    window.addEventListener('pointerup', handleUp);
    return () => window.removeEventListener('pointerup', handleUp);
  }, [onPick]);

  const geometry = useMemo(() => terrainGeometry(field, yScale), [field, yScale]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * Painted terrain rasters, kept per palette.
   *
   * `paintSurface` and `paintEmissive` fill two 1024x1024 canvases (2048 on
   * `high`) a pixel at a time in JS — a couple of million ramp lookups, which
   * measures at 175-490ms on a small log and scales with the texture, not the
   * data. Keyed on `params.palette` alone, switching light -> dark -> light
   * paid that twice and threw the first result away, which is exactly the
   * round trip a user makes when comparing the two. Everything else about the
   * raster (the height field, the contour levels, the detail) is unchanged by
   * a palette switch, so the second visit can simply be handed back.
   *
   * Invalidated synchronously, inside the memo rather than in an effect: an
   * effect runs *after* the render that would already have served a stale
   * texture for the new field.
   */
  const rasterCache = useRef<{
    field: HeightField | null;
    key: string;
    entries: Map<string, { map: CanvasTexture; emissiveMap: CanvasTexture }>;
  }>({ field: null, key: '', entries: new Map() });

  const rasterKey = useMemo(
    () => JSON.stringify([params.terrainDetail, params.showContours, graduation.ticks.map((t) => t.altitude)]),
    [params.terrainDetail, params.showContours, graduation]
  );

  useEffect(() => () => {
    for (const entry of rasterCache.current.entries.values()) {
      entry.map.dispose();
      entry.emissiveMap.dispose();
    }
    rasterCache.current.entries.clear();
  }, []);

  const { map, emissiveMap } = useMemo(() => {
    const cache = rasterCache.current;
    if (cache.field !== field || cache.key !== rasterKey) {
      for (const entry of cache.entries.values()) { entry.map.dispose(); entry.emissiveMap.dispose(); }
      cache.entries.clear();
      cache.field = field;
      cache.key = rasterKey;
    }
    const cached = cache.entries.get(params.palette);
    if (cached) return cached;

    const size = params.terrainDetail === 'high' ? 2048 : 1024;
    const options = {
      size,
      palette: params.palette,
      contours: params.showContours,
      // The lowest graduation is the plains themselves, and a contour drawn
      // exactly at the height the flat ground sits at wanders through the
      // cosmetic crinkle as a meaningless squiggle across the whole plate.
      // It stays on the axis, where "0" is worth reading; it just is not a
      // line on the map.
      levels: graduation.ticks.slice(1).map((tick) => tick.altitude),
      majorEvery: 4,
    };
    const albedo = new CanvasTexture(paintSurface(field, options));
    albedo.colorSpace = SRGBColorSpace;
    albedo.anisotropy = 4;
    // `flipY` defaults to true, which is right for an image whose first row is
    // meant to be the *top* of the surface. This canvas's first row is grid row
    // zero, which is where the mesh's own `uv.y = 0` is, so flipping it lands
    // every contour line and every glow on the mirror image of the peak it
    // belongs to. Visible only as terrain that looks plausible and is wrong.
    albedo.flipY = false;
    const heat = new CanvasTexture(paintEmissive(field, options));
    heat.colorSpace = SRGBColorSpace;
    heat.flipY = false;
    const built = { map: albedo, emissiveMap: heat };
    cache.entries.set(params.palette, built);
    return built;
    // `graduation` reaches this through `rasterKey`, which is what the cache
    // is invalidated on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, rasterKey, params.palette, params.terrainDetail]);
  // No per-texture disposal here any more: a texture the cache still holds
  // must outlive the render that stopped using it. The cache disposes its own
  // entries when it is invalidated, and all of them on unmount (above).

  const dark = params.palette === 'topographic';

  return (
    <mesh
      geometry={geometry}
      receiveShadow={false}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        pending.current = {
          x: event.nativeEvent.clientX, y: event.nativeEvent.clientY, time: performance.now(),
          worldX: event.point.x, worldZ: event.point.z, shift: event.nativeEvent.shiftKey,
        };
      }}
      onPointerMove={(event: ThreeEvent<PointerEvent>) => {
        onHover(event.point.x, event.point.z);
      }}
      onPointerOut={() => onHover(null, 0)}
    >
      <meshStandardMaterial
        map={map}
        emissiveMap={emissiveMap}
        emissive={new Color(0xffffff)}
        emissiveIntensity={dark ? 0.26 : 0.1}
        roughness={0.86}
        metalness={0.04}
      />
    </mesh>
  );
}

/**
 * The plate's top face as four explicit segments.
 *
 * `LineLoop` would say this in half the vertices, but three's WebGPU renderer
 * rejects the object type outright ("Please use THREE.Line or
 * THREE.LineSegments"), and a primitive that only draws on one of the two
 * backends is exactly what the standard-materials-only rule exists to avoid.
 */
const PLATE_RIM = new Float32Array([
  -PLATE_HALF, 0, -PLATE_HALF, PLATE_HALF, 0, -PLATE_HALF,
  PLATE_HALF, 0, -PLATE_HALF, PLATE_HALF, 0, PLATE_HALF,
  PLATE_HALF, 0, PLATE_HALF, -PLATE_HALF, 0, PLATE_HALF,
  -PLATE_HALF, 0, PLATE_HALF, -PLATE_HALF, 0, -PLATE_HALF,
]);

/** The dark plate the terrain sits on, plus its lit rim. */
function Plate({ scheme }: { scheme: Scheme }) {
  return (
    <group>
      <mesh position={[0, -PLATE_DEPTH / 2 - 0.001, 0]}>
        <boxGeometry args={[PLATE_HALF * 2, PLATE_DEPTH, PLATE_HALF * 2]} />
        <meshStandardMaterial color={new Color(scheme.plate)} roughness={0.95} metalness={0.1} />
      </mesh>
      {/* A single bright line around the top face reads as a machined edge and
          gives the plate a definite size, which a dark box alone does not. */}
      <lineSegments position={[0, 0.0008, 0]}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[PLATE_RIM, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={new Color(scheme.plateEdge)} />
      </lineSegments>
    </group>
  );
}

function Streams({ scene }: { scene: SceneModel }) {
  const { streams, scheme, model, hovered, selected, variantPath, route } = scene;

  const onVariant = useMemo(() => {
    if (!variantPath || variantPath.length < 2) return null;
    const set = new Set<string>();
    for (let i = 0; i < variantPath.length - 1; i++) set.add(`${variantPath[i]} ${variantPath[i + 1]}`);
    return set;
  }, [variantPath]);

  const dark = scene.params.palette === 'topographic';
  const style = flowStyle(dark);
  const geometries = useMemo(() => {
    const built: Array<{ key: string; core: BufferGeometry; halo: BufferGeometry | null; color: Color }> = [];
    for (const stream of streams) {
      const color = flowColor(scheme, stream.slowness, stream.backward);
      // Same width in both schemes. The light one used to be 15% wider to
      // compensate for having no glow; it now has one, and the extra width
      // only ever added to the occlusion.
      const halfWidth = 0.012 + 0.052 * Math.sqrt(stream.volume);
      built.push({
        key: stream.key,
        core: ribbonGeometry(stream.path, {
          halfWidth, color, core: dark ? 0.72 : 0.9, taper: 0.55, edge: style.edge,
        }),
        halo: style.halo
          ? ribbonGeometry(stream.path, {
            halfWidth: halfWidth * 3.2,
            // Toward white on a light ground, toward black on a dark one:
            // either way the glow has to disappear into its background.
            color: style.haloWash > 0 ? color.clone().lerp(new Color('#ffffff'), style.haloWash) : color,
            core: dark ? 0.13 : 1,
            taper: 0.7,
          })
          : null,
        color,
      });
    }
    return built;
  }, [streams, scheme, dark, style.edge, style.halo, style.haloWash]);

  useEffect(() => () => {
    for (const g of geometries) { g.core.dispose(); g.halo?.dispose(); }
  }, [geometries]);

  return (
    <group>
      {geometries.map((entry) => {
        const stream = streams.find((s) => s.key === entry.key)!;
        const touched = hovered === stream.source || hovered === stream.target ||
          selected === stream.source || selected === stream.target;
        // Whenever *something* is picked out - a station, a variant, a case's
        // route - the rest of the network steps back. "Illuminated route" only
        // means anything if there is something for it to be brighter than.
        const focusing = selected != null || onVariant != null || route != null;
        const dimmed = focusing && !touched && !(onVariant?.has(entry.key) ?? false);
        const strength = dimmed ? 0.28 : touched || onVariant?.has(entry.key) ? 1.45 : 1;
        return (
          <group key={entry.key}>
            {entry.halo && (
              <mesh geometry={entry.halo}>
                <meshBasicMaterial
                  vertexColors
                  blending={style.blending}
                  transparent
                  depthWrite={false}
                  side={DoubleSide}
                  opacity={Math.min(1, style.haloOpacity * strength)}
                />
              </mesh>
            )}
            <mesh geometry={entry.core}>
              <meshBasicMaterial
                vertexColors
                blending={style.blending}
                transparent
                depthWrite={false}
                side={DoubleSide}
                opacity={style.opacity * Math.min(1, strength)}
              />
            </mesh>
          </group>
        );
      })}
      {/* Self-repetition has no route to draw, so it gets a ring at the
          station instead - a loop the analyst can see and hover. */}
      {[...model.selfLoops.entries()].map(([activity, count]) => {
        const node = scene.plan.byActivity.get(activity);
        if (!node) return null;
        const y = terrainY(scene.field, node.x, node.y, verticalScaleOf(scene.params));
        const radius = 0.05 + 0.035 * Math.min(1, count / Math.max(1, model.edges[0]?.count ?? 1));
        return (
          <mesh key={`loop-${activity}`} position={[node.x, y + 0.03, node.y - radius]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[radius * 0.82, radius, 40]} />
            <meshBasicMaterial
              color={new Color(scheme.rework)}
              blending={style.blending}
              transparent
              opacity={dark ? 0.55 : 0.5}
              depthWrite={false}
              side={DoubleSide}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Animated marks travelling along the streams.
 *
 * One `InstancedMesh` for every mark in the whole scene, moved on the CPU per
 * frame. A React component per case - or per mark - would be thousands of
 * reconciler nodes for something that is a single matrix update.
 */
function FlowMarks({ scene }: { scene: SceneModel }) {
  const { streams, scheme, params } = scene;
  const dark = params.palette === 'topographic';
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);

  const marks = useMemo(() => {
    const out: Array<{ path: Vec3[]; offset: number; speed: number; color: Color; size: number }> = [];
    for (const stream of streams) {
      const count = Math.max(1, Math.round(1 + stream.volume * 5));
      const color = flowColor(scheme, stream.slowness, stream.backward);
      const length = Math.max(0.05, pathLength(stream.path));
      for (let i = 0; i < count; i++) {
        out.push({
          path: stream.path,
          offset: i / count,
          // Slower flows crawl: the mark speed is a second, redundant encoding
          // of the same duration the colour shows, which is what makes a
          // sluggish hand-off noticeable out of the corner of the eye.
          speed: (0.16 + 0.3 * (1 - stream.slowness)) / length,
          color,
          size: 0.0075 + 0.01 * Math.sqrt(stream.volume),
        });
      }
    }
    return out;
  }, [streams, scheme, dark]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < marks.length; i++) mesh.setColorAt(i, marks[i].color);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [marks]);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh || marks.length === 0) return;
    const time = params.animateFlow ? state.clock.elapsedTime : 0;
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i];
      const t = (mark.offset + time * mark.speed) % 1;
      const { position, heading } = pointAt(mark.path, t);
      dummy.position.set(position.x, position.y + 0.004, position.z);
      dummy.rotation.set(-Math.PI / 2, 0, -heading);
      dummy.scale.setScalar(mark.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (marks.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, marks.length]}
      frustumCulled={false}
      /**
       * Drawn after the ribbons, always.
       *
       * A mark sits 4mm above the ribbon it travels on, and neither writes
       * depth. Under additive blending that is harmless — adding is
       * order-independent, so a mark shows through whatever was painted over
       * it. Under the light scheme's normal blending it is not: three sorts
       * transparent objects by distance, which for near-coplanar geometry is
       * effectively arbitrary, so *some* marks were painted over by their own
       * ribbon and some were not. Hence tokens that visibly went missing in
       * light and never did in dark. An explicit render order settles it.
       */
      renderOrder={10}
    >
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial
        vertexColors
        blending={flowStyle(dark).blending}
        transparent
        opacity={dark ? 0.75 : 0.6}
        depthWrite={false}
        side={DoubleSide}
      />
    </instancedMesh>
  );
}

/** Station markers: a ring on the ground, sized by how much traffic passes. */
function Stations({ scene }: { scene: SceneModel }) {
  const { plan, model, field, scheme, params, hovered, selected } = scene;
  const yScale = verticalScaleOf(params);
  const dark = params.palette === 'topographic';
  const busiest = Math.max(1, ...model.activities.map((a) => a.occurrences));

  return (
    <group>
      {plan.nodes.map((node) => {
        const stat = model.activities.find((a) => a.activity === node.activity);
        const relief = model.relief.get(node.activity) ?? 0;
        const y = terrainY(field, node.x, node.y, yScale);
        const weight = Math.sqrt((stat?.occurrences ?? 1) / busiest);
        const radius = 0.026 + 0.05 * weight;
        const active = hovered === node.activity || selected === node.activity;
        const raw = stationColor(scheme, relief);
        return (
          <group key={node.activity} position={[node.x, y + 0.012, node.y]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[radius * 0.55, radius, 48]} />
              <meshBasicMaterial
                color={raw}
                blending={flowStyle(dark).blending}
                transparent
                opacity={active ? 1 : 0.62}
                depthWrite={false}
                side={DoubleSide}
              />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
              <circleGeometry args={[radius * 0.42, 24]} />
              <meshBasicMaterial
                color={raw}
                blending={flowStyle(dark).blending}
                transparent
                opacity={active ? 0.95 : 0.5}
                depthWrite={false}
                side={DoubleSide}
              />
            </mesh>
            {active && (
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
                <ringGeometry args={[radius * 1.5, radius * 1.72, 48]} />
                <meshBasicMaterial
                  color={raw}
                  blending={flowStyle(dark).blending}
                  transparent
                  opacity={0.85}
                  depthWrite={false}
                  side={DoubleSide}
                />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

/** The selected case's route, and the arrowheads running along it. */
function Route({ scene }: { scene: SceneModel }) {
  const { route, scheme, params } = scene;
  const dark = params.palette === 'topographic';
  const headsRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const HEADS = 22;

  const geometries = useMemo(() => {
    if (!route || route.path.length < 2) return null;
    const color = new Color(scheme.route);
    return {
      core: ribbonGeometry(route.path, {
        halfWidth: dark ? 0.016 : 0.022, color, core: dark ? 1.5 : 1, edge: flowStyle(dark).edge,
      }),
      halo: flowStyle(dark).halo
        ? ribbonGeometry(route.path, { halfWidth: 0.075, color, core: 0.42 })
        : null,
    };
  }, [route, scheme, dark]);

  useEffect(() => () => {
    geometries?.core.dispose();
    geometries?.halo?.dispose();
  }, [geometries]);

  useFrame((state) => {
    const mesh = headsRef.current;
    if (!mesh || !route || route.path.length < 2) return;
    const speed = 0.09;
    for (let i = 0; i < HEADS; i++) {
      const t = (i / HEADS + state.clock.elapsedTime * speed) % 1;
      const { position, heading } = pointAt(route.path, t);
      dummy.position.set(position.x, position.y + 0.008, position.z);
      dummy.rotation.set(-Math.PI / 2, 0, -heading);
      // The marks pulse as they travel, which reads as motion even in a
      // screenshot-still frame and keeps the route legible where it crosses a
      // bright ridge.
      dummy.scale.setScalar(0.02 * (0.7 + 0.5 * Math.sin(t * Math.PI)));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (!route || !geometries) return null;
  return (
    <group>
      {geometries.halo && (
        <mesh geometry={geometries.halo}>
          <meshBasicMaterial
            vertexColors blending={flowStyle(dark).blending} transparent depthWrite={false} side={DoubleSide}
          />
        </mesh>
      )}
      <mesh geometry={geometries.core}>
        <meshBasicMaterial
          vertexColors blending={flowStyle(dark).blending} transparent depthWrite={false} side={DoubleSide}
        />
      </mesh>
      <instancedMesh ref={headsRef} args={[undefined, undefined, HEADS]} frustumCulled={false}>
        <coneGeometry args={[1, 2.2, 4]} />
        <meshBasicMaterial
          color={new Color(scheme.routeHead)}
          blending={flowStyle(dark).blending}
          transparent
          depthWrite={false}
        />
      </instancedMesh>
    </group>
  );
}

/**
 * The elevation axis: a graduated pole at the plate's near-left corner.
 *
 * In 3D rather than as a fixed 2D overlay, because the moment the camera turns
 * a flat scale bar down the side of the panel stops corresponding to anything.
 * A pole standing on the plate keeps its meaning from every angle, and it is
 * what makes the terrain readable as *quantities* rather than as a shape.
 */
/**
 * Half-extent of the box the axis pole (and the camera fit) treat as "where
 * the map is": just outside the radius every station is guaranteed to sit
 * within, rather than the physical plate's own corner.
 *
 * `PLAN_FIT` (`path.ts`) is already an absolute world-unit reach, directly
 * comparable to `EXTENT` - an earlier version of this multiplied the two
 * together, which is dimensionally meaningless (a length times a length) and
 * happened to produce a plausible-looking number purely because `EXTENT` was
 * close to 1. Moving the pole in from the plate's corner to here is most of
 * the fix for the empty gap between it and the nearest peak; fitting the
 * camera to the same box (see `fittingDistance`) is the rest.
 */
const AXIS_HALF = PLAN_FIT + 0.08;

function AxisPole({ scene, graduation }: { scene: SceneModel; graduation: Graduation }) {
  const { scheme, params } = scene;
  const yScale = verticalScaleOf(params);
  const x = -AXIS_HALF;
  const z = AXIS_HALF;
  const top = yScale * 1.06;

  const points = useMemo(() => {
    const out: number[] = [x, 0, z, x, top, z];
    graduation.ticks.forEach((tick, i) => {
      const y = tick.altitude * yScale;
      // Every fourth graduation is the major one, matching `majorEvery` in the
      // surface texture, so a long tick always meets a bright contour.
      const length = i % 4 === 0 ? 0.13 : 0.07;
      out.push(x, y, z, x + length, y, z + length);
    });
    return new Float32Array(out);
  }, [graduation, top, yScale, x, z]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={new Color(scheme.axis)} transparent opacity={0.95} />
    </lineSegments>
  );
}

/* ------------------------------------------------------------------ *
 * Camera, controls, and the bridge that positions the DOM labels.
 * ------------------------------------------------------------------ */

export interface CameraCommand {
  /** Monotonic counter; a change requests the move. */
  nonce: number;
  kind: 'reset' | 'top' | 'focus';
  target?: { x: number; y: number; z: number };
}

/**
 * The opening camera: an oblique three-quarter view, the angle that reads a
 * relief map best - low enough for the peaks to have height, high enough that
 * the near ridge does not hide the process behind it.
 */
const OBLIQUE = { azimuth: Math.PI * 0.25, polar: Math.PI * 0.35 };

/**
 * The distance at which the whole map is inside the frustum, exactly.
 *
 * Computed rather than tuned, because a docked panel is whatever shape the
 * user's layout leaves it: a distance that frames the terrain on a wide panel
 * crops the peaks off the top of a narrow one, and an analyst has no way to
 * know that the summit they are looking at is not the summit.
 *
 * For a camera at `target + d * dir` with basis (right, up, forward = -dir),
 * a point `q` measured from the target is inside the horizontal frustum when
 * `|q·right| <= (q·forward + d) * tan(hFov/2)`, i.e. when
 * `d >= |q·right| / tan(hFov/2) - q·forward`. The same holds vertically. So
 * the answer is the largest of those bounds over the corners of the content's
 * box - no magic margins, and it tracks the relief slider for free.
 */
function fittingDistance(
  fovDegrees: number, aspect: number, polar: number, azimuth: number, topY: number
): number {
  const vertical = (fovDegrees * Math.PI) / 180;
  const tanV = Math.tan(vertical / 2);
  const tanH = tanV * Math.max(0.25, aspect);

  const dir = {
    x: Math.sin(azimuth) * Math.sin(polar),
    y: Math.cos(polar),
    z: Math.cos(azimuth) * Math.sin(polar),
  };
  // Right is horizontal and perpendicular to the view direction; up completes
  // the frame. Both are unit vectors, and neither is degenerate for the polar
  // angles this view allows.
  const horizontal = Math.hypot(dir.x, dir.z) || 1e-6;
  const right = { x: dir.z / horizontal, y: 0, z: -dir.x / horizontal };
  const forward = { x: -dir.x, y: -dir.y, z: -dir.z };
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };

  const target = { x: 0, y: 0.12, z: 0 };
  let distance = 1.2;
  // Fit to where the content and the axis pole actually are (`AXIS_HALF`),
  // not to the physical plate's own corners (`PLATE_HALF`). The plate is
  // barely larger than the terrain, but every station is guaranteed to sit
  // well inside `PLAN_FIT` of it - fitting the whole slab zooms out far
  // enough to leave a wide, empty margin between the axis and the nearest
  // peak on every side. A disk of radius `AXIS_HALF` is fully contained in a
  // square of that half-side, so this still frames every station regardless
  // of angle; the plate's own far corners may fall just outside the frame,
  // which is a cosmetic pedestal edge, not the map.
  for (const cx of [-AXIS_HALF, AXIS_HALF]) {
    for (const cz of [-AXIS_HALF, AXIS_HALF]) {
      for (const cy of [0, topY]) {
        const q = { x: cx - target.x, y: cy - target.y, z: cz - target.z };
        const alongForward = q.x * forward.x + q.y * forward.y + q.z * forward.z;
        const lateral = Math.abs(q.x * right.x + q.y * right.y + q.z * right.z);
        const raised = Math.abs(q.x * up.x + q.y * up.y + q.z * up.z);
        distance = Math.max(distance, lateral / tanH - alongForward, raised / tanV - alongForward);
      }
    }
  }
  // A little air, so the frame edge does not sit exactly on a label.
  return distance * 1.05;
}

function Controls({
  command, mode, topY, onInteract,
}: {
  command: CameraCommand;
  mode: ViewParams['viewMode'];
  /** Height of the tallest thing that has to stay in frame. */
  topY: number;
  onInteract: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const controlsRef = useRef<OrbitControls | null>(null);
  const touched = useRef(false);

  // `onInteract` is an inline callback from the parent (it clears hover
  // state), so its identity changes on every render of that parent -
  // including the very renders hovering itself triggers. Reading it through a
  // ref, updated every render but never an effect dependency, means the
  // effect below only reruns when `camera`/`domElement` actually change, not
  // every time the mouse crosses a label.
  const onInteractRef = useRef(onInteract);
  onInteractRef.current = onInteract;

  useEffect(() => {
    const controls = new OrbitControls(camera, domElement as HTMLElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.85;
    controls.panSpeed = 0.9;
    // Pan across the ground rather than across the screen: dragging the map
    // should slide the terrain, which is what a map does.
    controls.screenSpacePanning = false;
    controls.minDistance = 0.9;
    controls.maxDistance = 11;
    // Just short of the horizon: level with the plate the terrain becomes a
    // line, and there is no way back without the reset button.
    controls.maxPolarAngle = Math.PI * 0.492;
    controls.minPolarAngle = 0.02;
    controls.target.set(0, 0.12, 0);
    controlsRef.current = controls;
    const notify = () => { touched.current = true; onInteractRef.current(); };
    controls.addEventListener('start', notify);
    return () => {
      controls.removeEventListener('start', notify);
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, domElement]);

  // Camera moves are applied imperatively: a declarative camera position would
  // fight OrbitControls for ownership of the same transform every frame.
  const aspect = size.height > 0 ? size.width / size.height : 1.6;
  const fov = (camera as { fov?: number }).fov ?? 33;
  /**
   * Quantised to steps of 5% before it ever reaches the re-fit effect below.
   *
   * `size` is this canvas's own pixel dimensions, and they are not only ever
   * set once: on a log heavy enough that the Inspector's activity list, the
   * "Fly to bottleneck" button and the rest of the chrome keep arriving over
   * several seconds, each such reflow can nudge the canvas by a few pixels,
   * which is enough to make this a *different floating-point number* on
   * every render even though nothing anyone would call "the panel was
   * resized" happened. An un-quantised `fit` treats that as a real reshape
   * and re-fires the effect that recentres the camera - visibly snapping the
   * view back to the default angle for a reason with nothing to do with
   * whatever the person looking at it was doing at the time. A real resize
   * (undocking a panel, dragging it to half width) changes aspect by far
   * more than 5% and still crosses the step without trouble.
   */
  const roundedAspect = Math.round(aspect * 20) / 20;
  const fit = useMemo(
    () => fittingDistance(fov, roundedAspect, OBLIQUE.polar, OBLIQUE.azimuth, topY),
    [fov, roundedAspect, topY]
  );

  // What the two effects below last actually moved the camera to, so the
  // resize-triggered one (immediately after) can tell "the fit genuinely
  // changed" from "this is the same fit the mount/command effect just
  // applied a moment ago" - without this, opening the panel runs both
  // effects back to back on the same `fit` value, which is harmless today
  // but is exactly the kind of coincidence that made the underlying bug here
  // hard to pin down in the first place.
  const lastAppliedFit = useRef<number | null>(null);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const distance = fit;
    lastAppliedFit.current = fit;
    if (command.kind === 'top') {
      controls.target.set(0, 0, 0);
      camera.position.set(0.0001, distance * 0.92, 0.0001);
    } else if (command.kind === 'focus' && command.target) {
      const { x, y, z } = command.target;
      controls.target.set(x, y, z);
      const distance = 1.7;
      camera.position.set(
        x + Math.sin(OBLIQUE.azimuth) * distance,
        y + Math.cos(OBLIQUE.polar) * distance * 1.5,
        z + Math.cos(OBLIQUE.azimuth) * distance
      );
    } else {
      controls.target.set(0, 0.12, 0);
      const { azimuth, polar } = OBLIQUE;
      camera.position.set(
        Math.sin(azimuth) * Math.sin(polar) * distance,
        Math.cos(polar) * distance,
        Math.cos(azimuth) * Math.sin(polar) * distance
      );
    }
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, command, fit]);

  /**
   * Re-fit when the panel is reshaped, but only until the user takes over -
   * and only for a change in `fit` big enough to actually be one.
   *
   * Dragging a docked panel narrower should not silently crop the map; having
   * it snap back to the opening view after the analyst has spent a minute
   * orbiting to a particular angle would be worse. The magnitude check is a
   * second line of defence behind the quantised `roundedAspect` above: `fit`
   * also moves a little whenever the *terrain* changes (a taller relief
   * slider, a different metric's peak), and none of that is "the panel was
   * resized" either.
   */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (touched.current || mode === 'top') return;
    if (lastAppliedFit.current != null && Math.abs(fit - lastAppliedFit.current) < 0.05) return;
    lastAppliedFit.current = fit;
    const distance = fit;
    const { azimuth, polar } = OBLIQUE;
    camera.position.set(
      Math.sin(azimuth) * Math.sin(polar) * distance,
      Math.cos(polar) * distance,
      Math.cos(azimuth) * Math.sin(polar) * distance
    );
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    // Top-down is a mode, not a one-off move: leaving rotation enabled would
    // let a stray drag tip the map over and silently leave the mode behind.
    controls.enableRotate = mode !== 'top';
    controls.maxPolarAngle = mode === 'top' ? 0.001 : Math.PI * 0.492;
    controls.minPolarAngle = mode === 'top' ? 0 : 0.02;
    controls.update();
  }, [mode]);

  useFrame(() => {
    controlsRef.current?.update();
  });
  return null;
}

export interface Anchor {
  id: string;
  world: [number, number, number];
}

export interface ProjectionSink {
  (
    projected: Array<{ id: string; x: number; y: number; depth: number }>,
    size: { width: number; height: number }
  ): void;
}

/**
 * Projects label anchors to screen space every frame and hands them to the DOM
 * overlay.
 *
 * Deliberately not React state: a `setState` per frame would re-render the
 * whole overlay sixty times a second. The sink writes `style.transform`
 * directly on nodes React already created and owns.
 */
function Projector({ anchors, sink }: { anchors: Anchor[]; sink: ProjectionSink }) {
  const scratch = useMemo(() => new Vector3(), []);
  useFrame((state) => {
    const { camera, size } = state;
    const out: Array<{ id: string; x: number; y: number; depth: number }> = [];
    for (const anchor of anchors) {
      scratch.set(anchor.world[0], anchor.world[1], anchor.world[2]);
      scratch.project(camera);
      out.push({
        id: anchor.id,
        x: (scratch.x * 0.5 + 0.5) * size.width,
        y: (-scratch.y * 0.5 + 0.5) * size.height,
        depth: scratch.z,
      });
    }
    sink(out, { width: size.width, height: size.height });
  });
  return null;
}

/* ------------------------------------------------------------------ *
 * The canvas.
 * ------------------------------------------------------------------ */

export interface TopographyViewProps {
  scene: SceneModel;
  anchors: Anchor[];
  sink: ProjectionSink;
  command: CameraCommand;
  graduation: Graduation;
  onPickPoint: (x: number, z: number, shift: boolean) => void;
  onHoverPoint: (x: number | null, z: number) => void;
  onInteract: () => void;
  onBackend: (backend: string) => void;
  /** The GPU device went away; the canvas is frozen until a new renderer is built. */
  onDeviceLost: (reason: string) => void;
}

export function TopographyView(props: TopographyViewProps) {
  const { scene } = props;
  const dark = scene.params.palette === 'topographic';

  return (
    // Keyed on the backend choice: a renderer is bound to its canvas for life,
    // so changing it has to build a new one rather than reconfigure this one.
    <Canvas
      key={scene.params.renderer}
      dpr={[1, 2]}
      gl={async (defaults) => {
        // `WebGPURenderer` picks WebGPU when `navigator.gpu` can give it an
        // adapter and initialises its own WebGL 2 backend when it cannot, so
        // the fallback is the renderer's business rather than this plugin's.
        // R3F awaits a promise returned from here, which is what makes the
        // required `await renderer.init()` possible at all.
        try {
          const renderer = new WebGPURenderer({
            canvas: defaults.canvas as HTMLCanvasElement,
            antialias: true,
            alpha: false,
            forceWebGL: scene.params.renderer === 'webgl2',
          });
          await renderer.init();
          const backend = renderer.backend as
            { isWebGPUBackend?: boolean; device?: { lost?: Promise<{ reason?: string; message?: string }> } } | undefined;
          /**
           * A lost GPU device leaves the canvas frozen on its last frame.
           *
           * Nothing throws and nothing unmounts: React keeps running, so the
           * HTML labels go on tracking the camera over a picture that will
           * never update again — which looks exactly like "only the labels
           * move". The renderer is bound to its canvas for life (see the
           * `key` above), so recovery means building a new one, and WebGL 2
           * is the backend to build it on: whatever cost WebGPU the device is
           * unlikely to go better the second time.
           */
          backend?.device?.lost?.then((info) => {
            props.onDeviceLost(info?.message || info?.reason || 'the GPU device was lost');
          }).catch(() => { /* a backend with no `lost` promise simply never reports one */ });
          props.onBackend(backend?.isWebGPUBackend === true ? 'WebGPU' : 'WebGL 2');
          return renderer as unknown as never;
        } catch (error) {
          // A frame with neither backend has nothing to say but so; the panel
          // reports it rather than showing an empty black rectangle.
          props.onBackend(`unavailable: ${(error as Error)?.message ?? error}`);
          throw error;
        }
      }}
      camera={{ fov: 33, near: 0.05, far: 60, position: [
        Math.sin(OBLIQUE.azimuth) * Math.sin(OBLIQUE.polar) * 4.2,
        Math.cos(OBLIQUE.polar) * 4.2,
        Math.cos(OBLIQUE.azimuth) * Math.sin(OBLIQUE.polar) * 4.2,
      ] }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <color attach="background" args={[scene.scheme.skyBottom]} />
      <hemisphereLight
        args={[new Color(scene.scheme.skyTop), new Color(scene.scheme.plate), dark ? 0.5 : 1.1]}
      />
      <directionalLight
        position={[-2.6, 3.4, -2.4]}
        intensity={dark ? 2.4 : 1.8}
        color={new Color(dark ? 0xdfe9ff : 0xffffff)}
      />
      {/* A warm counter-light from the low side, so the shaded faces of the
          ridges keep their hue instead of going flat black. */}
      <directionalLight position={[2.8, 0.9, 2.6]} intensity={dark ? 0.55 : 0.35} color={new Color(0xff8a4a)} />

      <Plate scheme={scene.scheme} />
      <Terrain scene={scene} graduation={props.graduation} onPick={props.onPickPoint} onHover={props.onHoverPoint} />
      {scene.params.showStreams && <Streams scene={scene} />}
      {scene.params.showStreams && <FlowMarks scene={scene} />}
      <Stations scene={scene} />
      <Route scene={scene} />
      <AxisPole scene={scene} graduation={props.graduation} />

      <Controls
        command={props.command}
        mode={scene.params.viewMode}
        topY={verticalScaleOf(scene.params) * 1.12 + 0.08}
        onInteract={props.onInteract}
      />
      <Projector anchors={props.anchors} sink={props.sink} />
    </Canvas>
  );
}

export { EXTENT, PLATE_HALF, AXIS_HALF };
