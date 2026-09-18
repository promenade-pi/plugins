/* Event Log Comparison report — dependency-free sandboxed view. */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var r = (promenade.artifact() || {}).value || {};

  var C = {
    text: 'var(--text,#20242d)', dim: 'var(--text-dim,#687386)', line: 'var(--border,#dce2ea)',
    paper: 'var(--bg,#fff)', soft: 'var(--panel,#f6f8fb)',
    ok: '#087f5b', warn: '#d98916', bad: '#c4374f', blue: '#165dff',
  };

  root.style.cssText = 'height:100%;overflow:auto;background:' + C.paper + ';color:' + C.text +
    ';font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif';

  function e(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }
  function pct(x) { return (Number(x || 0) * 100).toFixed(1) + '%'; }
  function signed(x) { return (x > 0 ? '+' : '') + String(x || 0); }

  var VERDICT = {
    'strict-equal': { label: 'Strictly equal', tone: C.ok, blurb: 'Every relation is an identical set of tuples — identifiers, type names, timestamps, attribute values and both relations all match.' },
    'structurally-equivalent': { label: 'Structurally equivalent', tone: C.ok, blurb: 'A bijection renaming only identifiers makes the two logs identical. Type names and every value are preserved.' },
    'equivalent-up-to-rename': { label: 'Equivalent up to renaming', tone: C.warn, blurb: 'A bijection renaming identifiers and some type names makes the logs identical. See suspected renames below.' },
    'different': { label: 'Different', tone: C.bad, blurb: 'No label-preserving bijection exists. See coverage and per-relation differences below.' },
    'undetermined': { label: 'Undetermined', tone: C.dim, blurb: 'The structural check could not decide within its bounds. Strict equality and coverage are still exact.' },
  };

  var wrap = e('div', 'max-width:1120px;margin:0 auto;padding:22px 26px 40px');
  root.appendChild(wrap);

  // ---- header + verdict ------------------------------------------------------
  var v = VERDICT[r.verdict] || VERDICT.undetermined;
  wrap.appendChild(e('h1', 'margin:0 0 2px;font-size:21px;letter-spacing:-.01em', 'Event log comparison'));
  var sb = r.stats && r.stats.baseline || {}, sc = r.stats && r.stats.candidate || {};
  wrap.appendChild(e('p', 'margin:0 0 16px;color:' + C.dim,
    'baseline ' + fmt(sb.events) + ' events / ' + fmt(sb.objects) + ' objects   ·   candidate ' +
    fmt(sc.events) + ' events / ' + fmt(sc.objects) + ' objects'));

  var banner = e('div', 'border:1px solid ' + C.line + ';border-left:5px solid ' + v.tone +
    ';border-radius:9px;padding:13px 15px;background:' + C.soft + ';margin-bottom:22px');
  banner.appendChild(e('div', 'font-size:16px;font-weight:700;color:' + v.tone, v.label));
  banner.appendChild(e('div', 'margin-top:3px;color:' + C.dim, v.blurb));
  if (r.structural && r.structural.reason) {
    banner.appendChild(e('div', 'margin-top:6px;font-size:12px;color:' + C.dim, 'Structural check: ' + r.structural.reason));
  }
  wrap.appendChild(banner);

  // ---- strict equality per relation ----------------------------------------
  section('Strict equality — per relation');
  var strict = r.strict || {};
  var t = table(['Relation', 'Baseline', 'Candidate', 'Only in baseline', 'Only in candidate', '']);
  (strict.relations || []).forEach(function (row) {
    var tr = e('tr');
    td(tr, row.relation, 'font-weight:600');
    td(tr, row.present.baseline ? fmt(row.baselineTotal) : '—');
    td(tr, row.present.candidate ? fmt(row.candidateTotal) : '—');
    td(tr, fmt(row.baselineOnly), row.baselineOnly ? 'color:' + C.bad : '');
    td(tr, fmt(row.candidateOnly), row.candidateOnly ? 'color:' + C.bad : '');
    td(tr, row.equal ? '✓ equal' : '≠ differs', 'color:' + (row.equal ? C.ok : C.bad) + ';font-weight:700');
    t.appendChild(tr);
  });
  wrap.appendChild(t);

  var diffRows = (strict.relations || []).filter(function (row) { return !row.equal && sampleCount(row); });
  if (diffRows.length) {
    var det = e('details', 'margin-top:10px;border:1px solid ' + C.line + ';border-radius:7px;padding:8px 11px;background:' + C.paper);
    det.appendChild(e('summary', 'cursor:pointer;font-weight:600', 'Sample differing tuples'));
    diffRows.forEach(function (row) {
      det.appendChild(e('div', 'margin-top:8px;font-weight:600', row.relation));
      renderSamples(det, 'only in baseline', (row.samples || {}).baselineOnly);
      renderSamples(det, 'only in candidate', (row.samples || {}).candidateOnly);
    });
    wrap.appendChild(det);
  }

  // ---- coverage ------------------------------------------------------------
  if (!strict.equal) {
    section('Coverage');
    var cov = r.coverage || {};
    [['events', 'Events'], ['objects', 'Objects'], ['eventTypes', 'Event types'], ['objectTypes', 'Object types']]
      .forEach(function (pair) {
        var c = cov[pair[0]]; if (!c) return;
        wrap.appendChild(coverageRow(pair[1], c));
      });

    var deltas = (cov.perObjectType || []).concat([]).filter(function (d) { return d.delta !== 0; });
    var actDeltas = (cov.perActivity || []).filter(function (d) { return d.delta !== 0; });
    if (deltas.length || actDeltas.length) {
      var dd = e('details', 'margin-top:12px;border:1px solid ' + C.line + ';border-radius:7px;padding:8px 11px');
      dd.appendChild(e('summary', 'cursor:pointer;font-weight:600', 'Per-type count differences (' + (deltas.length + actDeltas.length) + ')'));
      var dt = table(['Kind', 'Name', 'Baseline', 'Candidate', 'Δ']);
      actDeltas.forEach(function (d) { deltaRow(dt, 'activity', d); });
      deltas.forEach(function (d) { deltaRow(dt, 'object type', d); });
      dd.appendChild(dt);
      wrap.appendChild(dd);
    }
  }

  // ---- suspected renames -------------------------------------------------
  var renames = r.suspectedRenames || [];
  if (renames.length) {
    section('Suspected automatic renames');
    wrap.appendChild(e('p', 'margin:0 0 8px;color:' + C.dim,
      'Names present in one log but not the other that look like the same thing under a different label ' +
      '(case, whitespace, or normalisation — e.g. a SQLite export sanitising a table name).'));
    var rt = table(['Kind', 'Baseline name', 'Candidate name', 'Normalised equal', 'Jaro–Winkler', 'Edit distance']);
    renames.forEach(function (row) {
      var tr = e('tr');
      td(tr, kindLabel(row.kind));
      td(tr, row.baseline, 'font-family:ui-monospace,monospace');
      td(tr, row.candidate, 'font-family:ui-monospace,monospace');
      td(tr, row.normalizedEqual ? 'yes' : 'no', 'color:' + (row.normalizedEqual ? C.ok : C.dim));
      td(tr, Number(row.jaroWinkler).toFixed(3));
      td(tr, String(row.levenshtein));
      rt.appendChild(tr);
    });
    wrap.appendChild(rt);
  }

  // ---- structural detail -------------------------------------------------
  if (r.structural && r.structural.phi) {
    var phi = r.structural.phi;
    var renamedET = phi.eventTypesRenamed || [], renamedOT = phi.objectTypesRenamed || [];
    if (renamedET.length || renamedOT.length) {
      section('Type renaming under the bijection');
      var pt = table(['Kind', 'Baseline', 'Candidate']);
      renamedET.forEach(function (k) { var tr = e('tr'); td(tr, 'event type'); td(tr, k, 'font-family:ui-monospace,monospace'); td(tr, (phi.eventTypeMap || {})[k], 'font-family:ui-monospace,monospace'); pt.appendChild(tr); });
      renamedOT.forEach(function (k) { var tr = e('tr'); td(tr, 'object type'); td(tr, k, 'font-family:ui-monospace,monospace'); td(tr, (phi.objectTypeMap || {})[k], 'font-family:ui-monospace,monospace'); pt.appendChild(tr); });
      wrap.appendChild(pt);
    }
  }
  if (r.structural && (r.structural.diverging || []).length) {
    section('Where the structural check diverged');
    var xt = table(['Kind', 'Baseline count', 'Candidate count', 'Example']);
    r.structural.diverging.forEach(function (d) {
      var tr = e('tr');
      td(tr, d.kind);
      td(tr, String(d.baselineCount));
      td(tr, String(d.candidateCount));
      td(tr, JSON.stringify(d.example));
      xt.appendChild(tr);
    });
    wrap.appendChild(xt);
  }

  // ---- method ----------------------------------------------------------
  var m = r.method || {};
  var method = e('div', 'margin-top:26px;font-size:12px;color:' + C.dim + ';background:' + C.soft +
    ';border-left:3px solid ' + C.blue + ';padding:10px 12px;border-radius:4px');
  method.appendChild(e('div', 'font-weight:700;color:' + C.text, 'Method'));
  method.appendChild(e('div', '', 'Strict equality: ' + (m.strictEquality || '')));
  method.appendChild(e('div', '', 'Structural: ' + (m.structural || '')));
  if (m.bounds) {
    method.appendChild(e('div', 'margin-top:4px', 'Bounds — max entities ' + fmt(m.bounds.maxEntities) +
      ', search budget ' + fmt(m.bounds.maxSearchNodes) + ', refinement iterations ' + m.bounds.iterations +
      (m.bounds.typeNamesOpaque ? ', type names treated as renameable' : '')));
  }
  method.appendChild(e('div', 'margin-top:4px;font-style:italic', 'The structural verdict is a bounded approximation, not a complete isomorphism decision.'));
  wrap.appendChild(method);

  promenade.ready();

  // ---- helpers -------------------------------------------------------------
  function section(title) {
    wrap.appendChild(e('h2', 'font-size:15px;margin:24px 0 8px;padding-top:6px;border-top:1px solid ' + C.line, title));
  }
  function table(headers) {
    var tbl = e('table', 'border-collapse:collapse;width:100%;font-size:12.5px;margin-top:4px');
    var thead = e('tr');
    headers.forEach(function (h) {
      var th = e('th', 'border:1px solid ' + C.line + ';padding:6px 9px;text-align:left;background:' + C.soft + ';color:' + C.dim + ';font-weight:600', h);
      thead.appendChild(th);
    });
    tbl.appendChild(thead);
    return tbl;
  }
  function td(tr, text, extra) {
    tr.appendChild(e('td', 'border:1px solid ' + C.line + ';padding:6px 9px;vertical-align:top;' + (extra || ''), String(text == null ? '' : text)));
  }
  function deltaRow(tbl, kind, d) {
    var tr = e('tr');
    td(tr, kind); td(tr, d.name, 'font-family:ui-monospace,monospace');
    td(tr, fmt(d.baseline)); td(tr, fmt(d.candidate));
    td(tr, signed(d.delta), 'color:' + (d.delta > 0 ? C.ok : C.bad) + ';font-weight:600');
    tbl.appendChild(tr);
  }
  function coverageRow(label, c) {
    var box = e('div', 'margin:10px 0');
    box.appendChild(e('div', 'display:flex;justify-content:space-between;font-size:12.5px',
      null));
    var head = box.firstChild;
    head.appendChild(e('span', 'font-weight:600', label));
    head.appendChild(e('span', 'color:' + C.dim,
      c.shared + ' shared · ' + c.baseline + ' baseline · ' + c.candidate + ' candidate · ' + pct(c.jaccard) + ' Jaccard'));
    box.appendChild(bar(c.baselineInCandidate, 'baseline covered by candidate'));
    box.appendChild(bar(c.candidateInBaseline, 'candidate covered by baseline'));
    return box;
  }
  function bar(frac, label) {
    var row = e('div', 'display:flex;align-items:center;gap:8px;margin-top:4px');
    var track = e('div', 'flex:1;height:12px;border-radius:6px;background:' + C.line + ';overflow:hidden');
    var fill = e('div', 'height:100%;width:' + (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) +
      '%;background:' + (frac >= 0.999 ? C.ok : frac >= 0.5 ? C.blue : C.warn));
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(e('span', 'font-size:11.5px;color:' + C.dim + ';min-width:190px', pct(frac) + ' — ' + label));
    return row;
  }
  function renderSamples(parent, label, rows) {
    if (!rows || !rows.length) return;
    parent.appendChild(e('div', 'margin:4px 0 2px;font-size:11.5px;color:' + C.dim, label));
    var pre = e('pre', 'margin:0;font-size:11px;overflow-x:auto;background:' + C.soft + ';padding:6px 8px;border-radius:4px');
    pre.textContent = rows.map(function (row) { return JSON.stringify(row); }).join('\n');
    parent.appendChild(pre);
  }
  function sampleCount(row) {
    var s = row.samples || {};
    return (s.baselineOnly || []).length + (s.candidateOnly || []).length;
  }
  function kindLabel(k) {
    return { objectType: 'object type', eventType: 'event type', eventAttr: 'event attribute', objectAttr: 'object attribute' }[k] || k;
  }
  function fmt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString();
  }
})();
