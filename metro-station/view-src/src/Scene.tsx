/**
 * The scene: React Three Fiber over the geometry in `geometry.ts`.
 *
 * The renderer is three's `WebGPURenderer`, which targets WebGPU where the
 * browser offers it and falls back to its own WebGL 2 backend where it does
 * not — one code path, progressive enhancement for free. Every material here
 * is a standard one for exactly that reason.
 *
 * Nothing in this file loads a subresource. The plugin frame runs under
 * `default-src 'none'` (see `app/src/ui/plugin-frame.html`), so there is no
 * font file for a 3D label and no image to fetch: labels are projected DOM
 * (`Labels.tsx`) and the only texture is a canvas painted in JS.
 *
 * The camera is a *narrow* perspective rather than an orthographic one. A true
 * isometric drawing is what the reference atlas is, but it also makes a
 * platform at the back indistinguishable from a small one at the front, and
 * the whole diagram turns on comparing platform sizes. Twenty degrees keeps
 * almost all of the parallel look and just enough convergence to read depth.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  Color, DoubleSide, InstancedMesh, NoToneMapping, Object3D, SRGBColorSpace, Vector3,
  type BufferGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGPURenderer } from 'three/webgpu';

import { buildShafts, Cabins, type DrawnShaft } from './Cabins';
import type { Depth } from './depth';
import {
  chamfer, dashedRun, ribbon, routePath, shadowTexture, stairs, type V3,
} from './geometry';
import type { Line, Platform, StationMap, ViewParams } from './types';
import {
  CHAMFER, descentKind, LINE_LIFT, lineHalfWidth, PLATFORM_DEPTH, SLAB_DEPTH, SLAB_MARGIN,
  type Scheme,
} from './viz';

/**
 * The opening camera angle: the three-quarter view a station atlas is drawn in.
 *
 * The azimuth is not a taste. Head-on, the lane axis projects almost straight
 * up the screen — the same direction as the depth axis — and a route stepping
 * one lane away from the viewer becomes indistinguishable from a route
 * climbing back up through time, which is the one reading this plugin must
 * never allow. Twenty-four degrees gives the lane axis a horizontal component
 * of its own, so process order runs right and slightly down, lanes recede
 * right and up, and depth is the only thing that is purely vertical.
 */
const OBLIQUE = { azimuth: 0.42, polar: 1.05 };

/** Click-vs-drag threshold: OrbitControls and picking share a pointerdown. */
const CLICK_SLOP_PX = 6;
const CLICK_TIMEOUT_MS = 600;

export interface SceneModel {
  map: StationMap;
  depth: Depth;
  params: ViewParams;
  scheme: Scheme;
  /** Colour per object type, from the host's own palette. */
  colors: Map<string, string>;
  /** The object type whose lifecycle is lit up, if one is chosen. */
  highlight: string | null;
  selected: string | null;
  hovered: string | null;
  flat: boolean;
  /** Plan centre, subtracted so the camera can simply look at the origin. */
  centre: { x: number; z: number };
}

export interface CameraCommand {
  nonce: number;
  kind: 'reset' | 'top' | 'focus' | 'zoom';
  target?: { x: number; y: number; z: number };
  by?: number;
}

export interface Anchor {
  id: string;
  world: [number, number, number];
}

export type ProjectionSink = (
  projected: Array<{ id: string; x: number; y: number; visible: boolean }>,
  size: { width: number; height: number }
) => void;

/* ------------------------------------------------------------------ *
 * Derived drawing model.
 * ------------------------------------------------------------------ */

export interface DrawnRoute {
  line: Line;
  path: V3[];
  dropIndex: number;
  halfWidth: number;
  color: string;
  /** How the descent at `dropIndex` is drawn. */
  descent: 'ramp' | 'stairs' | 'shaft';
  lengths: number[];
  total: number;
}

export interface DrawnLink {
  key: string;
  path: V3[];
  dropIndex: number;
  halfWidth: number;
  descent: 'ramp' | 'stairs' | 'shaft';
}

/**
 * Every route's drawn path, and the trackbed shared by the routes on one
 * hand-off.
 *
 * Built once per (payload, depth, width) change rather than per frame: this is
 * the expensive half of the view, and none of it depends on the camera, the
 * selection or the clock.
 */
export function buildRoutes(scene: SceneModel): { routes: DrawnRoute[]; links: DrawnLink[] } {
  const { map, depth, params, flat, centre } = scene;
  const busiest = Math.max(1, ...map.lines.map((l) => l.freq));
  const yOf = (id: string): number => (flat ? 0 : depth.y.get(id) ?? 0);
  const elevators = !flat && params.shafts === 'elevators';

  const routes: DrawnRoute[] = [];
  const bundles = new Map<string, { lines: Line[]; width: number }>();

  for (const line of map.lines) {
    const halfWidth = lineHalfWidth(line.freq, busiest, params.lineWidth === 'uniform');
    const bundle = bundles.get(line.link) ?? { lines: [], width: 0 };
    bundle.lines.push(line);
    bundle.width += halfWidth * 2;
    bundles.set(line.link, bundle);

    const top = yOf(line.source);
    const bottom = yOf(line.target);
    const descent = descentKind(top - bottom, depth.floor, elevators);
    const { points, dropIndex } = routePath(line, {
      top,
      bottom,
      cut: CHAMFER,
      // Only a lift shaft breaks the track into two levels. A staircase is a
      // slope with steps drawn under it, so its path is the ramp's.
      vertical: descent === 'shaft',
    });
    const shifted = points.map((p) => ({ x: p.x - centre.x, y: p.y, z: p.z - centre.z }));
    const lengths = arcLengths(shifted);
    routes.push({
      line,
      path: shifted,
      dropIndex,
      halfWidth,
      color: scene.colors.get(line.objectType) ?? '#888888',
      descent,
      lengths,
      total: lengths[lengths.length - 1] ?? 0,
    });
  }

  // The trackbed follows the *bundle's* centre line, which is the plan
  // polyline of any one of its routes taken back to the middle of the bundle.
  // Drawing one slab per route instead would stack a dozen shadows on a busy
  // corridor and lose the "one viaduct, several tracks" reading entirely.
  const links: DrawnLink[] = [];
  for (const [key, bundle] of bundles) {
    const middle = bundle.lines[Math.floor((bundle.lines.length - 1) / 2)];
    const partner = bundle.lines[Math.ceil((bundle.lines.length - 1) / 2)];
    const top = yOf(middle.source);
    const bottom = yOf(middle.target);
    const descent = descentKind(top - bottom, depth.floor, elevators);
    const a = routePath(middle, { top, bottom, cut: CHAMFER, vertical: descent === 'shaft' });
    const b = routePath(partner, { top, bottom, cut: CHAMFER, vertical: descent === 'shaft' });
    const path = a.points.map((p, i) => {
      const q = b.points[i] ?? p;
      return { x: (p.x + q.x) / 2 - centre.x, y: p.y, z: (p.z + q.z) / 2 - centre.z };
    });
    links.push({
      key,
      path,
      dropIndex: a.dropIndex,
      halfWidth: bundle.width / 2 + SLAB_MARGIN,
      descent,
    });
  }

  return { routes, links };
}

function arcLengths(path: V3[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    out.push(out[i - 1] + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
  }
  return out;
}

function pointAt(path: V3[], lengths: number[], distance: number): V3 {
  const total = lengths[lengths.length - 1] || 1;
  const d = ((distance % total) + total) % total;
  for (let i = 1; i < lengths.length; i++) {
    if (d <= lengths[i]) {
      const span = lengths[i] - lengths[i - 1] || 1;
      const f = (d - lengths[i - 1]) / span;
      const p = path[i - 1];
      const q = path[i];
      return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, z: p.z + (q.z - p.z) * f };
    }
  }
  return path[path.length - 1];
}

/* ------------------------------------------------------------------ *
 * The trackbed and the routes.
 * ------------------------------------------------------------------ */

function Trackbeds({ links, scene }: { links: DrawnLink[]; scene: SceneModel }) {
  const geometries = useMemo(
    () => links.map((link) => ribbon(link.path, link.halfWidth, SLAB_DEPTH)),
    [links]
  );
  useEffect(() => () => {
    for (const g of geometries) {
      g.top.dispose();
      g.side.dispose();
    }
  }, [geometries]);

  return (
    <group>
      {geometries.map((geometry, index) => (
        <group key={links[index].key}>
          {/* Offset away from the camera in depth, not only in world space.
              A route rides a few thousandths of a plan unit above its own
              trackbed, and on a large diagram — where the camera has to stand
              far enough back to see forty plan units — that is well inside the
              depth buffer's precision at that distance. The result is not a
              subtle artefact: the trackbed wins across the middle of every
              route and each line renders as two hairlines with white between
              them, which is what the whole diagram looked like the first time
              it was run on a real log rather than on the worked example. */}
          <mesh geometry={geometry.top}>
            <meshStandardMaterial
              color={scene.scheme.slabTop}
              roughness={0.95}
              metalness={0}
              polygonOffset
              polygonOffsetFactor={2}
              polygonOffsetUnits={3}
            />
          </mesh>
          <mesh geometry={geometry.side}>
            <meshStandardMaterial
              color={scene.scheme.slabSide}
              roughness={1}
              metalness={0}
              polygonOffset
              polygonOffsetFactor={2}
              polygonOffsetUnits={3}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Routes({ routes, scene }: { routes: DrawnRoute[]; scene: SceneModel }) {
  const geometries = useMemo(
    () =>
      routes.map((route) =>
        ribbon(
          route.path.map((p) => ({ ...p, y: p.y + LINE_LIFT })),
          route.halfWidth,
          0
        )
      ),
    [routes]
  );
  useEffect(() => () => {
    for (const g of geometries) {
      g.top.dispose();
      g.side.dispose();
    }
  }, [geometries]);

  const { highlight, selected } = scene;
  return (
    <group>
      {geometries.map((geometry, index) => {
        const route = routes[index];
        const lit = !highlight || route.line.objectType === highlight;
        const touches =
          !selected || route.line.source === selected || route.line.target === selected;
        const strong = lit && touches;
        return (
          <mesh key={route.line.id} geometry={geometry.top} renderOrder={strong ? 3 : 2}>
            <meshStandardMaterial
              color={route.color}
              roughness={0.55}
              metalness={0}
              transparent={!strong}
              opacity={strong ? 1 : 0.2}
              side={DoubleSide}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Descents: lift shafts and staircases.
 * ------------------------------------------------------------------ */

function Descents({ links, routes, scene }: { links: DrawnLink[]; routes: DrawnRoute[]; scene: SceneModel }) {
  const byLink = useMemo(() => {
    const map = new Map<string, DrawnRoute[]>();
    for (const route of routes) {
      const list = map.get(route.line.link);
      if (list) list.push(route);
      else map.set(route.line.link, [route]);
    }
    return map;
  }, [routes]);

  // A staircase is built *under* the stretch of track that actually slopes,
  // found by walking the path rather than assumed to be one segment: the ramp
  // eases its descent over a window, so it is usually several vertices long.
  const stairGeometries = useMemo(() => {
    const out = new Map<string, BufferGeometry>();
    for (const link of links) {
      if (link.descent !== 'stairs' || link.path.length < 2) continue;
      let first = -1;
      let last = -1;
      for (let i = 1; i < link.path.length; i++) {
        if (Math.abs(link.path[i].y - link.path[i - 1].y) > 1e-6) {
          if (first < 0) first = i - 1;
          last = i;
        }
      }
      if (first < 0 || last <= first) continue;
      const from = link.path[first];
      const to = link.path[last];
      const steps = Math.max(3, Math.min(7, Math.round((from.y - to.y) / 0.05)));
      out.set(
        link.key,
        stairs(
          { x: from.x, y: from.y - SLAB_DEPTH * 0.5, z: from.z },
          { x: to.x, y: to.y - SLAB_DEPTH * 0.5, z: to.z },
          link.halfWidth * 2.1,
          steps
        )
      );
    }
    return out;
  }, [links]);
  useEffect(() => () => {
    for (const g of stairGeometries.values()) g.dispose();
  }, [stairGeometries]);

  return (
    <group>
      {links.map((link) => {
        const a = link.path[link.dropIndex];
        const b = link.path[link.dropIndex + 1];
        if (!a || !b) return null;
        const drop = Math.abs(a.y - b.y);
        const lines = byLink.get(link.key) ?? [];
        const lit =
          !scene.highlight || lines.some((route) => route.line.objectType === scene.highlight);

        if (link.descent === 'stairs') {
          const geometry = stairGeometries.get(link.key);
          return geometry ? (
            <mesh key={link.key} geometry={geometry}>
              <meshStandardMaterial
                color={scene.scheme.stair}
                roughness={1}
                metalness={0}
                side={DoubleSide}
                transparent={!lit}
                opacity={lit ? 1 : 0.25}
              />
            </mesh>
          ) : null;
        }
        if (link.descent !== 'shaft' || drop < 1e-4) return null;

        // The glass. Drawn from the inside as well as the outside, so the far
        // wall is visible through the near one and the shaft reads as a hollow
        // box rather than a coloured pill.
        // The kernel's own figure, which is what its clearance invariants
        // were checked against.
        // Amber, not the route's colour. The glass means *waiting*, which is
        // what the depth axis measures; tinting it per route would put a fifth
        // colour on the legend that means something else entirely.
        const shaft = scene.map.shafts.find((s) => s.link === link.key);
        const radius = shaft?.radius ?? Math.max(0.17, link.halfWidth * 1.9 + 0.055);
        const centreY = (a.y + b.y) / 2;
        const critical = shaft?.critical ?? false;
        const tint = scene.scheme.shaftGlass;
        const presence = (critical ? 1 : 0.45) * (lit ? 1 : 0.35);
        return (
          <group key={link.key} position={[a.x, centreY, a.z]}>
            <mesh renderOrder={6}>
              <cylinderGeometry args={[radius, radius, drop, 26, 1, true]} />
              <meshStandardMaterial
                color={tint}
                roughness={0.25}
                metalness={0}
                transparent
                opacity={scene.scheme.glassOpacity * presence}
                side={DoubleSide}
                depthWrite={false}
              />
            </mesh>
            {/* The machine room and the pit: what makes a tinted cylinder read
                as a shaft with a top and a bottom rather than as a highlight
                over the track. */}
            <mesh renderOrder={7} position={[0, drop / 2 + 0.012, 0]}>
              <cylinderGeometry args={[radius * 1.22, radius * 1.22, 0.026, 26]} />
              <meshStandardMaterial color={scene.scheme.platformTop} roughness={0.8} metalness={0} />
            </mesh>
            <mesh renderOrder={7} position={[0, -drop / 2 - 0.012, 0]}>
              <cylinderGeometry args={[radius * 1.22, radius * 1.22, 0.026, 26]} />
              <meshStandardMaterial color={scene.scheme.platformTop} roughness={0.8} metalness={0} />
            </mesh>
            {/* The hoist cable, which the car runs on. */}
            <mesh renderOrder={8}>
              <cylinderGeometry args={[radius * 0.055, radius * 0.055, drop + 0.05, 8]} />
              <meshStandardMaterial color={scene.scheme.carShell} roughness={0.6} metalness={0} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Platforms.
 * ------------------------------------------------------------------ */

function Platforms({
  scene,
  onPick,
  onHover,
}: {
  scene: SceneModel;
  onPick: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  const shadow = useMemo(() => shadowTexture(scene.params.palette === 'night'), [scene.params.palette]);
  useEffect(() => () => shadow.dispose(), [shadow]);
  const down = useRef<{ x: number; y: number; at: number } | null>(null);

  const yOf = (platform: Platform) => (scene.flat ? 0 : scene.depth.y.get(platform.id) ?? 0);
  const litTypes = scene.highlight;

  return (
    <group>
      {scene.map.platforms.map((platform) => {
        const y = yOf(platform);
        const x = platform.x - scene.centre.x;
        const z = platform.z - scene.centre.z;
        const lit = !litTypes || platform.objectTypes.includes(litTypes);
        const active = scene.selected === platform.id || scene.hovered === platform.id;
        return (
          <group key={platform.id} position={[x, y, z]}>
            <mesh
              position={[0.045, -PLATFORM_DEPTH - 0.012, 0.045]}
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={0}
            >
              <circleGeometry args={[platform.radius * 1.55, 34]} />
              <meshBasicMaterial
                map={shadow}
                transparent
                depthWrite={false}
                opacity={scene.scheme.shadowOpacity * (lit ? 1 : 0.4)}
              />
            </mesh>
            <mesh
              position={[0, -PLATFORM_DEPTH / 2, 0]}
              renderOrder={4}
              onPointerDown={(event: ThreeEvent<PointerEvent>) => {
                down.current = { x: event.clientX, y: event.clientY, at: performance.now() };
              }}
              onPointerUp={(event: ThreeEvent<PointerEvent>) => {
                const start = down.current;
                down.current = null;
                if (!start) return;
                const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
                if (moved > CLICK_SLOP_PX || performance.now() - start.at > CLICK_TIMEOUT_MS) return;
                event.stopPropagation();
                onPick(platform.id);
              }}
              onPointerOver={(event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                onHover(platform.id);
              }}
              onPointerOut={() => onHover(null)}
            >
              <cylinderGeometry args={[platform.radius, platform.radius, PLATFORM_DEPTH, 44]} />
              <meshStandardMaterial
                attach="material-0"
                color={scene.scheme.platformSide}
                roughness={0.9}
                metalness={0}
                transparent={!lit}
                opacity={lit ? 1 : 0.35}
              />
              <meshStandardMaterial
                attach="material-1"
                color={active ? mix(scene.scheme.platformTop, scene.scheme.pin, 0.16) : scene.scheme.platformTop}
                roughness={0.75}
                metalness={0}
                transparent={!lit}
                opacity={lit ? 1 : 0.35}
              />
              <meshStandardMaterial
                attach="material-2"
                color={scene.scheme.platformSide}
                roughness={1}
                metalness={0}
                transparent={!lit}
                opacity={lit ? 1 : 0.35}
              />
            </mesh>
            {/* The rim: what makes a white disc on an off-white ground a
                platform rather than a smudge. */}
            <mesh position={[0, 0.0012, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5}>
              <ringGeometry args={[platform.radius * 0.9, platform.radius, 44]} />
              <meshBasicMaterial
                color={active ? scene.scheme.pin : scene.scheme.platformRim}
                transparent={!lit}
                opacity={lit ? 1 : 0.35}
                side={DoubleSide}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function mix(a: string, b: string, amount: number): string {
  const ca = new Color(a);
  const cb = new Color(b);
  return `#${ca.lerp(cb, amount).getHexString()}`;
}

/* ------------------------------------------------------------------ *
 * Origin and terminus pins.
 * ------------------------------------------------------------------ */

function Pins({ scene }: { scene: SceneModel }) {
  const marks = scene.map.platforms.filter((p) => p.isStart || p.isEnd);
  return (
    <group>
      {marks.map((platform) => {
        const y = (scene.flat ? 0 : scene.depth.y.get(platform.id) ?? 0) + 0.12;
        return (
          <group
            key={`pin:${platform.id}`}
            position={[platform.x - scene.centre.x, y, platform.z - scene.centre.z]}
          >
            <mesh position={[0, 0.075, 0]}>
              <sphereGeometry args={[0.062, 20, 16]} />
              <meshStandardMaterial color={scene.scheme.pin} roughness={0.5} metalness={0} />
            </mesh>
            <mesh position={[0, 0.018, 0]}>
              <coneGeometry args={[0.055, 0.11, 20]} />
              <meshStandardMaterial color={scene.scheme.pin} roughness={0.5} metalness={0} />
            </mesh>
            <mesh position={[0, 0.086, 0.052]}>
              <sphereGeometry args={[0.022, 14, 12]} />
              <meshBasicMaterial color={scene.scheme.platformTop} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Depth guides: the dashed floor and the graduated bands.
 * ------------------------------------------------------------------ */

function Guides({ scene, half }: { scene: SceneModel; half: { x: number; z: number } }) {
  const { depth, scheme, flat } = scene;
  const positions = useMemo(() => {
    const out: number[] = [];
    const x0 = axisAnchor(half).x;
    const x1 = half.x + 0.35;
    const z0 = -half.z - 0.35;
    const z1 = half.z + 0.35;
    const levels = flat ? [0] : [0, ...depth.ticks.map((tick) => tick.y)];
    for (const y of levels) {
      // A rectangle at each graduation, so the drawing has floors rather than
      // just numbers running up a pole.
      dashedRun({ x: x0, y, z: z0 }, { x: x1, y, z: z0 }, 0.16, 0.13, out);
      dashedRun({ x: x0, y, z: z1 }, { x: x1, y, z: z1 }, 0.16, 0.13, out);
      dashedRun({ x: x0, y, z: z0 }, { x: x0, y, z: z1 }, 0.16, 0.13, out);
      dashedRun({ x: x1, y, z: z0 }, { x: x1, y, z: z1 }, 0.16, 0.13, out);
    }
    return new Float32Array(out);
  }, [depth.ticks, flat, half.x, half.z]);

  const axis = useMemo(() => {
    const out: number[] = [];
    if (flat) return new Float32Array(out);
    const { x, z } = axisAnchor(half);
    out.push(x, 0, z, x, depth.floor, z);
    for (const tick of depth.ticks) out.push(x - 0.09, tick.y, z, x + 0.09, tick.y, z);
    return new Float32Array(out);
  }, [depth.floor, depth.ticks, flat, half.x, half.z]);

  return (
    <group>
      <lineSegments renderOrder={1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={scheme.grid} transparent opacity={0.9} />
      </lineSegments>
      {axis.length > 0 && (
        <lineSegments renderOrder={1}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[axis, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={scheme.gridStrong} />
        </lineSegments>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ *
 * Traffic.
 * ------------------------------------------------------------------ */

const MAX_MARKS = 480;

function Traffic({ routes, scene }: { routes: DrawnRoute[]; scene: SceneModel }) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const plan = useMemo(() => {
    const out: Array<{ route: DrawnRoute; phase: number; speed: number }> = [];
    for (const route of routes) {
      if (route.total < 1e-4) continue;
      const marks = Math.min(4, Math.max(1, Math.round(route.total / 1.5)));
      // Slower where the hand-off is slower: the marks are the only part of
      // the drawing that says how long a route *takes* rather than how far it
      // descends, and on a logarithmic axis those stop being the same thing.
      const wait = route.line.waitSecs ?? 0;
      const speed = 0.55 / (1 + Math.log1p(wait / 600));
      for (let i = 0; i < marks; i++) {
        out.push({ route, phase: (i / marks) * route.total, speed });
      }
      if (out.length >= MAX_MARKS) break;
    }
    return out;
  }, [routes]);

  const colors = useMemo(() => {
    const array = new Float32Array(Math.max(1, plan.length) * 3);
    const colour = new Color();
    plan.forEach((mark, index) => {
      colour.set(mark.route.color);
      array[index * 3] = colour.r;
      array[index * 3 + 1] = colour.g;
      array[index * 3 + 2] = colour.b;
    });
    return array;
  }, [plan]);

  useLayoutEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    instanced.count = plan.length;
  }, [plan]);

  useFrame((state) => {
    const instanced = mesh.current;
    if (!instanced || plan.length === 0) return;
    const time = state.clock.elapsedTime;
    plan.forEach((mark, index) => {
      const at = pointAt(mark.route.path, mark.route.lengths, mark.phase + time * mark.speed);
      dummy.position.set(at.x, at.y + LINE_LIFT + 0.012, at.z);
      const lit = !scene.highlight || mark.route.line.objectType === scene.highlight;
      const size = lit ? 1 : 0.001;
      dummy.scale.set(size, size, size);
      dummy.updateMatrix();
      instanced.setMatrixAt(index, dummy.matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
  });

  if (plan.length === 0) return null;
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, plan.length]} renderOrder={8}>
      <sphereGeometry args={[0.021, 10, 8]}>
        <instancedBufferAttribute attach="attributes-color" args={[colors, 3]} />
      </sphereGeometry>
      <meshBasicMaterial vertexColors toneMapped={false} />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------------ *
 * Camera.
 * ------------------------------------------------------------------ */

/**
 * The distance at which everything drawn fits the frame from this angle.
 *
 * Fitted to the points themselves rather than to their bounding box. The
 * diagram is a long diagonal ribbon through that box, so the box's corners are
 * mostly empty air — fitting them leaves the drawing at about half the size
 * the panel could show it at, which on a diagram whose whole argument is a
 * comparison of heights is not a small loss.
 */
function fittingDistance(
  fov: number,
  aspect: number,
  polar: number,
  azimuth: number,
  points: readonly Vector3[],
  centreY: number
): number {
  const vertical = (fov * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  const forward = new Vector3(
    Math.sin(azimuth) * Math.sin(polar),
    Math.cos(polar),
    Math.cos(azimuth) * Math.sin(polar)
  ).normalize();
  const right = new Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth)).normalize();
  const up = new Vector3().crossVectors(right, forward).negate().normalize();

  let distance = 1;
  const at = new Vector3();
  for (const point of points) {
    at.set(point.x, point.y - centreY, point.z);
    const depth = at.dot(forward);
    distance = Math.max(
      distance,
      Math.abs(at.dot(right)) / Math.tan(horizontal / 2) + depth,
      Math.abs(at.dot(up)) / Math.tan(vertical / 2) + depth
    );
  }
  return distance * 1.1;
}

function Controls({
  command,
  points,
  centreY,
  flat,
  onInteract,
}: {
  command: CameraCommand;
  /** Everything that has to stay in frame, in world space. */
  points: readonly Vector3[];
  /** Vertical middle of everything drawn — where the camera should look. */
  centreY: number;
  flat: boolean;
  onInteract: () => void;
}) {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const controls = useRef<OrbitControls | null>(null);
  const touched = useRef(false);

  const onInteractRef = useRef(onInteract);
  onInteractRef.current = onInteract;

  useEffect(() => {
    const orbit = new OrbitControls(camera, domElement as HTMLElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.09;
    orbit.rotateSpeed = 0.8;
    orbit.zoomSpeed = 0.85;
    orbit.screenSpacePanning = false;
    orbit.minDistance = 1.2;
    orbit.maxDistance = 220;
    // Just short of the horizon: level with the ground the whole diagram
    // becomes a line, with no way back except the reset button.
    orbit.maxPolarAngle = Math.PI * 0.495;
    orbit.minPolarAngle = 0.02;
    controls.current = orbit;
    const notify = () => {
      touched.current = true;
      onInteractRef.current();
    };
    orbit.addEventListener('start', notify);
    return () => {
      orbit.removeEventListener('start', notify);
      orbit.dispose();
      controls.current = null;
    };
  }, [camera, domElement]);

  const aspect = size.height > 0 ? size.width / size.height : 1.6;
  // Quantised before it reaches the fit, so the handful of pixels a panel
  // reflow moves the canvas by is not treated as "the panel was resized" and
  // does not snap the camera back from wherever the analyst put it.
  const roundedAspect = Math.round(aspect * 20) / 20;
  const fov = (camera as { fov?: number }).fov ?? 20;
  // Fitted for the angle actually in force: the flat view looks straight down,
  // where the oblique fit is both too loose in one direction and too tight in
  // the other.
  const fit = useMemo(
    () =>
      flat
        ? fittingDistance(fov, roundedAspect, 0.001, 0, points, 0)
        : fittingDistance(fov, roundedAspect, OBLIQUE.polar, OBLIQUE.azimuth, points, centreY),
    [fov, roundedAspect, points, centreY, flat]
  );
  const applied = useRef<number | null>(null);

  useEffect(() => {
    const orbit = controls.current;
    if (!orbit) return;
    applied.current = fit;
    if (command.kind === 'top' || flat) {
      orbit.target.set(0, 0, 0);
      camera.position.set(0, fit, 0.0002);
    } else if (command.kind === 'zoom' && command.by) {
      const direction = camera.position.clone().sub(orbit.target);
      const length = Math.max(orbit.minDistance, Math.min(orbit.maxDistance, direction.length() * command.by));
      camera.position.copy(orbit.target).add(direction.setLength(length));
    } else if (command.kind === 'focus' && command.target) {
      const { x, y, z } = command.target;
      orbit.target.set(x, y, z);
      const distance = Math.max(1.6, fit * 0.34);
      camera.position.set(
        x + Math.sin(OBLIQUE.azimuth) * Math.sin(OBLIQUE.polar) * distance,
        y + Math.cos(OBLIQUE.polar) * distance,
        z + Math.cos(OBLIQUE.azimuth) * Math.sin(OBLIQUE.polar) * distance
      );
    } else {
      orbit.target.set(0, centreY, 0);
      const { azimuth, polar } = OBLIQUE;
      camera.position.set(
        Math.sin(azimuth) * Math.sin(polar) * fit,
        Math.cos(polar) * fit + centreY,
        Math.cos(azimuth) * Math.sin(polar) * fit
      );
    }
    orbit.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, command, flat]);

  // The depth range follows the fit. A near plane fixed at a fifth of a plan
  // unit against a far plane at nine hundred spends almost all of the depth
  // buffer's precision on space nothing is ever drawn in, and a diagram twice
  // as large is exactly where that starts to show.
  useEffect(() => {
    const perspective = camera as unknown as {
      near: number;
      far: number;
      updateProjectionMatrix(): void;
    };
    perspective.near = Math.max(0.05, fit / 60);
    perspective.far = Math.max(perspective.near * 20, fit * 4);
    perspective.updateProjectionMatrix();
  }, [camera, fit]);

  // Re-fit on a real reshape, but only until the analyst takes over.
  useEffect(() => {
    const orbit = controls.current;
    if (!orbit || touched.current) return;
    if (applied.current != null && Math.abs(fit - applied.current) < 0.08) return;
    applied.current = fit;
    const { azimuth, polar } = OBLIQUE;
    if (flat) camera.position.set(0, fit, 0.0002);
    else {
      camera.position.set(
        Math.sin(azimuth) * Math.sin(polar) * fit,
        Math.cos(polar) * fit + centreY,
        Math.cos(azimuth) * Math.sin(polar) * fit
      );
    }
    orbit.update();
  }, [camera, fit, flat, centreY]);

  useFrame(() => {
    controls.current?.update();
  });
  return null;
}

/**
 * Belt and braces on the colour pipeline.
 *
 * A filmic tone curve is right for a rendered photograph and wrong for a
 * printed diagram: it pulls white platforms grey and mutes exactly the route
 * colours the whole drawing is read by. `flat` on the Canvas should be enough;
 * this makes sure of it after any later re-application.
 */
function Pipeline() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    (gl as unknown as { toneMapping: number }).toneMapping = NoToneMapping;
    (gl as unknown as { outputColorSpace: string }).outputColorSpace = SRGBColorSpace;
  }, [gl]);
  return null;
}

/* ------------------------------------------------------------------ *
 * Label projection.
 * ------------------------------------------------------------------ */

function Projector({ anchors, sink }: { anchors: Anchor[]; sink: ProjectionSink }) {
  const vector = useMemo(() => new Vector3(), []);
  useFrame((state) => {
    const { camera, size } = state;
    const out = anchors.map((anchor) => {
      vector.set(anchor.world[0], anchor.world[1], anchor.world[2]).project(camera);
      return {
        id: anchor.id,
        x: (vector.x * 0.5 + 0.5) * size.width,
        y: (-vector.y * 0.5 + 0.5) * size.height,
        visible: vector.z < 1,
      };
    });
    sink(out, { width: size.width, height: size.height });
  });
  return null;
}

/* ------------------------------------------------------------------ *
 * The canvas.
 * ------------------------------------------------------------------ */

/**
 * Half-extent of everything drawn, which both the camera fit and the depth
 * guides are built from — and which the axis labels need too, so it is
 * computed once outside and handed in rather than twice in two places that
 * could drift apart.
 */
export function planHalf(scene: SceneModel, routes: DrawnRoute[]): { x: number; y: number; z: number } {
  let x = 0.8;
  let z = 0.8;
  for (const platform of scene.map.platforms) {
    x = Math.max(x, Math.abs(platform.x - scene.centre.x) + platform.radius);
    z = Math.max(z, Math.abs(platform.z - scene.centre.z) + platform.radius);
  }
  for (const route of routes) {
    for (const point of route.path) {
      x = Math.max(x, Math.abs(point.x));
      z = Math.max(z, Math.abs(point.z));
    }
  }
  return {
    x: x + 0.5,
    y: Math.max(0.35, Math.abs(scene.flat ? 0 : scene.depth.floor) / 2 + 0.3),
    z: z + 0.5,
  };
}

/** Where the depth axis stands, given that half-extent. */
export function axisAnchor(half: { x: number; z: number }): { x: number; z: number } {
  return { x: -half.x - 0.35, z: half.z + 0.35 };
}

export interface StationViewProps {
  scene: SceneModel;
  routes: DrawnRoute[];
  links: DrawnLink[];
  half: { x: number; y: number; z: number };
  anchors: Anchor[];
  sink: ProjectionSink;
  command: CameraCommand;
  onPick: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onInteract: () => void;
  onBackend: (backend: string) => void;
}

export function StationView(props: StationViewProps) {
  const { scene, routes, links, half } = props;
  const dark = scene.params.palette === 'night';

  // Only the things a car's position depends on: the shafts themselves and
  // the palette. Hovering a platform must not rebuild them.
  const cabins: DrawnShaft[] = useMemo(
    () => buildShafts(scene, links),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, scene.map.shafts, scene.colors, scene.flat, scene.params.shafts]
  );

  // What the camera has to keep in frame: the platforms with their discs, and
  // every route vertex — including the depth axis's own pole, which is off to
  // one side and is part of the reading, not decoration.
  const fitPoints = useMemo(() => {
    const out: Vector3[] = [];
    for (const platform of scene.map.platforms) {
      const y = scene.flat ? 0 : scene.depth.y.get(platform.id) ?? 0;
      const x = platform.x - scene.centre.x;
      const z = platform.z - scene.centre.z;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        out.push(new Vector3(x + dx * platform.radius, y, z + dz * platform.radius));
      }
    }
    for (const route of routes) {
      for (const point of route.path) out.push(new Vector3(point.x, point.y, point.z));
    }
    if (!scene.flat) {
      const pole = axisAnchor(half);
      out.push(new Vector3(pole.x, 0, pole.z));
      out.push(new Vector3(pole.x, scene.depth.floor, pole.z));
    }
    return out;
  }, [scene.map.platforms, scene.centre, scene.depth, scene.flat, routes, half]);

  return (
    // Keyed on the backend choice: a renderer is bound to its canvas for life,
    // so changing it has to build a new one rather than reconfigure this one.
    <Canvas
      key={scene.params.renderer}
      dpr={[1, 2]}
      gl={async (defaults) => {
        try {
          const renderer = new WebGPURenderer({
            canvas: defaults.canvas as HTMLCanvasElement,
            antialias: true,
            alpha: false,
            forceWebGL: scene.params.renderer === 'webgl2',
          });
          await renderer.init();
          // The diagram is a printed illustration, not a photograph: a filmic
          // tone curve pulls its white platforms grey and mutes exactly the
          // four route colours the whole thing is read by.
          renderer.toneMapping = NoToneMapping;
          renderer.outputColorSpace = SRGBColorSpace;
          const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined;
          props.onBackend(backend?.isWebGPUBackend === true ? 'WebGPU' : 'WebGL 2');
          return renderer as unknown as never;
        } catch (error) {
          props.onBackend(`unavailable: ${(error as Error)?.message ?? error}`);
          throw error;
        }
      }}
      // `flat` is R3F's own switch for "no tone mapping". It has to be here
      // rather than only on the renderer, because R3F applies its default
      // (filmic) *after* the `gl` factory returns and would undo it.
      flat
      camera={{ fov: 20, near: 0.2, far: 900, position: [3, 5, 9] }}
      style={{ position: 'absolute', inset: 0 }}
      onPointerMissed={() => props.onPick(null)}
    >
      <color attach="background" args={[scene.scheme.background]} />
      <Pipeline />
      <hemisphereLight
        args={[new Color(scene.scheme.skyTop), new Color(scene.scheme.skyBottom), dark ? 1.1 : 2.1]}
      />
      <directionalLight
        position={[-4, 9, 6]}
        intensity={dark ? 1.5 : 1.9}
        color={new Color(dark ? '#cddcff' : '#ffffff')}
      />
      <directionalLight position={[6, 3, -5]} intensity={dark ? 0.5 : 0.45} color={new Color('#ffd9b0')} />

      {scene.params.showGrid && <Guides scene={scene} half={half} />}
      <Trackbeds links={links} scene={scene} />
      <Routes routes={routes} scene={scene} />
      <Descents links={links} routes={routes} scene={scene} />
      <Platforms scene={scene} onPick={props.onPick} onHover={props.onHover} />
      <Pins scene={scene} />
      {scene.params.animateFlow && <Traffic routes={routes} scene={scene} />}
      {scene.params.animateFlow && <Cabins shafts={cabins} scene={scene} />}

      <Controls
        command={props.command}
        points={fitPoints}
        centreY={scene.flat ? 0 : scene.depth.floor / 2}
        flat={scene.flat}
        onInteract={props.onInteract}
      />
      <Projector anchors={props.anchors} sink={props.sink} />
    </Canvas>
  );
}

export { OBLIQUE };
