import type { CSSProperties } from 'react';
import { PHASE_LABEL, type PipelineProgress } from './pipeline';

/**
 * The view's waiting states.
 *
 * Kept out of `plugin.tsx` so they can be rendered and asserted without a
 * browser (see `pipeline.check.ts`) — the progress readout is the only
 * evidence a user gets that a long extraction is alive, so "it renders the
 * phase, a real count and a way out" is worth checking rather than assuming.
 */
/** Three of the swimlane's own chevron shapes, pulsing left-to-right in a
 * staggered wave — an indefinite spinner built from the view's own visual
 * language instead of a generic spinner, so it still reads as "this view is
 * about to show you chevrons" while the extraction (which has no known
 * duration to progress-bar against) runs. */
const LOADING_CHEVRON_COLORS = ['#6366f1', '#ec4899', '#14b8a6'];
export function LoadingChevrons({ label, progress, onCancel }: {
  label: string;
  /** Absent until the first slice reports — and for the brief phases that
   * have nothing meaningful to count. */
  progress?: PipelineProgress | null;
  onCancel?: () => void;
}) {
  const pct = progress ? Math.round(progress.overall * 100) : null;
  return <div className="oc-loading">
    <div className="oc-loading-chevrons" aria-hidden="true">
      {LOADING_CHEVRON_COLORS.map((c, i) => <span
        key={c}
        className="oc-loading-chevron"
        style={{ '--c': c, animationDelay: `${i * 0.18}s` } as CSSProperties}
      />)}
    </div>
    <span>{progress ? PHASE_LABEL[progress.phase] : label}…</span>
    {progress && <>
      {/* A real count, not a timer: `done`/`total` are executions actually
          finished, so the bar cannot run ahead of the work. */}
      <div className="oc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className="oc-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="oc-loading-detail">
        {pct}%
        {progress.total > 1 && ` · ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`}
      </span>
    </>}
    {onCancel && <button type="button" className="oc-cancel" onClick={onCancel}>Cancel</button>}
  </div>;
}

/** Shown after the user stops a run, instead of an empty view that would
 * look like a result. */
export function CanceledNotice({ onRetry }: { onRetry: () => void }) {
  return <div className="oc-loading">
    <span>Extraction canceled.</span>
    <span className="oc-loading-detail">Nothing was computed, so there is nothing to show yet.</span>
    <button type="button" className="oc-cancel" onClick={onRetry}>Try again</button>
  </div>;
}

