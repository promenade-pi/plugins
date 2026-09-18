// Local Process Models ranking view.
//
// No React Flow, no diagram of its own: a fragment is a Petri-net-shaped
// object, and `plugins/petrinet-layered`/`plugins/ocpn-flow-view` already
// render exactly that (accepting-net and object-centric-net respectively) for
// any producer, including this plugin's own "→ Petri Net"/"→ Object-Centric
// Petri Net" conversion actions. Duplicating a Petri-net renderer here would
// be the "no core-only shortcuts" problem in reverse — reinventing a plugin
// that already exists — so this view's whole job is the part that doesn't
// exist anywhere else yet: a ranked, filterable, colour-coded table over the
// discovered fragments. Vanilla DOM, not React: a table with a filter box
// needs neither the dependency nor the bundle weight.
import type { DiscoverResult, ResultEntry } from './types';

const root = document.getElementById('root') ?? (() => {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.appendChild(el);
  return el;
})();

const style = document.createElement('style');
style.textContent = `
  :root, body { margin: 0; padding: 0; }
  body {
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--text, #1a1a1a);
    background: var(--bg, #fff);
  }
  #root { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .lpm-header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 8px 12px; border-bottom: 1px solid var(--border, #e2e2e2);
    background: var(--bg-soft, #f7f7f7);
  }
  .lpm-stat { color: var(--text-dim, #666); font-variant-numeric: tabular-nums; }
  .lpm-warn {
    color: var(--warn, #9a6700); background: var(--bg-sunken, #fff3cd);
    border-radius: 4px; padding: 2px 6px;
  }
  .lpm-filter {
    margin-left: auto; padding: 4px 8px; border: 1px solid var(--border, #ccc);
    border-radius: 4px; font: inherit; background: var(--bg, #fff); color: inherit;
    min-width: 160px;
  }
  .lpm-table-wrap { flex: 1; overflow: auto; }
  table.lpm-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .lpm-table th, .lpm-table td { padding: 6px 10px; text-align: left; white-space: nowrap; }
  .lpm-table th {
    position: sticky; top: 0; background: var(--bg-soft, #f7f7f7);
    border-bottom: 1px solid var(--border, #e2e2e2); cursor: pointer; user-select: none;
    color: var(--text-dim, #666); font-weight: 600;
  }
  .lpm-table th.sorted { color: var(--accent, #2563eb); }
  .lpm-table tbody tr { border-bottom: 1px solid var(--border, #eee); cursor: pointer; }
  .lpm-table tbody tr:hover { background: var(--bg-soft, #f7f7f7); }
  .lpm-rank { color: var(--text-dim, #666); }
  .lpm-tree { font-family: ui-monospace, monospace; white-space: normal; }
  .lpm-chip {
    display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px;
    margin: 1px 3px 1px 0; color: #fff;
  }
  .lpm-bar-wrap {
    display: inline-flex; align-items: center; gap: 6px; min-width: 70px;
  }
  .lpm-bar { width: 44px; height: 6px; border-radius: 3px; background: var(--bg-sunken, #eee); overflow: hidden; }
  .lpm-bar > span { display: block; height: 100%; background: var(--accent, #2563eb); }
  .lpm-empty { padding: 24px; text-align: center; color: var(--text-dim, #666); }
`;
document.head.appendChild(style);

root.innerHTML = '';
const header = document.createElement('div');
header.className = 'lpm-header';
const statsEl = document.createElement('span');
statsEl.className = 'lpm-stat';
const warnEl = document.createElement('span');
warnEl.className = 'lpm-warn';
warnEl.hidden = true;
warnEl.textContent = 'search stopped early (time budget) — results may be incomplete';
const filterEl = document.createElement('input');
filterEl.type = 'search';
filterEl.placeholder = 'filter by activity…';
filterEl.className = 'lpm-filter';
header.append(statsEl, warnEl, filterEl);

const tableWrap = document.createElement('div');
tableWrap.className = 'lpm-table-wrap';
root.append(header, tableWrap);

type SortKey = 'rank' | keyof ResultEntry['scores'];
let sortKey: SortKey = 'rank';
let sortAsc = true;
let filterText = '';
let data: DiscoverResult | null = null;

const METRIC_COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'weightedScore', label: 'score', title: 'Weighted combination of every metric below.' },
  { key: 'support', label: 'support', title: 'How often this fragment occurs (squashed occurrence count).' },
  { key: 'confidence', label: 'confidence', title: "How much of each activity's own occurrences this fragment accounts for." },
  { key: 'determinism', label: 'determinism', title: 'How little ambiguity there is about what happens next while replaying it.' },
  { key: 'languageFit', label: 'lang. fit', title: 'How much of the fragment’s own possible behaviour was actually observed.' },
  { key: 'coverage', label: 'coverage', title: "Fraction of the whole log's events in this fragment's own activity set." },
  { key: 'avgNumFirings', label: 'avg. firings', title: 'Average number of activities fired per occurrence.' },
];

function metricValue(e: ResultEntry, key: SortKey): number {
  if (key === 'rank') return e.rank;
  return e.scores[key] as number;
}

function bar(value: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'lpm-bar-wrap';
  const track = document.createElement('span');
  track.className = 'lpm-bar';
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
  track.appendChild(fill);
  const num = document.createElement('span');
  num.textContent = value.toFixed(2);
  wrap.append(track, num);
  return wrap;
}

function render() {
  if (!data) {
    tableWrap.innerHTML = '<div class="lpm-empty">no local process models yet</div>';
    return;
  }
  const { entries, stats } = data;
  statsEl.textContent =
    `${entries.length} shown · ${stats.candidatesScored.toLocaleString()} candidates scored · ` +
    `${stats.totalCases.toLocaleString()} cases · ${stats.distinctActivities} activities considered`;
  warnEl.hidden = !stats.truncatedBySearchBudget;

  const needle = filterText.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((e) => e.activities.some((a) => a.toLowerCase().includes(needle)))
    : entries.slice();

  filtered.sort((a, b) => {
    const d = metricValue(a, sortKey) - metricValue(b, sortKey);
    return sortAsc ? d : -d;
  });

  const table = document.createElement('table');
  table.className = 'lpm-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const rankTh = document.createElement('th');
  rankTh.textContent = '#';
  rankTh.title = 'Pass this as the "Fragment rank" (index) parameter of "Local Process Model → Petri Net" to view it as a diagram.';
  headRow.appendChild(rankTh);
  const treeTh = document.createElement('th');
  treeTh.textContent = 'fragment';
  headRow.appendChild(treeTh);
  for (const col of METRIC_COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.title = col.title;
    if (sortKey === col.key) th.classList.add('sorted');
    th.addEventListener('click', () => {
      if (sortKey === col.key) sortAsc = !sortAsc;
      else { sortKey = col.key; sortAsc = false; }
      render();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const entry of filtered) {
    const tr = document.createElement('tr');
    tr.addEventListener('click', () => {
      promenade.select(entry.activities.map((a) => ({ kind: 'activity' as const, id: a })));
    });

    const rankTd = document.createElement('td');
    rankTd.className = 'lpm-rank';
    rankTd.textContent = String(entry.rank);
    tr.appendChild(rankTd);

    const treeTd = document.createElement('td');
    treeTd.className = 'lpm-tree';
    for (const a of entry.activities) {
      const chip = document.createElement('span');
      chip.className = 'lpm-chip';
      chip.textContent = a;
      try { chip.style.background = promenade.color('activity', a); } catch { /* harness without a colour registry */ }
      treeTd.appendChild(chip);
    }
    const pretty = document.createElement('div');
    pretty.textContent = entry.pretty;
    pretty.style.opacity = '0.75';
    treeTd.appendChild(pretty);
    tr.appendChild(treeTd);

    for (const col of METRIC_COLUMNS) {
      const td = document.createElement('td');
      td.appendChild(bar(metricValue(entry, col.key)));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  tableWrap.innerHTML = '';
  if (!filtered.length) {
    tableWrap.innerHTML = '<div class="lpm-empty">no fragments match this filter</div>';
  } else {
    tableWrap.appendChild(table);
  }
}

filterEl.addEventListener('input', () => {
  filterText = filterEl.value;
  render();
});

promenade.on('theme', () => { /* CSS variables the host sets on the frame's root already do the work */ });

const artifact = promenade.artifact();
data = (artifact.value as DiscoverResult) ?? null;
render();
promenade.ready();
