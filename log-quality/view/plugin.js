(function () {
  'use strict';
  var root = document.getElementById('root');
  root.style.cssText = 'height:100%;overflow:auto;background:var(--bg,#fff);color:var(--text,#20242d);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  var params = { severity: 'all', category: 'all' };
  var report = null;
  // Repairs on screen this render, addressed by index from the button's
  // data attribute. Rebuilt every render so a stale index can never fire.
  var fixes = [];
  var status = null;
  var CATEGORY = { spec: 'Specification', integrity: 'Integrity', temporal: 'Time', structure: 'Structure', qualifier: 'Qualifiers', attribute: 'Attributes', portability: 'Portability' };
  var SEVERITY = { error: '#d64b43', warning: '#d98916', info: '#2878bb' };
  function payload() { return promenade.artifact().value || promenade.artifact().payload || null; }
  function escape(text) { var e = document.createElement('span'); e.textContent = String(text == null ? '' : text); return e.innerHTML; }
  function badge(kind, value) { return '<span style="display:inline-block;padding:2px 7px;border-radius:99px;background:' + (SEVERITY[kind] || '#687080') + '18;color:' + (SEVERITY[kind] || '#687080') + ';font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.02em">' + escape(value) + '</span>'; }
  function render() {
    report = payload();
    if (!report || !Array.isArray(report.results)) { root.innerHTML = '<div style="padding:24px;color:var(--text-dim,#687080)">This quality report has no readable payload.</div>'; return; }
    var meta = report.meta || {}, counts = report.counts || {}, failed = report.results.filter(function (r) { return r.status === 'failed'; });
    var visible = failed.filter(function (r) { return (params.severity === 'all' || r.severity === params.severity) && (params.category === 'all' || r.category === params.category); });
    var grouped = {};
    visible.forEach(function (r) { (grouped[r.category] || (grouped[r.category] = [])).push(r); });
    fixes = [];
    var html = '<div style="max-width:1120px;margin:0 auto;padding:22px 26px 36px">';
    html += '<div style="display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap"><div><h1 style="margin:0;font-size:22px;letter-spacing:-.02em">Log quality report</h1><p style="margin:3px 0 0;color:var(--text-dim,#687080)">' + escape(meta.logType || 'Event log') + ' · ' + Number(meta.eventCount || 0).toLocaleString() + ' events' + (meta.objectCount != null ? ' · ' + Number(meta.objectCount).toLocaleString() + ' objects' : '') + '</p></div><div style="display:flex;gap:8px">' + ['error', 'warning', 'info'].map(function (s) { return '<div style="min-width:72px;padding:7px 9px;border:1px solid var(--border,#dce1e9);border-radius:7px;text-align:center">' + badge(s, s) + '<div style="font-size:20px;font-weight:700;margin-top:2px">' + Number(counts[s] || 0) + '</div></div>'; }).join('') + '</div></div>';
    html += '<div style="margin:20px 0 14px;padding:11px 13px;border:1px solid var(--border,#dce1e9);border-radius:8px;display:flex;gap:9px;align-items:center;flex-wrap:wrap;background:var(--panel,#fbfcfe)"><strong>Filters</strong><select id="severity"><option value="all">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option></select><select id="category"><option value="all">All categories</option>' + Object.keys(CATEGORY).map(function (key) { return '<option value="' + key + '">' + CATEGORY[key] + '</option>'; }).join('') + '</select><span style="margin-left:auto;color:var(--text-dim,#687080)">' + visible.length + ' of ' + failed.length + ' findings</span></div>';
    Object.keys(CATEGORY).forEach(function (category) {
      var rows = grouped[category]; if (!rows || !rows.length) return;
      html += '<section style="margin:18px 0"><h2 style="font-size:15px;margin:0 0 8px">' + CATEGORY[category] + ' <span style="color:var(--text-dim,#687080);font-weight:400">' + rows.length + '</span></h2>';
      rows.forEach(function (r) {
        var finding = r.findings[0] || {};
        html += '<article style="border:1px solid var(--border,#dce1e9);border-left:4px solid ' + (SEVERITY[r.severity] || '#687080') + ';border-radius:7px;margin:7px 0;padding:11px 13px;background:var(--panel,#fff)"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>' + escape(finding.title || r.name) + '</strong>' + badge(r.severity, r.severity) + '<code style="margin-left:auto;color:var(--text-dim,#687080);font-size:10px">' + escape(r.checkId) + '</code></div><p style="margin:6px 0 0">' + escape(finding.description || '') + '</p><p style="margin:5px 0 0;color:var(--text-dim,#687080)"><strong>Impact:</strong> ' + escape(finding.impact || '') + '</p>' + (finding.examples && finding.examples.length ? '<div style="margin-top:7px;color:var(--text-dim,#687080);font-size:12px"><strong>Examples:</strong> ' + finding.examples.map(escape).join(', ') + '</div>' : '');
        html += repairFooter(finding.fix);
        html += '</article>';
      });
      html += '</section>';
    });
    var passed = report.results.filter(function (r) { return r.status === 'passed'; }); var skipped = report.results.filter(function (r) { return r.status === 'skipped'; });
    html += '<details style="margin-top:22px"><summary style="cursor:pointer;font-weight:650">Passed checks (' + passed.length + ')</summary><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">' + passed.map(function (r) { return '<span title="' + escape(r.checkId) + '" style="padding:3px 7px;border-radius:5px;background:#188b5b14;color:#18734e;font-size:11px">✓ ' + escape(r.name) + '</span>'; }).join('') + '</div></details>';
    if (skipped.length) html += '<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--text-dim,#687080)">Skipped checks (' + skipped.length + ')</summary>' + skipped.map(function (r) { return '<div style="margin:8px 0;padding:8px 11px;border:1px solid var(--border,#dce1e9);border-left:3px solid var(--text-dim,#687080);border-radius:6px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>' + escape(r.name) + '</strong><code style="margin-left:auto;color:var(--text-dim,#687080);font-size:10px">' + escape(r.checkId) + '</code></div>' + (r.note ? '<p style="margin:5px 0 0;color:var(--text-dim,#687080)">' + escape(r.note) + '</p>' : '') + '</div>'; }).join('') + '</details>';
    root.innerHTML = html + '</div>';
    var severity = document.getElementById('severity'), category = document.getElementById('category'); severity.value = params.severity; category.value = params.category;
    severity.onchange = function () { params.severity = severity.value; render(); }; category.onchange = function () { params.category = category.value; render(); };
    Array.prototype.forEach.call(root.querySelectorAll('[data-fix]'), function (button) {
      button.onclick = function () { applyFix(Number(button.getAttribute('data-fix'))); };
    });
    if (status) {
      var tone = status.tone === 'err' ? '#d64b43' : status.tone === 'ok' ? '#18734e' : '#687080';
      var bar = document.createElement('div');
      bar.setAttribute('style', 'position:sticky;bottom:0;margin-top:12px;padding:9px 13px;border-top:1px solid var(--border,#dce1e9);background:var(--panel,#fbfcfe);color:' + tone);
      bar.textContent = status.text;
      root.firstChild.appendChild(bar);
    }
  }
  /**
   * The repair a finding proposes, if any.
   *
   * One button per finding and never a bulk action: each repair is a decision
   * about the log, and several of them are decisions the report cannot make
   * (which of two readings of a duplicate identifier is right, whether
   * \u201cunknown\u201d is a real answer). Anything the plugin is not sure about
   * carries its reservation next to the button rather than in a tooltip.
   */
  function repairFooter(fix) {
    if (!fix || !fix.ops || !fix.ops.length) return '';
    var index = fixes.push(fix) - 1;
    return '<div style="margin-top:9px;padding-top:9px;border-top:1px dashed var(--border,#dce1e9);display:flex;gap:9px;align-items:flex-start;flex-wrap:wrap">' +
      '<button data-fix="' + index + '" style="flex:none">' + escape(fix.label || 'Apply fix') + '</button>' +
      (fix.caution ? '<span style="flex:1 1 240px;color:var(--text-dim,#687080);font-size:12px">' + escape(fix.caution) + '</span>' : '') +
      '</div>';
  }

  function applyFix(index) {
    var fix = fixes[index];
    if (!fix) return;
    status = { text: 'Applying \u201c' + (fix.label || 'fix') + '\u201d\u2026', tone: 'busy' };
    render();
    promenade.deriveLog(fix.ops).then(function (result) {
      status = {
        text: 'Added to ' + result.name + ' \u2014 ' + result.applied +
          ' operation' + (result.applied === 1 ? '' : 's') + ' now in its plan. The source log is unchanged.',
        tone: 'ok',
      };
      render();
    }, function (err) {
      status = { text: String((err && err.message) || err), tone: 'err' };
      render();
    });
  }

  promenade.on('params', function (next) { params = { severity: next.severity || 'all', category: next.category || 'all' }; render(); });
  promenade.ready(); render();
})();
