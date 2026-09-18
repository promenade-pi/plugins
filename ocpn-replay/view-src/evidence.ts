/**
 * `ObjectCentricReplayEvidence` as the ocpn-replay plugin emits it at 0.2.0,
 * plus the deterministic token simulator the animation replays.
 *
 * Mirrors `app/src/host/artifact/ocpn-replay-evidence.ts` and this plugin's
 * `docs/semantics.md`. Kept in sync by hand — a sandboxed view has no access
 * to the host's TypeScript sources.
 */
import type { OcpnArc, OcpnPayload, OcpnPlace, OcpnTransition } from './types';

export interface ReplayEventRow {
  eventId: string;
  tsMs?: number;
  support: number;
  logMoves: number;
  modelMoves: number;
}

export interface ExpectedInteractionField {
  pair: { a: string; b: string };
  binCount: number;
  mass: number[];
  population: 'replayed-events';
}

export type TraceStepKind = 'fire' | 'silent' | 'logmove';

export interface TraceStep {
  /** object id */
  o: string;
  /** object type */
  ot: string;
  /** transition id — absent for a log move */
  tr?: string;
  k: TraceStepKind;
}

export interface TraceFrame {
  /** event id */
  e: string;
  /** epoch ms */
  t: number;
  /** activity label */
  a: string;
  steps: TraceStep[];
}

export interface ReplayTrace {
  limit: number;
  truncated: boolean;
  objectTypes: string[];
  frames: TraceFrame[];
}

export interface ReplayEvidence {
  schemaVersion: 1;
  sourceArtifactId: string;
  modelArtifactId: string;
  replay: { engineId: string; engineVersion: string; ordering: string; completed: true };
  events: ReplayEventRow[];
  expectedFields?: ExpectedInteractionField[];
  net?: OcpnPayload;
  trace?: ReplayTrace | null;
  stats?: Record<string, unknown>;
}

/** A view is sometimes handed only `{ net }` (a live run that has not finished). */
export interface PartialEvidence {
  net?: OcpnPayload;
}

// ---------------------------------------------------------------------------

type Weights = Map<string, Map<string, number>>; // transitionId -> placeId -> count

interface CompiledNet {
  /** object type -> its source place ids */
  sources: Map<string, string[]>;
  /** object type -> transition-input weights */
  inputs: Map<string, Weights>;
  /** object type -> transition-output weights */
  outputs: Map<string, Weights>;
  /** activity label -> visible transition ids */
  byActivity: Map<string, string[]>;
  places: Map<string, OcpnPlace>;
  transitions: Map<string, OcpnTransition>;
}

export function compileNet(net: OcpnPayload): CompiledNet {
  const types = new Set(net.objectTypes);
  const sources = new Map<string, string[]>();
  const inputs = new Map<string, Weights>();
  const outputs = new Map<string, Weights>();
  const byActivity = new Map<string, string[]>();
  for (const t of types) {
    sources.set(t, []);
    inputs.set(t, new Map());
    outputs.set(t, new Map());
  }
  for (const p of net.places) {
    if (p.kind === 'source' && types.has(p.objectType)) sources.get(p.objectType)!.push(p.id);
  }
  for (const t of net.transitions) {
    if (t.activity != null) {
      const list = byActivity.get(t.activity) ?? [];
      list.push(t.id);
      byActivity.set(t.activity, list);
    }
  }
  const bump = (w: Weights, tr: string, place: string) => {
    const row = w.get(tr) ?? new Map<string, number>();
    row.set(place, (row.get(place) ?? 0) + 1);
    w.set(tr, row);
  };
  for (const a of net.arcs as OcpnArc[]) {
    if (!types.has(a.objectType)) continue;
    if (a.source.kind === 'place' && a.target.kind === 'transition') {
      bump(inputs.get(a.objectType)!, a.target.id, a.source.id);
    } else if (a.source.kind === 'transition' && a.target.kind === 'place') {
      bump(outputs.get(a.objectType)!, a.source.id, a.target.id);
    }
  }
  return {
    sources, inputs, outputs, byActivity,
    places: new Map(net.places.map((p) => [p.id, p])),
    transitions: new Map(net.transitions.map((t) => [t.id, t])),
  };
}

export type Marking = Map<string, number>; // placeId -> tokens

export interface PlaceTokens {
  /** total tokens across every object currently sitting in this place */
  count: number;
  /** how many distinct objects hold a token here */
  objects: number;
}

/** What the last-applied frame did, for the highlight layer. */
export interface FrameEffect {
  firedTransitions: Set<string>;
  silentTransitions: Set<string>;
  logMoveTransitions: Set<string>;
  frameIndex: number;
}

const EMPTY_EFFECT: FrameEffect = {
  firedTransitions: new Set(), silentTransitions: new Set(),
  logMoveTransitions: new Set(), frameIndex: -1,
};

/**
 * Replays `frames` step by step against the compiled net. Markings are derived
 * here, never read from the payload. `seekTo` is O(distance from the nearest
 * checkpoint), so a scrub over thousands of frames stays interactive.
 */
export class TokenSim {
  private net: CompiledNet;
  private frames: TraceFrame[];
  private checkpoints: Array<Map<string, Marking>> = [];
  private readonly stride = 250;
  /** live marking at `cursor` (number of frames applied) */
  private markings = new Map<string, Marking>();
  private cursor = 0;
  effect: FrameEffect = EMPTY_EFFECT;

  constructor(net: OcpnPayload, frames: TraceFrame[]) {
    this.net = compileNet(net);
    this.frames = frames;
    this.checkpoints.push(new Map());
  }

  get frameCount() { return this.frames.length; }
  get position() { return this.cursor; }

  setFrames(frames: TraceFrame[]) {
    // Live mode appends; existing frames never change, so checkpoints stay valid.
    this.frames = frames;
  }

  private seed(objectType: string): Marking {
    const m: Marking = new Map();
    for (const p of this.net.sources.get(objectType) ?? []) m.set(p, 1);
    return m;
  }

  /** Ensure an object has a marking — its source-place token — the first time
   * the trace mentions it, even for a log move it could not replay. */
  private ensure(step: TraceStep): Marking {
    let m = this.markings.get(step.o);
    if (!m) { m = this.seed(step.ot); this.markings.set(step.o, m); }
    return m;
  }

  private fire(step: TraceStep) {
    if (!step.tr) return;
    const m = this.ensure(step);
    for (const [place, n] of this.net.inputs.get(step.ot)?.get(step.tr) ?? []) {
      m.set(place, Math.max(0, (m.get(place) ?? 0) - n));
      if ((m.get(place) ?? 0) === 0) m.delete(place);
    }
    for (const [place, n] of this.net.outputs.get(step.ot)?.get(step.tr) ?? []) {
      m.set(place, (m.get(place) ?? 0) + n);
    }
  }

  private applyFrame(frame: TraceFrame): FrameEffect {
    const eff: FrameEffect = {
      firedTransitions: new Set(), silentTransitions: new Set(),
      logMoveTransitions: new Set(), frameIndex: -1,
    };
    for (const step of frame.steps) {
      if (step.k === 'logmove') {
        this.ensure(step);
        for (const tr of this.net.byActivity.get(frame.a) ?? []) eff.logMoveTransitions.add(tr);
        continue;
      }
      this.fire(step);
      if (step.tr) (step.k === 'silent' ? eff.silentTransitions : eff.firedTransitions).add(step.tr);
    }
    return eff;
  }

  private cloneMarkings(src: Map<string, Marking>): Map<string, Marking> {
    const out = new Map<string, Marking>();
    for (const [obj, m] of src) out.set(obj, new Map(m));
    return out;
  }

  /** Move to exactly `target` frames applied (0 = initial marking). */
  seekTo(target: number) {
    const clamped = Math.max(0, Math.min(this.frames.length, Math.round(target)));
    const cpIndex = Math.min(Math.floor(clamped / this.stride), this.checkpoints.length - 1);
    let from = cpIndex * this.stride;
    if (clamped >= this.cursor && this.cursor >= from) {
      from = this.cursor; // already ahead of the checkpoint — keep going forward
    } else {
      this.markings = this.cloneMarkings(this.checkpoints[cpIndex]);
    }
    let lastEffect = EMPTY_EFFECT;
    for (let i = from; i < clamped; i++) {
      lastEffect = this.applyFrame(this.frames[i]);
      lastEffect.frameIndex = i;
      const nextCp = (this.checkpoints.length) * this.stride;
      if (i + 1 === nextCp) this.checkpoints.push(this.cloneMarkings(this.markings));
    }
    this.cursor = clamped;
    this.effect = clamped === 0 ? EMPTY_EFFECT : lastEffect;
  }

  step(delta: number) { this.seekTo(this.cursor + delta); }

  /** Tokens per place at the current cursor. */
  placeTokens(): Map<string, PlaceTokens> {
    const out = new Map<string, PlaceTokens>();
    for (const m of this.markings.values()) {
      for (const [place, n] of m) {
        if (n <= 0) continue;
        const cur = out.get(place) ?? { count: 0, objects: 0 };
        cur.count += n;
        cur.objects += 1;
        out.set(place, cur);
      }
    }
    return out;
  }

  currentFrame(): TraceFrame | null {
    return this.cursor > 0 ? this.frames[this.cursor - 1] ?? null : null;
  }
}
