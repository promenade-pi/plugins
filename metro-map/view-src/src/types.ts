/** Mirrors `crates/metro-map-core`'s `MetroMapPayload` (see its `Serialize` impls). */

/** Optional per-node overlay from Rust — `frequency` on the OC-DFG basis,
 * `revealOrder` (structural leaf-peel order, 0 = process core) on the
 * Petri-net basis. Arrives as a nested `meta` object, absent when empty. */
export interface MmNodeMeta {
  frequency?: number;
  revealOrder?: number;
}

export interface MmStation {
  kind: 'station';
  id: string;
  activity: string;
  objectTypes: string[];
  rank: number;
  lane: number;
  meta?: MmNodeMeta;
}

export interface MmGateway {
  kind: 'gateway';
  id: string;
  gatewayType: 'and' | 'xor';
  direction: 'split' | 'join' | 'both';
  objectType: string;
  rank: number;
  lane: number;
  meta?: MmNodeMeta;
}

export interface MmBoundary {
  kind: 'source' | 'sink';
  id: string;
  objectType: string;
  rank: number;
  lane: number;
  meta?: MmNodeMeta;
}

export type MmNode = MmStation | MmGateway | MmBoundary;

export interface MmEdge {
  id: string;
  source: string;
  target: string;
  objectType: string;
  /** Whether at least one arc collapsed into this edge was a variable arc
   * in the source OCPN — a single firing can consume/produce more than one
   * token of this object type, so the line drawn here stands for a
   * one-to-many (or many-to-one) relation, not a plain token pass. Always
   * `false` on the OC-DFG basis, which has no arc/token structure to derive
   * this from. Absent only on a map produced before this field existed
   * (treat a missing value as `false`, the same "don't know, don't claim
   * it" default the Rust side uses when deserializing an old OCPN). */
  variable?: boolean;
  kind: 'flow' | 'loop';
  laneOffset: number;
  /** Observed directly-follows frequency — only present on the OC-DFG basis. */
  frequency?: number;
  /** Mean wait along this relation, in seconds — the "performance" label.
   * Only on the OC-DFG basis, and only when the upstream discovery
   * supplied durations (`core.discover.ocdfg` 0.2.0 and later). */
  durationSecs?: number;
  /** Intermediate rank/lane positions this edge passes through without a
   * real node there — present when it spans more than one rank. Dummy
   * "Sugiyama" waypoints computed in Rust so the lane-ordering pass
   * reserves space for the edge's own path; the view stitches them into
   * one continuous routed line. */
  waypoints?: Array<{ rank: number; lane: number }>;
}

export interface MetroMapPayload {
  /** Which upstream model this map was derived from. Absent on maps
   * produced before v0.10.0 — treat a missing value as `'petriNet'`. */
  basis?: 'petriNet' | 'directlyFollows';
  objectTypes: string[];
  nodes: MmNode[];
  edges: MmEdge[];
}

export type { StationStyle } from 'metro-layout';
import type { StationStyle } from 'metro-layout';

export interface ViewParams {
  stationStyle: StationStyle;
  /** What to print on each arc. `performance` shows the mean wait between
   * the two activities, which needs `core.discover.ocdfg` 0.2.0 or later. */
  edgeLabel: 'none' | 'frequency' | 'performance';
  animateFlow: boolean;
  /** When true (the default), the complexity slider's own filtered view is
   * ranked and laid out as a monotone refinement of the full, unfiltered
   * model's own rank/lane — a station never reshuffles as the slider
   * reveals or hides detail, only ever settles further down. When false,
   * `relayoutVisible` computes rank and lane fresh from *only* the
   * currently visible stations and arcs, as if the hidden ones did not
   * exist, on every slider move. Off by default only in the sense that a
   * user has to find it: stability itself defaults on, following the
   * common assumption that a stable mental map helps — Häge & Rehse,
   * "Mental Maps in Process Mining: Does Stabilizing DFGs Improve Process
   * Analysis Performance?" (BPM 2025), found no positive effect from
   * stabilisation in their study, and a significant negative one on one of
   * their measures, which is the direct motivation for exposing this as a
   * toggle instead of only ever computing it one way. */
  preserveStability: boolean;
}

export const defaultViewParams: ViewParams = {
  stationStyle: 'dots', edgeLabel: 'none', animateFlow: false, preserveStability: true,
};

/** A wait in seconds as the shortest readable form: `45s`, `12min`, `3.4h`,
 * `2.1d`. Kept terse because it is drawn inline on the line itself. */
export function formatDuration(secs: number): string {
  const s = Math.abs(secs);
  if (s < 1) return '<1s';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 90 * 60) return `${(s / 60).toFixed(s < 10 * 60 ? 1 : 0)}min`;
  if (s < 36 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
