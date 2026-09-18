/**
 * Mirrors what `plugins/variant-metro/src/lib.rs` emits: `metro-map-core`'s
 * own `MetroMapPayload` (see its `Serialize` impls) plus the variant
 * attribution this plugin writes onto it.
 */

/** Per-node overlay. `frequency` is the whole-log count `metro-map-core`
 * computes; `minVariant` and `variantCounts` are this plugin's addition. */
export interface MmNodeMeta {
  frequency?: number;
  /** Petri-net basis only, and therefore never set here — kept so a payload
   * from the plain Metro Map plugin still type-checks if one is ever opened. */
  revealOrder?: number;
  /** Rank of the most frequent variant this node first appears in
   * (1 = the most frequent variant of the log). Absent means "always
   * visible", which is what an unattributed node falls back to. */
  minVariant?: number;
  /** Sparse `[variantRank, count]` rows, ascending by rank — the occurrence
   * count this node picks up *in* that variant, so the view can show the
   * count over exactly the variants currently on screen. */
  variantCounts?: number[][];
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
  /** Always `false` on this basis: a directly-follows graph has no arc/token
   * structure to derive a variable arc from. */
  variable?: boolean;
  kind: 'flow' | 'loop';
  laneOffset: number;
  /** Whole-log directly-follows frequency. The view prints the per-position
   * figure from `variantFreq` instead — this is the total across every
   * variant, i.e. what the top of the slider shows. */
  frequency?: number;
  /** Whole-log mean wait along this relation, in seconds. */
  durationSecs?: number;
  /** Rank of the most frequent variant this arc first appears in. */
  minVariant?: number;
  /** Sparse `[variantRank, frequency, secondsSummed]` rows, ascending by
   * rank. The *sum* of waits rides here rather than their mean, so the mean
   * can be taken over whichever variants are shown. */
  variantFreq?: number[][];
  /** Intermediate rank/lane positions this arc passes through without a real
   * node there — dummy "Sugiyama" waypoints computed in Rust so the
   * lane-ordering pass reserves space for the arc's own path; the view
   * stitches them into one continuous routed line. */
  waypoints?: Array<{ rank: number; lane: number }>;
}

/** One slider position: the variant of that rank, or — at the last position
 * of a log with more variants than the slider has room for — every remaining
 * variant at once (`tail`). */
export interface VariantSummary {
  rank: number;
  /** Process executions in this variant (or in the whole tail). */
  executions: number;
  /** Mean events per execution here. */
  avgEvents?: number;
  /** How many distinct variants this position adds: 1, except for the tail. */
  variants?: number;
  tail?: boolean;
  /** Executions covered by every position up to and including this one. */
  cumulative?: number;
  /** Variants covered up to and including this one. */
  cumulativeVariants?: number;
  /** `cumulative` as a share of every process execution in the log. */
  share?: number;
}

export interface MetroMapPayload {
  /** Always `directlyFollows` here — the map is built from an OC-DFG. */
  basis?: 'petriNet' | 'directlyFollows';
  /** Marks a payload carrying the variant attribution this view needs. */
  variantBasis?: boolean;
  objectTypes: string[];
  nodes: MmNode[];
  edges: MmEdge[];
  /** The slider's own scale, most frequent variant first. */
  variants?: VariantSummary[];
  sliderPositions?: number;
}

export type { StationStyle } from 'metro-layout';
import type { StationStyle } from 'metro-layout';

export interface ViewParams {
  stationStyle: StationStyle;
  /** What to print on each arc — counted over the shown variants only. */
  edgeLabel: 'none' | 'frequency' | 'performance';
  animateFlow: boolean;
  /** When true (the default), the filtered view is ranked and laid out as a
   * monotone refinement of the whole log's own rank/lane — a station never
   * reshuffles as the slider adds or drops a variant, only ever settles
   * further down. When false, `relayoutVisible` computes rank and lane fresh
   * from *only* the currently visible stations and arcs, as if the other
   * variants did not exist, on every slider move. Off by default only in the
   * sense that a user has to find it: stability itself defaults on, following
   * the common assumption that a stable mental map helps — Häge & Rehse,
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
