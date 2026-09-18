/**
 * Lift cars, and why they only ever travel one way.
 *
 * A car descends its shaft at a constant speed, waits at the bottom, and then
 * **beams back to the top** — it is never drawn rising. That is not a shortcut:
 * on this diagram height is elapsed time, so a car climbing the shaft would be
 * a case travelling backwards through it, which is the one thing the whole
 * drawing must never appear to say. The flash is what makes the return read as
 * a cut rather than as motion.
 *
 * Constant speed, so a longer wait is a longer journey. The drop already
 * encodes the duration; keeping the speed fixed means the *time the car takes*
 * encodes it too, and two shafts can be compared by watching them rather than
 * by reading their labels.
 *
 * Everything here is instanced — one draw call per part for the whole diagram,
 * however many shafts it has — because a real log produces dozens of them.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdditiveBlending, Color, InstancedMesh, Object3D } from 'three';

import type { DrawnLink, SceneModel } from './Scene';

/** A shaft with a car in it. */
export interface DrawnShaft {
  key: string;
  x: number;
  z: number;
  /** World y of the shaft's ceiling and floor. */
  top: number;
  bottom: number;
  radius: number;
  /** The object types riding this hand-off, in the payload's own order. */
  colors: string[];
  critical: boolean;
  /** Where in its cycle this car starts, so they do not move in lockstep. */
  phase: number;
}

/** Seconds a car takes to fall one world unit. */
const FALL_SPEED = 0.42;
/** Seconds held at the bottom before the car beams away. */
const HOLD = 0.55;
/** Seconds the arrival flash lasts, and the car is held at the top. */
const FLASH = 0.75;

/** Local half-extents of a car, before it is scaled to fit its shaft. */
const CAR = { x: 1, y: 0.72, z: 0.55 };
/**
 * How far in front of the shaft's centre line the car hangs, in local units.
 *
 * Not decoration. The hoist cable and the routes themselves descend down the
 * middle of the shaft, so a car centred there is sliced in half by them — and
 * worse, its cream back panel, the thing that makes the passengers readable at
 * all, ends up *behind* the cable. Hanging the car off the front of the cable
 * puts the whole interior in front of everything descending the shaft, which
 * is also how a lift car is actually hung.
 */
const FORWARD = 0.62;
/** How much of the shaft's radius a car takes up. */
const FIT = 0.66;
/** A car never occupies more than this share of its own drop. */
const MAX_SHARE = 0.34;
/** How many passengers a car will show. */
const MAX_RIDERS = 3;

export function buildShafts(scene: SceneModel, links: DrawnLink[]): DrawnShaft[] {
  if (scene.flat || scene.params.shafts !== 'elevators') return [];
  const out: DrawnShaft[] = [];
  links.forEach((link, index) => {
    if (link.descent !== 'shaft') return;
    const a = link.path[link.dropIndex];
    const b = link.path[link.dropIndex + 1];
    if (!a || !b) return;
    const shaft = scene.map.shafts.find((s) => s.link === link.key);
    if (!shaft) return;
    const drop = Math.abs(a.y - b.y);
    // The payload's own radius, not one recomputed here: it is what the
    // kernel's invariants held clear of every platform, so a car sized from
    // anything else would be a car nobody checked the clearance for.
    const radius = shaft.radius;
    if (drop < radius * 2.4) return;
    out.push({
      key: link.key,
      x: a.x,
      z: a.z,
      top: Math.max(a.y, b.y),
      bottom: Math.min(a.y, b.y),
      radius,
      colors: shaft.objectTypes.map((type) => scene.colors.get(type) ?? '#8a8f98'),
      critical: shaft.critical,
      // Deterministic, not random: the same map animates the same way twice,
      // which matters when two screenshots of it are being compared.
      phase: ((index * 0.61803398875) % 1) * 3.4,
    });
  });
  return out;
}

interface Placed {
  /** Car centre, world. */
  y: number;
  /** Uniform scale, which pops as the car materialises. */
  scale: number;
  /** 0..1, the arrival flash. */
  flash: number;
}

/** Where one car is, and how bright its flash is, at this moment. */
function place(shaft: DrawnShaft, time: number): Placed {
  const drop = shaft.top - shaft.bottom;
  const size = carSize(shaft);
  const headroom = size * CAR.y + shaft.radius * 0.18;
  const from = shaft.top - headroom;
  const to = shaft.bottom + headroom;
  const travel = Math.max(0.01, from - to);
  const falling = travel / FALL_SPEED;
  const cycle = falling + HOLD + FLASH;
  const at = ((time + shaft.phase) % cycle + cycle) % cycle;

  if (at < falling) {
    // Eased at both ends: a lift starts and stops, it does not teleport into
    // motion — which is the one movement in this scene that must not look like
    // a jump, because a jump is what the return trip is.
    const f = at / falling;
    const eased = f * f * (3 - 2 * f);
    return { y: from - travel * eased, scale: 1, flash: 0 };
  }
  if (at < falling + HOLD) return { y: to, scale: 1, flash: 0 };
  const f = (at - falling - HOLD) / FLASH;
  return { y: from, scale: 0.55 + 0.45 * Math.min(1, f * 2.2), flash: 1 - f };
}

function carSize(shaft: DrawnShaft): number {
  const wanted = shaft.radius * FIT;
  const tallest = ((shaft.top - shaft.bottom) * MAX_SHARE) / (2 * CAR.y);
  return Math.min(wanted, tallest);
}

/**
 * The car, as five boxes: a floor, a ceiling, two side walls and a back panel.
 *
 * Deliberately open at the front, because the passengers are the point — the
 * car is carrying this hand-off's object types, and a closed box would be an
 * amber brick sliding down an amber shaft.
 */
const SHELL: Array<{ c: [number, number, number]; h: [number, number, number] }> = [
  { c: [0, -CAR.y + 0.1, FORWARD], h: [CAR.x, 0.1, CAR.z] },
  { c: [0, CAR.y - 0.1, FORWARD], h: [CAR.x, 0.1, CAR.z] },
  { c: [-CAR.x + 0.15, 0, FORWARD], h: [0.15, CAR.y - 0.2, CAR.z] },
  { c: [CAR.x - 0.15, 0, FORWARD], h: [0.15, CAR.y - 0.2, CAR.z] },
];
const PANEL = {
  c: [0, 0, FORWARD - CAR.z + 0.06] as [number, number, number],
  h: [CAR.x - 0.3, CAR.y - 0.2, 0.06] as [number, number, number],
};

export function Cabins({ shafts, scene }: { shafts: DrawnShaft[]; scene: SceneModel }) {
  const camera = useThree((state) => state.camera);
  const shell = useRef<InstancedMesh>(null);
  const panel = useRef<InstancedMesh>(null);
  const body = useRef<InstancedMesh>(null);
  const head = useRef<InstancedMesh>(null);
  const flash = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tint = useMemo(() => new Color(), []);
  const WHITE = useMemo(() => new Color('#ffffff'), []);

  // One rider per (shaft, object type) shown, flattened so the two passenger
  // meshes share an index.
  const riders = useMemo(() => {
    const out: Array<{ shaft: number; slot: number; of: number; color: string }> = [];
    shafts.forEach((shaft, index) => {
      const shown = Math.min(MAX_RIDERS, Math.max(1, shaft.colors.length));
      for (let slot = 0; slot < shown; slot++) {
        out.push({ shaft: index, slot, of: shown, color: shaft.colors[slot] ?? '#8a8f98' });
      }
    });
    return out;
  }, [shafts]);

  useLayoutEffect(() => {
    if (shell.current) shell.current.count = shafts.length * SHELL.length;
    if (panel.current) panel.current.count = shafts.length;
    if (flash.current) flash.current.count = shafts.length;
    if (body.current) body.current.count = riders.length;
    if (head.current) head.current.count = riders.length;
    // Riders are coloured once: an object type does not change colour between
    // frames, and `setColorAt` writes into the instance buffer either way.
    if (body.current && head.current) {
      const colour = new Color();
      riders.forEach((rider, index) => {
        colour.set(rider.color);
        body.current!.setColorAt(index, colour);
        head.current!.setColorAt(index, colour);
      });
      if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
      if (head.current.instanceColor) head.current.instanceColor.needsUpdate = true;
    }
  }, [shafts, riders]);

  useFrame((state) => {
    if (shafts.length === 0) return;
    const time = state.clock.elapsedTime;
    // Cars turn about their own axis to face the camera, so the open front —
    // and the passengers in it — stay visible from wherever the diagram is
    // being looked at. Taken from the camera's bearing over the whole diagram
    // rather than per car: they are meant to read as one system.
    const facing = Math.atan2(camera.position.x, camera.position.z);
    const sin = Math.sin(facing);
    const cos = Math.cos(facing);
    const placed = shafts.map((shaft) => place(shaft, time));

    /** A local offset, rotated into the world by the car's own facing. */
    const put = (x: number, z: number, offset: readonly [number, number, number], size: number) => {
      dummy.position.set(
        x + (offset[0] * cos + offset[2] * sin) * size,
        0,
        z + (-offset[0] * sin + offset[2] * cos) * size
      );
      dummy.rotation.set(0, facing, 0);
    };

    if (shell.current && panel.current) {
      shafts.forEach((shaft, index) => {
        const size = carSize(shaft) * placed[index].scale;
        SHELL.forEach((part, partIndex) => {
          put(shaft.x, shaft.z, part.c, size);
          dummy.position.y = placed[index].y + part.c[1] * size;
          dummy.scale.set(part.h[0] * size, part.h[1] * size, part.h[2] * size);
          dummy.updateMatrix();
          shell.current!.setMatrixAt(index * SHELL.length + partIndex, dummy.matrix);
        });
        put(shaft.x, shaft.z, PANEL.c, size);
        dummy.position.y = placed[index].y + PANEL.c[1] * size;
        dummy.scale.set(PANEL.h[0] * size, PANEL.h[1] * size, PANEL.h[2] * size);
        dummy.updateMatrix();
        panel.current!.setMatrixAt(index, dummy.matrix);
      });
      shell.current.instanceMatrix.needsUpdate = true;
      panel.current.instanceMatrix.needsUpdate = true;
    }

    if (body.current && head.current) {
      riders.forEach((rider, index) => {
        const shaft = shafts[rider.shaft];
        const size = carSize(shaft) * placed[rider.shaft].scale;
        const across = (rider.slot - (rider.of - 1) / 2) * (1.5 / rider.of) * CAR.x;
        const floor = placed[rider.shaft].y - (CAR.y - 0.2) * size;
        put(shaft.x, shaft.z, [across, 0, FORWARD + 0.05], size);
        const { x, z } = dummy.position;
        dummy.position.set(x, floor + 0.3 * size, z);
        dummy.scale.set(0.19 * size, 0.3 * size, 0.19 * size);
        dummy.updateMatrix();
        body.current!.setMatrixAt(index, dummy.matrix);
        dummy.position.set(x, floor + 0.76 * size, z);
        dummy.scale.setScalar(0.23 * size);
        dummy.updateMatrix();
        head.current!.setMatrixAt(index, dummy.matrix);
      });
      body.current.instanceMatrix.needsUpdate = true;
      head.current.instanceMatrix.needsUpdate = true;
    }

    if (flash.current) {
      shafts.forEach((shaft, index) => {
        const amount = placed[index].flash;
        // Additively blended, so a black instance contributes nothing at all —
        // which is how the flash fades without a per-instance opacity.
        // Squared, so the flash is bright for an instant and gone rather than
        // a slow amber glow hanging in the shaft — and pushed towards white at
        // its peak, because pure amber added to an off-white ground barely
        // registers as light at all.
        tint.set(scene.scheme.flash).lerp(WHITE, amount * 0.55).multiplyScalar(amount * amount * 1.5);
        flash.current!.setColorAt(index, tint);
        dummy.position.set(shaft.x, placed[index].y, shaft.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(amount > 0 ? shaft.radius * (0.55 + 1.35 * (1 - amount)) : 0);
        dummy.updateMatrix();
        flash.current!.setMatrixAt(index, dummy.matrix);
      });
      flash.current.instanceMatrix.needsUpdate = true;
      if (flash.current.instanceColor) flash.current.instanceColor.needsUpdate = true;
    }
  });

  if (shafts.length === 0) return null;

  return (
    <group>
      {/* Every box below is a unit cube scaled per instance, so the car's five
          panels, its passengers and its flash cost five draw calls for the
          whole diagram however many shafts it has. */}
      <instancedMesh
        ref={shell}
        args={[undefined, undefined, Math.max(1, shafts.length * SHELL.length)]}
        renderOrder={9}
      >
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color={scene.scheme.carShell} roughness={0.55} metalness={0} />
      </instancedMesh>

      <instancedMesh ref={panel} args={[undefined, undefined, Math.max(1, shafts.length)]} renderOrder={9}>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color={scene.scheme.carPanel} roughness={0.92} metalness={0} />
      </instancedMesh>

      <instancedMesh ref={body} args={[undefined, undefined, Math.max(1, riders.length)]} renderOrder={10}>
        <cylinderGeometry args={[1, 1, 2, 14]} />
        <meshStandardMaterial roughness={0.5} metalness={0} />
      </instancedMesh>

      <instancedMesh ref={head} args={[undefined, undefined, Math.max(1, riders.length)]} renderOrder={10}>
        <sphereGeometry args={[1, 14, 10]} />
        <meshStandardMaterial roughness={0.5} metalness={0} />
      </instancedMesh>

      <instancedMesh ref={flash} args={[undefined, undefined, Math.max(1, shafts.length)]} renderOrder={12}>
        <sphereGeometry args={[1, 16, 12]} />
        {/* Additive: the flash adds light rather than painting a ball. That is
            also what lets it fade without a per-instance opacity — a black
            instance contributes nothing, so the colour *is* the brightness. */}
        <meshBasicMaterial
          transparent
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}
