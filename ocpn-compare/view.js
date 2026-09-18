/* OCPN Comparison report — deliberately dependency-free sandboxed view. */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var report = promenade.artifact().value || {};
  var C = { text: '#20242d', dim: '#687386', line: '#dce2ea', blue: '#165dff', green: '#087f5b', red: '#c4374f', paper: '#fff', soft: '#f6f8fb' };

  root.style.cssText = 'overflow:auto;background:' + C.paper + ';color:' + C.text + ';font:14px/1.45 Inter,system-ui,sans-serif;';
  function e(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function pct(value) { return (Number(value || 0) * 100).toFixed(1) + '%'; }
  function card(label, value, detail, tone) {
    var n = e('div', 'card'); n.style.borderTop = '3px solid ' + (tone || C.blue);
    n.appendChild(e('div', 'label', label)); n.appendChild(e('div', 'value', value)); n.appendChild(e('div', 'detail', detail)); return n;
  }
  function section(title) { var n = e('section'); n.appendChild(e('h2', '', title)); return n; }
  function setLine(name, comparison) {
    return name + ': ' + comparison.sharedCount + ' shared / ' + comparison.baselineCount + ' baseline / ' + comparison.candidateCount + ' candidate (' + pct(comparison.jaccard) + ' Jaccard)';
  }
  function list(title, rows, render) {
    if (!rows || !rows.length) return null;
    var details = e('details'); details.appendChild(e('summary', '', title + ' (' + rows.length + ')'));
    var ul = e('ul'); rows.forEach(function (row) { ul.appendChild(e('li', '', render ? render(row) : String(row))); }); details.appendChild(ul); return details;
  }

  var style = document.createElement('style');
  style.textContent = '.wrap{padding:22px;max-width:1280px;margin:auto}.intro{color:#687386;max-width:920px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{background:#f6f8fb;border:1px solid #dce2ea;border-radius:9px;padding:12px}.label{color:#687386;font-size:12px}.value{font-size:25px;font-weight:700;margin-top:3px}.detail{color:#687386;font-size:12px;margin-top:3px}h1{margin:0 0 5px;font-size:24px}h2{font-size:17px;margin:26px 0 9px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dce2ea;padding:8px;text-align:left;vertical-align:top}th{background:#f6f8fb;color:#687386;font-weight:600}.ok{color:#087f5b;font-weight:700}.diff{color:#c4374f;font-weight:700}details{border:1px solid #dce2ea;border-radius:7px;padding:8px 10px;margin-top:8px;background:#fff}summary{cursor:pointer;font-weight:600}ul{margin:8px 0 0;padding-left:20px}.note{font-size:12px;color:#687386;background:#f6f8fb;border-left:3px solid #165dff;padding:10px 12px;border-radius:4px}';
  document.head.appendChild(style);
  var wrap = e('main', 'wrap'); root.appendChild(wrap);
  var summary = report.summary || {}, stats = report.stats || {};
  wrap.appendChild(e('h1', '', 'Object-Centric Petri Net comparison'));
  wrap.appendChild(e('p', 'intro', (report.method || {}).explanation || 'Comparison report.'));

  var grid = e('div', 'grid');
  grid.appendChild(card('Object types', String(stats.objectTypes || 0), setLine('types', summary.objectTypes || {}), C.blue));
  grid.appendChild(card('Visible activities', String(stats.baselineVisibleActivities || 0) + ' / ' + String(stats.candidateVisibleActivities || 0), pct((summary.visibleActivities || {}).jaccard) + ' overlap', C.green));
  grid.appendChild(card('Types with differences', String(stats.typesWithDifferences || 0), 'of ' + String(stats.objectTypes || 0) + ' object types', stats.typesWithDifferences ? C.red : C.green));
  grid.appendChild(card('Variable activity/type pairs', String((summary.variableActivityTypes || {}).sharedCount || 0), pct((summary.variableActivityTypes || {}).jaccard) + ' overlap', C.blue));
  wrap.appendChild(grid);

  var method = section('Method and bounds');
  var bound = (report.method || {}).variantBound || {};
  method.appendChild(e('div', 'note', 'τ-abstracted: silent transitions are traversed but are not comparison labels. Bounded coverage enumerates at most ' + (bound.maxVariantsPerObjectType || '?') + ' visible variants of length ' + (bound.maxLength || '?') + ' per object type. It estimates behavioural overlap; it is not an exact marking- or identifier-aware alignment.'));
  wrap.appendChild(method);

  var typeSection = section('Per-object-type comparison');
  var table = e('table'), head = e('thead'), row = e('tr');
  ['Object type', 'Activities', 'τ-abstracted direct follows', 'Reachability profile', 'Bounded reciprocal coverage', 'Structure Δ'].forEach(function (title) { row.appendChild(e('th', '', title)); });
  head.appendChild(row); table.appendChild(head);
  var body = e('tbody');
  (report.perObjectType || []).forEach(function (item) {
    var tr = e('tr');
    var status = item.equivalent ? 'equivalent' : 'differences';
    var tdType = e('td'); tdType.appendChild(e('strong', item.equivalent ? 'ok' : 'diff', item.objectType)); tdType.appendChild(e('div', item.equivalent ? 'ok' : 'diff', status)); tr.appendChild(tdType);
    var activity = item.activities || {}; tr.appendChild(e('td', '', setLine('', activity).replace(/^: /, '')));
    var direct = item.directFollows || {}; tr.appendChild(e('td', '', setLine('', direct).replace(/^: /, '')));
    var profile = item.reachabilityProfile || {}; tr.appendChild(e('td', '', pct(profile.agreement) + ' agreement (' + (profile.agreedPairs || 0) + '/' + (profile.pairs || 0) + ' pairs)'));
    var coverage = item.boundedCoverage || {}; tr.appendChild(e('td', '', 'baseline → candidate: ' + pct(coverage.baselineCoverageInCandidate) + '\ncandidate → baseline: ' + pct(coverage.candidateCoverageInBaseline)));
    var delta = (item.structure || {}).delta || {}; tr.appendChild(e('td', '', 'places ' + signed(delta.places) + ' · visible ' + signed(delta.visibleTransitions) + ' · τ ' + signed(delta.silentTransitions) + ' · arcs ' + signed(delta.arcs)));
    body.appendChild(tr);
  });
  table.appendChild(body); typeSection.appendChild(table); wrap.appendChild(typeSection);

  var details = section('Differences');
  (report.perObjectType || []).forEach(function (item) {
    if (item.equivalent) return;
    var block = e('div'); block.style.marginTop = '14px'; block.appendChild(e('strong', '', item.objectType));
    var a = item.activities || {}, d = item.directFollows || {}, p = item.reachabilityProfile || {}, v = item.boundedCoverage || {};
    [
      list('Activities only in baseline', a.onlyBaseline), list('Activities only in candidate', a.onlyCandidate),
      list('Direct follows only in baseline', d.onlyBaseline, function (x) { return x.from + ' → ' + x.to; }),
      list('Direct follows only in candidate', d.onlyCandidate, function (x) { return x.from + ' → ' + x.to; }),
      list('Reachability relation changes', p.differences, function (x) { return x.from + ' / ' + x.to + ': ' + x.baseline + ' → ' + x.candidate; }),
      list('Bounded variants only in baseline', v.onlyBaseline, function (x) { return x.activities.join(' → '); }),
      list('Bounded variants only in candidate', v.onlyCandidate, function (x) { return x.activities.join(' → '); })
    ].forEach(function (node) { if (node) block.appendChild(node); });
    details.appendChild(block);
  });
  var overall = summary.variableActivityTypes || {};
  var variable = list('Variable activity/type pairs only in baseline', overall.onlyBaseline, function (x) { return x.replace('\u241f', ' · '); });
  if (variable) details.appendChild(variable);
  variable = list('Variable activity/type pairs only in candidate', overall.onlyCandidate, function (x) { return x.replace('\u241f', ' · '); });
  if (variable) details.appendChild(variable);
  wrap.appendChild(details);

  function signed(value) { return (value > 0 ? '+' : '') + String(value || 0); }
  promenade.ready();
})();
