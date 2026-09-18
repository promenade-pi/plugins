import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { injectCss } from '../lib/styleInject';
// @ts-ignore
import baseCss from '../lib/base.css';
import { useHostTheme } from '../lib/theme';
import { queryTables } from '../lib/sql';
import { useObjectTypes, useActivities } from '../lib/selectors';

injectCss(baseCss);

/**
 * Object Dynamics · Overview (spec §3/§21) — optional, lightweight
 * orientation and discovery only. It is a normal, independent view like any
 * other in the family: nothing else in Object Dynamics depends on it, and it
 * contains no full copy of any other view's chart. Its only job is a
 * handful of quick numbers and one-click launches into the other six views,
 * via `promenade.openView` — the same mechanism the core Overview's own
 * "Objects"/"Events" stat cards use in `ocelot`.
 */

interface Stats {
  objectTypes: number; activities: number;
  multiObjectTypeShare: number; totalEvents: number;
  variableMultiplicityCombos: number; repeatedLifecycleActivities: number;
}

async function loadStats(objectTypeCount: number, activityCount: number): Promise<Stats> {
  const [[multi], [variable], [repeated]] = await Promise.all([
    queryTables<{ total: number | bigint; multi: number | bigint }>(`
      WITH per_event AS (
        SELECT e.event_id, COUNT(DISTINCT o.object_type) AS n
        FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
        GROUP BY 1
      )
      SELECT COUNT(*) AS total, SUM(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS multi FROM per_event
    `),
    queryTables<{ n: number | bigint }>(`
      WITH per_event AS (
        SELECT e.event_id, e.activity, o.object_type, COUNT(DISTINCT r.object_id) AS n
        FROM {e2o} r JOIN {event} e ON e.event_id = r.event_id JOIN {object} o ON o.object_id = r.object_id
        GROUP BY 1, 2, 3
      )
      SELECT COUNT(*) AS n FROM (SELECT activity, object_type, MIN(n) AS mn, MAX(n) AS mx FROM per_event GROUP BY 1, 2) WHERE mn <> mx
    `),
    queryTables<{ n: number | bigint }>(`
      WITH per_object_activity AS (
        SELECT o.object_id, o.object_type, e.activity, COUNT(*) AS n
        FROM {object} o JOIN {e2o} r ON r.object_id = o.object_id JOIN {event} e ON e.event_id = r.event_id
        GROUP BY 1, 2, 3
      )
      SELECT COUNT(DISTINCT object_type || '::' || activity) AS n FROM per_object_activity WHERE n > 1
    `),
  ]);
  const total = Number(multi?.total ?? 0);
  return {
    objectTypes: objectTypeCount, activities: activityCount,
    totalEvents: total, multiObjectTypeShare: total ? Number(multi!.multi) / total : 0,
    variableMultiplicityCombos: Number(variable?.n ?? 0),
    repeatedLifecycleActivities: Number(repeated?.n ?? 0),
  };
}

function LaunchCard({ label, description, viewId, artifactId }: { label: string; description: string; viewId: string; artifactId: string }) {
  return (
    <button type="button" className="od-launch-card" onClick={() => { void promenade.openView(artifactId, viewId); }}>
      <div className="od-launch-title">{label}<span className="od-launch-arrow">→</span></div>
      <div className="od-launch-desc">{description}</div>
    </button>
  );
}

function App() {
  useHostTheme();
  const objectTypes = useObjectTypes();
  const activities = useActivities();
  const [stats, setStats] = useState<Stats | null>(null);
  const artifact = promenade.artifact();

  useEffect(() => {
    promenade.ready();
    loadStats(objectTypes.length, activities.length).then(setStats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="od-body">
      <div className="od-card-title" style={{ fontSize: 15 }}>Object Dynamics · {artifact.name}</div>
      <div className="od-metrics">
        <div className="od-metric"><div className="od-metric-value">{objectTypes.length}</div><div className="od-metric-label">Object types</div></div>
        <div className="od-metric"><div className="od-metric-value">{activities.length}</div><div className="od-metric-label">Activities</div></div>
        <div className="od-metric"><div className="od-metric-value">{stats ? `${Math.round(stats.multiObjectTypeShare * 100)}%` : '…'}</div><div className="od-metric-label">Events with &gt;1 object type</div></div>
        <div className="od-metric"><div className="od-metric-value">{stats?.variableMultiplicityCombos ?? '…'}</div><div className="od-metric-label">Variable-multiplicity combos</div></div>
        <div className="od-metric"><div className="od-metric-value">{stats?.repeatedLifecycleActivities ?? '…'}</div><div className="od-metric-label">Repeated lifecycle activities</div></div>
      </div>

      <div className="od-card-title" style={{ marginTop: 8 }}>Explore</div>
      <div className="od-launch-grid">
        <LaunchCard label="Multiplicity" description="How many objects of a type participate per event." viewId="run.promenade.object-dynamics.multiplicity" artifactId={artifact.id} />
        <LaunchCard label="Type Signatures" description="Which object types co-occur in the same events." viewId="run.promenade.object-dynamics.type-signatures" artifactId={artifact.id} />
        <LaunchCard label="Lifecycle Repetition" description="How often objects repeat an activity in their lifecycle." viewId="run.promenade.object-dynamics.lifecycle-repetition" artifactId={artifact.id} />
        <LaunchCard label="Activity Timing" description="Elapsed time from one activity to the next, per object." viewId="run.promenade.object-dynamics.activity-timing" artifactId={artifact.id} />
        <LaunchCard label="Attribute History" description="How one object's attributes evolved over its lifecycle." viewId="run.promenade.object-dynamics.attribute-history" artifactId={artifact.id} />
        <LaunchCard label="Attribute Distribution" description="Value distribution of an event or object attribute." viewId="run.promenade.object-dynamics.attribute-distribution" artifactId={artifact.id} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
