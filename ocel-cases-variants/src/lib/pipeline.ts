import { executionSteps, summarizeVariants, type ExecutionDetail, type RawData, type VariantSummary } from './executions';
import { variantSteps } from './isomorphism';

/**
 * Runs the view's computation without freezing the tab.
 *
 * The problem this solves, measured on the Logistics log (10,553 executions):
 * the whole pipeline was one uninterrupted synchronous block, long enough
 * that Chrome offered to kill the page. The work is now driven in slices —
 * a generator is resumed until a time budget is spent, then control goes
 * back to the browser so it can paint, run the progress UI and notice a
 * click on Cancel.
 *
 * There is no Worker to escape to: the sandboxed view frame's CSP is
 * `default-src 'none'` with no `worker-src`, so `new Worker` is blocked.
 * Cooperative slicing on the main thread is the whole of what is available,
 * which is why the stages were written as generators rather than plain loops.
 */

/** How long to hold the main thread before handing it back. One slice is
 * under a frame at 60Hz, so the progress bar keeps animating and a click on
 * Cancel is noticed promptly, while the per-slice yield overhead stays a
 * rounding error against seconds of real work. */
const SLICE_MS = 12;

export type PipelinePhase = 'graph' | 'extract' | 'scope' | 'build' | 'hash' | 'classify' | 'summarize';

export interface PipelineProgress {
  phase: PipelinePhase;
  /** 0..1 within the current phase, or null when the phase is indivisible. */
  fraction: number | null;
  done: number;
  total: number;
  /** 0..1 across the whole run, for a single honest bar. */
  overall: number;
}

/** Human wording for each phase — kept here so the view renders, not decides. */
export const PHASE_LABEL: Record<PipelinePhase, string> = {
  graph: 'Building the object graph',
  extract: 'Extracting process executions',
  scope: 'Scoping shared objects',
  build: 'Building execution graphs',
  hash: 'Fingerprinting executions',
  classify: 'Grouping into variants',
  summarize: 'Summarising variants',
};

/**
 * Rough share of total runtime per phase, used only to turn several
 * sequential phases into one non-jumping bar. From the Logistics profile
 * (extract ~2.3s, build ~0.4s, hash ~1.7s, classify ~1.8s); being
 * approximate is fine — the bar stays monotonic either way, which is the
 * only property that actually matters to someone watching it.
 */
const PHASE_WEIGHT: Record<PipelinePhase, number> = {
  graph: 0.02, extract: 0.36, scope: 0.02, build: 0.08, hash: 0.26, classify: 0.25, summarize: 0.01,
};
const PHASE_ORDER: PipelinePhase[] = ['graph', 'extract', 'scope', 'build', 'hash', 'classify', 'summarize'];

function overallFor(phase: PipelinePhase, fraction: number): number {
  let before = 0;
  for (const p of PHASE_ORDER) {
    if (p === phase) break;
    before += PHASE_WEIGHT[p];
  }
  return Math.min(1, before + PHASE_WEIGHT[phase] * fraction);
}

/**
 * Hands control back to the browser.
 *
 * `setTimeout(0)` is clamped to ~4ms once nested, which would trebled the
 * cost of a 12ms slice; a `MessageChannel` message is an unclamped macrotask,
 * so the browser gets its turn (paint, input) without the timer penalty.
 * `scheduler.yield()` is preferred where it exists, since it returns control
 * at a higher priority than an ordinary task.
 */
function makeYielder(): { yieldToBrowser: () => Promise<void>; dispose: () => void } {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    return { yieldToBrowser: () => scheduler.yield!(), dispose: () => {} };
  }
  const channel = new MessageChannel();
  let resolveCurrent: (() => void) | null = null;
  channel.port1.onmessage = () => {
    const resolve = resolveCurrent;
    resolveCurrent = null;
    resolve?.();
  };
  return {
    yieldToBrowser: () => new Promise<void>((resolve) => {
      resolveCurrent = resolve;
      channel.port2.postMessage(null);
    }),
    // An open port keeps a reference alive for as long as the page does, so
    // a run per params change would quietly accumulate channels. (It also
    // keeps Node's event loop from draining, which is how this surfaced.)
    dispose: () => { channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); },
  };
}

/** Thrown, and swallowed by `runPipeline`, when the caller cancels. */
export class Canceled extends Error {
  constructor() { super('canceled'); this.name = 'Canceled'; }
}

export interface PipelineOptions {
  /** Polled between slices; returning true stops the run promptly. */
  isCanceled: () => boolean;
  onProgress: (progress: PipelineProgress) => void;
}

export interface PipelineResult {
  executions: ExecutionDetail[];
  variantSummaries: VariantSummary[];
}

/**
 * Drives one generator in time slices, reporting progress and honouring
 * cancellation. Returns whatever the generator returns.
 */
async function drive<P extends { phase: PipelinePhase; done: number; total: number }, R>(
  steps: Generator<P, R, void>,
  options: PipelineOptions,
  yieldToBrowser: () => Promise<void>,
): Promise<R> {
  let next = steps.next();
  let sliceStart = performance.now();
  while (!next.done) {
    const { phase, done, total } = next.value;
    if (performance.now() - sliceStart >= SLICE_MS) {
      const fraction = total > 0 ? done / total : 0;
      options.onProgress({ phase, fraction: total > 1 ? fraction : null, done, total, overall: overallFor(phase, fraction) });
      await yieldToBrowser();
      // Checked after the yield, so a click that lands during it is seen on
      // this turn rather than a slice later.
      if (options.isCanceled()) {
        // Let the generator run its `finally` blocks instead of abandoning it.
        steps.return(undefined as never);
        throw new Canceled();
      }
      sliceStart = performance.now();
    }
    next = steps.next();
  }
  return next.value;
}

/**
 * The whole computation: raw log tables in, executions and variant summaries
 * out, in slices. Resolves to `null` if it was canceled.
 */
export async function runPipeline(
  args: {
    extraction: 'leadingType' | 'connectedComponents';
    leadingType: string;
    raw: RawData;
    maxEvents: number;
    scopeSharedObjects: boolean;
  },
  options: PipelineOptions,
): Promise<PipelineResult | null> {
  const { yieldToBrowser, dispose } = makeYielder();
  try {
    options.onProgress({ phase: 'graph', fraction: null, done: 0, total: 1, overall: 0 });
    const executions = await drive(
      executionSteps(args.extraction, args.leadingType, args.raw, args.maxEvents, args.scopeSharedObjects),
      options, yieldToBrowser,
    );

    const groups = await drive(variantSteps(executions), options, yieldToBrowser);

    // Cheap next to everything above (reductions over already-built arrays),
    // so it is one step rather than a sliced phase.
    options.onProgress({ phase: 'summarize', fraction: null, done: 0, total: 1, overall: overallFor('summarize', 0) });
    await yieldToBrowser();
    if (options.isCanceled()) return null;
    const variantSummaries = summarizeVariants(executions, groups);

    options.onProgress({ phase: 'summarize', fraction: null, done: 1, total: 1, overall: 1 });
    return { executions, variantSummaries };
  } catch (e) {
    if (e instanceof Canceled) return null;
    throw e;
  } finally {
    dispose();
  }
}
