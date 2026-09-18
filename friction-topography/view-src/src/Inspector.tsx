/**
 * The panel that opens when a peak is clicked.
 *
 * The whole reason a performance overlay is worth building: a mountain tells an
 * analyst *that* the process stalls at a step, and answers nothing else. The
 * next five questions are always the same, and they are the tabs here - which
 * paths are stuck, which individual cases, what does the wait look like as a
 * distribution, and who or what does it depend on.
 *
 * Nothing in here is loaded until a peak is selected, and the tab-specific
 * queries wait until their tab is opened (`plugin.tsx` owns the loading). A
 * view that fires nine queries per click on a million-event log is a view
 * nobody clicks twice.
 */
import { useState } from 'react';

import { BreakdownBars, ClimbProfile, QueueDepth, WaitHistogram } from './Charts';
import { explain, isBimodal, type FilteredModel } from './model';
import type { Breakdown, CaseRow, Dimension, RouteStep, VariantRow } from './query';
import {
  FRICTION_LABEL, formatCount, formatDuration, formatFriction, formatPercent, frictionOf, isDuration,
  type ActivityStat, type FrictionMetric, type TopographyData,
} from './types';

export type Tab = 'overview' | 'variants' | 'cases' | 'splits' | 'waits';

/**
 * How many individual cases the list shows.
 *
 * They are already sorted worst-first, so the tail is the least interesting
 * part of a query that deliberately fetched more than it displays - the extra
 * rows are what "waited 2.6d" is ranked against.
 */
const CASE_ROWS = 24;

export const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Why' },
  { id: 'waits', label: 'Waits' },
  { id: 'splits', label: 'Splits' },
  { id: 'variants', label: 'Variants' },
  { id: 'cases', label: 'Cases' },
];

export const DIMENSIONS: Array<{ id: Dimension; label: string }> = [
  { id: 'predecessor', label: 'Arrived from' },
  { id: 'resource', label: 'Resource' },
  { id: 'hour', label: 'Hour of day' },
  { id: 'weekday', label: 'Weekday' },
  { id: 'position', label: 'Step in case' },
];

export interface Drill {
  activity: string;
  loadingCore: boolean;
  loadingTab: boolean;
  error: string | null;
  waits: number[];
  byPredecessor: Breakdown[];
  byResource: Breakdown[];
  byHour: Breakdown[];
  byDimension: Breakdown[];
  dimension: Dimension;
  attributeKeys: string[];
  attributeKey: string | null;
  byAttribute: Breakdown[];
  queue: { depth: number[]; peak: number; mean: number } | null;
  variants: VariantRow[] | null;
  cases: CaseRow[] | null;
}

export interface InspectorProps {
  data: TopographyData;
  model: FilteredModel;
  metric: FrictionMetric;
  activity: ActivityStat | null;
  /** `true` when the shown activity is the terrain's summit. */
  isSummit: boolean;
  drill: Drill | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onDimension: (dimension: Dimension) => void;
  onAttributeKey: (key: string) => void;
  onPickVariant: (variant: VariantRow | null) => void;
  onPickCase: (entity: string) => void;
  activeVariant: string | null;
  route: { label: string; steps: RouteStep[] } | null;
  onClearRoute: () => void;
  onClose: () => void;
  onFocus: () => void;
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'hot' | 'warn' | 'calm' }) {
  return (
    <div className={`ft-stat ft-stat-${tone ?? 'calm'}`}>
      <div className="ft-stat-value">{value}</div>
      <div className="ft-stat-label">{label}</div>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const { data, model, metric, activity, drill, tab } = props;
  const entityWord = data.objectCentric ? 'objects' : 'cases';
  const entityWordSingular = data.objectCentric ? 'object' : 'case';
  // Local, not a host param: whether this panel is tucked away is a per-
  // session convenience, and it persists across the idle/detail transition
  // because this component stays mounted for as long as the log is loaded.
  const [collapsed, setCollapsed] = useState(false);
  const collapseToggle = (
    <button
      type="button"
      className="ft-icon-button"
      onClick={() => setCollapsed((c) => !c)}
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );

  if (!activity) {
    const bottleneck = [...model.activities].sort((a, b) => frictionOf(b, metric) - frictionOf(a, metric))[0];
    return (
      <aside className={`ft-panel ft-panel-idle ${collapsed ? 'is-collapsed' : ''}`}>
        <div className="ft-panel-head">
          <div className="ft-panel-title">Friction topography</div>
          <div className="ft-panel-actions">{collapseToggle}</div>
        </div>
        {!collapsed && (
          <div className="ft-panel-body">
            <p className="ft-lead">
              Elevation is <strong>{FRICTION_LABEL[metric].toLowerCase()}</strong>. Valleys are the
              routine, high-volume path; ridges are where {entityWord} queue.
            </p>
            {bottleneck && (
              <p className="ft-lead">
                The summit is <strong>{bottleneck.activity}</strong> at{' '}
                {formatFriction(frictionOf(bottleneck, metric), metric)}.
              </p>
            )}
            <p className="ft-hint">
              Click a peak to open the {entityWord}, variants and wait distribution behind it.
              Drag to orbit, right-drag to pan, scroll to zoom.
            </p>
            <dl className="ft-facts">
              <div><dt>{data.objectCentric ? 'Objects' : 'Cases'}</dt><dd>{formatCount(data.overview.entities)}</dd></div>
              <div><dt>Events</dt><dd>{formatCount(data.overview.events)}</dd></div>
              <div><dt>Activities</dt><dd>{model.activities.length} of {data.overview.activities}</dd></div>
              <div><dt>Median cycle</dt><dd>{formatDuration(data.overview.medianCycleMs)}</dd></div>
              <div><dt>Flow shown</dt><dd>{formatPercent(model.edgeCoverage)}</dd></div>
              <div><dt>Total waiting</dt><dd>{formatDuration(data.overview.totalWaitMs)}</dd></div>
            </dl>
          </div>
        )}
      </aside>
    );
  }

  const share = data.overview.totalWaitMs > 0 ? activity.totalWait / data.overview.totalWaitMs : 0;
  const reasons = drill
    ? explain({
      activity, metric, data,
      byPredecessor: drill.byPredecessor,
      byResource: drill.byResource,
      byHour: drill.byHour,
      queue: drill.queue ?? undefined,
    })
    : [];

  return (
    <aside className={`ft-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="ft-panel-head">
        <div className="ft-panel-eyebrow">{props.isSummit ? 'Bottleneck' : 'Activity'}</div>
        <div className="ft-panel-title" title={activity.activity}>{activity.activity}</div>
        <div className="ft-panel-actions">
          {collapseToggle}
          <button type="button" className="ft-icon-button" onClick={props.onFocus} title="Fly to this peak">
            &#8599;
          </button>
          <button type="button" className="ft-icon-button" onClick={props.onClose} title="Close (Esc)">
            &times;
          </button>
        </div>
      </div>

      {!collapsed && (
      <>
      <div className="ft-stats">
        <Stat
          value={formatFriction(frictionOf(activity, metric), metric)}
          label={isDuration(metric) ? 'median wait' : 'of cases'}
          tone="hot"
        />
        <Stat value={formatPercent(share)} label="of all waiting" tone="warn" />
        <Stat value={formatPercent(activity.reworkRate)} label="repeat here" tone={activity.reworkRate > 0.15 ? 'warn' : 'calm'} />
      </div>

      <nav className="ft-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`ft-tab ${tab === entry.id ? 'is-active' : ''}`}
            onClick={() => props.onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="ft-panel-body">
        {drill?.error && <div className="ft-error">{drill.error}</div>}

        {/* Above the tab content, not below it: the selected route's climb
            profile is the answer to whatever the analyst just clicked, and a
            sixty-row case list would push it off the bottom of the panel. */}
        {props.route && (
          <div className="ft-route-card">
            <div className="ft-route-head">
              <span className="ft-route-title">Route: {props.route.label}</span>
              <button type="button" className="ft-icon-button" onClick={props.onClearRoute} title="Clear route">
                &times;
              </button>
            </div>
            <ClimbProfile steps={props.route.steps.map((s) => ({ activity: s.activity, waitMs: s.waitMs }))} />
          </div>
        )}

        {tab === 'overview' && (
          <>
            <h4 className="ft-section">Why it rises</h4>
            {drill?.loadingCore && <div className="ft-loading">Measuring the queue&hellip;</div>}
            {!drill?.loadingCore && (
              <ul className="ft-reasons">
                {reasons.map((reason, i) => (
                  <li key={i} className={`ft-reason ft-reason-${reason.kind}`}>{reason.text}</li>
                ))}
              </ul>
            )}
            {drill?.queue && drill.queue.peak > 0 && (
              <>
                <h4 className="ft-section">
                  {data.objectCentric ? 'Objects' : 'Cases'} waiting at the same time
                </h4>
                <QueueDepth depth={drill.queue.depth} peak={drill.queue.peak} mean={drill.queue.mean} />
              </>
            )}
            <h4 className="ft-section">Every metric here</h4>
            <dl className="ft-facts">
              <div><dt>Occurrences</dt><dd>{formatCount(activity.occurrences)}</dd></div>
              <div><dt>Distinct {entityWord}</dt><dd>{formatCount(activity.entities)}</dd></div>
              <div><dt>Median wait</dt><dd>{formatDuration(activity.medianWait)}</dd></div>
              <div><dt>Mean wait</dt><dd>{formatDuration(activity.meanWait)}</dd></div>
              <div><dt>p90 wait</dt><dd>{formatDuration(activity.p90Wait)}</dd></div>
              <div><dt>Longest wait</dt><dd>{formatDuration(activity.maxWait)}</dd></div>
              <div><dt>Total wait</dt><dd>{formatDuration(activity.totalWait)}</dd></div>
              <div><dt>Starts a {entityWordSingular}</dt><dd>{formatCount(activity.starts)}</dd></div>
              <div><dt>Ends one</dt><dd>{formatCount(activity.ends)}</dd></div>
              <div><dt>Immediate repeats</dt><dd>{formatCount(activity.selfLoops)}</dd></div>
            </dl>
          </>
        )}

        {tab === 'waits' && (
          <>
            <h4 className="ft-section">Distribution of the wait before this step</h4>
            {drill?.loadingCore && <div className="ft-loading">Sampling waits&hellip;</div>}
            {drill && !drill.loadingCore && (
              <WaitHistogram
                waits={drill.waits}
                median={activity.medianWait}
                p90={activity.p90Wait}
                bimodal={isBimodal(drill.waits)}
              />
            )}
            <div className="ft-note ft-note-quiet">
              Waiting time is measured as the gap since the {entityWordSingular}&apos;s previous event.
              An occurrence that starts a {entityWordSingular} has no measurable wait and is excluded
              rather than counted as zero.
            </div>
          </>
        )}

        {tab === 'splits' && drill && (
          <>
            <h4 className="ft-section">Split the wait by</h4>
            <div className="ft-chips">
              {DIMENSIONS.map((dimension) => (
                <button
                  key={dimension.id}
                  type="button"
                  className={`ft-chip ${drill.dimension === dimension.id ? 'is-active' : ''}`}
                  onClick={() => props.onDimension(dimension.id)}
                >
                  {dimension.label}
                </button>
              ))}
              {drill.attributeKeys.map((key) => (
                <button
                  key={`attr-${key}`}
                  type="button"
                  className={`ft-chip ${drill.attributeKey === key ? 'is-active' : ''}`}
                  onClick={() => props.onAttributeKey(key)}
                  title={`${data.objectCentric ? 'Object' : 'Case'} attribute`}
                >
                  {key}
                </button>
              ))}
            </div>
            {drill.loadingTab && <div className="ft-loading">Grouping&hellip;</div>}
            {!drill.loadingTab && (
              <BreakdownBars
                rows={drill.attributeKey ? drill.byAttribute : drill.byDimension}
                emptyLabel="This log carries no values for that split."
              />
            )}
            <div className="ft-legend-inline">
              <span><i className="ft-swatch-bar" /> median wait</span>
              <span><i className="ft-swatch-share" /> share of the wait here</span>
            </div>
          </>
        )}

        {tab === 'variants' && (
          <>
            <h4 className="ft-section">Paths through this step</h4>
            {(!drill || drill.variants === null) && <div className="ft-loading">Collecting variants&hellip;</div>}
            {drill?.variants?.length === 0 && <div className="ft-empty">No variant reaches this step.</div>}
            {drill?.variants && drill.variants.length > 0 && (
              <ul className="ft-list">
                {drill.variants.map((variant) => (
                  <li key={variant.signature}>
                    <button
                      type="button"
                      className={`ft-list-row ${props.activeVariant === variant.signature ? 'is-active' : ''}`}
                      onClick={() => props.onPickVariant(
                        props.activeVariant === variant.signature ? null : variant
                      )}
                      title={variant.signature}
                    >
                      <span className="ft-list-main">
                        {variant.activities.slice(0, 7).join(' › ')}
                        {variant.activities.length > 7 ? ' …' : ''}
                      </span>
                      <span className="ft-list-meta">
                        <b>{formatCount(variant.entities)}</b> {entityWord}
                        {' · '}cycle {formatDuration(variant.medianCycleMs)}
                        {variant.medianWaitHere > 0 && <> {' · '}here {formatDuration(variant.medianWaitHere)}</>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="ft-hint">
              Selecting a variant lights its route across the terrain, so its climb over this peak
              can be compared with the routine valley beside it.
            </div>
          </>
        )}

        {tab === 'cases' && (
          <>
            <h4 className="ft-section">
              Longest waits here, {entityWordSingular} by {entityWordSingular}
            </h4>
            {(!drill || drill.cases === null) && <div className="ft-loading">Ranking {entityWord}&hellip;</div>}
            {drill?.cases?.length === 0 && <div className="ft-empty">No measurable wait here.</div>}
            {drill?.cases && drill.cases.length > CASE_ROWS && (
              <div className="ft-hint">
                The {CASE_ROWS} longest waits, of {formatCount(drill.cases.length)} loaded.
              </div>
            )}
            {drill?.cases && drill.cases.length > 0 && (
              <ul className="ft-list">
                {drill.cases.slice(0, CASE_ROWS).map((row) => (
                  <li key={row.entity}>
                    <button
                      type="button"
                      className={`ft-list-row ${props.route && props.route.label === row.label ? 'is-active' : ''}`}
                      onClick={() => props.onPickCase(row.entity)}
                    >
                      <span className="ft-list-main">{row.label}</span>
                      <span className="ft-list-meta">
                        waited <b>{formatDuration(row.waitHere)}</b>
                        {' · '}{row.steps} steps
                        {' · '}cycle {formatDuration(row.cycleMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

      </div>
      </>
      )}
    </aside>
  );
}
