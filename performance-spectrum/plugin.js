/*
 * Performance Spectrum — a canvas rendering of every observed directly-follows
 * flow.  This intentionally avoids averages: an inclined line is one entity's
 * source-to-target movement in calendar time, coloured by duration quartile.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  var canvas = document.createElement('canvas');
  var info = document.createElement('div');
  var legend = document.createElement('div');
  var tooltip = document.createElement('div');
  var bandButton = document.createElement('button');
  var interactionSelection = document.createElement('select');
  var bandMenu = document.createElement('div');
  var contextMenu = document.createElement('div');
  var HEADER_H = 84;
  root.style.position = 'relative';
  root.style.overflow = 'hidden';
  canvas.style.cssText = 'position:absolute;left:0;right:0;top:' + HEADER_H + 'px;bottom:0;cursor:crosshair;';
  info.style.cssText = 'position:absolute;left:10px;right:10px;top:1px;height:23px;line-height:23px;font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text,#20242d);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  legend.style.cssText = 'position:absolute;left:10px;right:10px;top:25px;height:22px;display:flex;align-items:center;gap:10px;font:10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text-dim,#687080);white-space:nowrap;overflow:hidden;';
  tooltip.style.cssText = 'display:none;position:absolute;z-index:3;max-width:270px;padding:6px 8px;border-radius:4px;background:rgba(25,29,36,.92);box-shadow:0 2px 10px rgba(0,0,0,.25);color:#fff;font:11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-line;pointer-events:none;';
  bandButton.style.cssText = 'position:absolute;z-index:4;left:10px;right:250px;top:51px;height:25px;max-width:calc(100% - 270px);padding:2px 8px;border:1px solid var(--border,#d6dbe4);border-radius:4px;background:var(--bg,#fff);color:var(--text,#252a33);font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  interactionSelection.style.cssText = 'display:none;position:absolute;z-index:4;right:10px;top:51px;width:232px;height:25px;padding:2px 6px;border:1px solid var(--border,#d6dbe4);border-radius:4px;background:var(--bg,#fff);color:var(--text,#252a33);font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  bandMenu.style.cssText = 'display:none;position:absolute;z-index:5;left:10px;top:79px;width:min(350px,calc(100% - 20px));max-height:min(330px,calc(100% - 88px));overflow:auto;padding:5px;border:1px solid var(--border,#d6dbe4);border-radius:5px;background:var(--bg,#fff);box-shadow:0 5px 16px rgba(0,0,0,.18);font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  contextMenu.style.cssText = 'display:none;position:fixed;z-index:6;min-width:180px;padding:4px;border:1px solid var(--border,#d6dbe4);border-radius:5px;background:var(--bg,#fff);box-shadow:0 5px 16px rgba(0,0,0,.18);font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  root.appendChild(canvas); root.appendChild(info); root.appendChild(legend); root.appendChild(bandButton); root.appendChild(interactionSelection); root.appendChild(bandMenu); root.appendChild(tooltip); root.appendChild(contextMenu);
  var ctx = canvas.getContext('2d');

  var artifact = promenade.artifact();
  var isOC = artifact.type === 'ObjectCentricEventLog';
  var params = { activities: [], objectTypes: [], timeStart: '', timeEnd: '', maxSegments: 60000, maxBands: 18, showGrid: true, showLabels: true, showHover: true };
  var size = { w: 0, h: 0 };
  var data = null;
  var geometry = null;
  var selectedBands = new Set(); // empty means "no explicit selection" (every band highlighted)
  var selectedSpeeds = new Set(); // empty means "no explicit selection" (every duration class shown); holds klass numbers 1-4
  var bandSelection = null; // null represents all offered activity pairs; set by the Segments menu or "Isolate"
  var dragSelection = null; // { start, end } in epoch ms: a click-and-drag time window, pending "Set time range"
  var dragState = null; // { downPx, moved }: tracks a mousedown until it either becomes a drag or a plain click
  var suppressClick = false; // a drag just ended on mouseup; the click event it also fires must not toggle a band
  var queryRevision = 0;
  var reloadTimer = 0;
  var SPEED = ['#1769aa', '#42a5d8', '#f3ad37', '#d65245'];
  var SPEED_LABELS = ['Fastest 25%', 'Fast', 'Slow', 'Slowest 25%'];
  var sharedInteractionSelection = null; // Exact source-bound lasso cohort, never screen coordinates.

  function table(name) { return artifact.tables[name]; }
  function sqlString(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
  function sqlList(values) { return values.map(sqlString).join(', '); }
  function selectedValues(value) { return Array.isArray(value) ? value.map(String).filter(Boolean) : []; }
  function timeBound(value, endOfDay) {
    if (!value) return null;
    var text = String(value).trim();
    if (!text) return null;
    if (endOfDay && /^\d{4}-\d\d-\d\d$/.test(text)) text += 'T23:59:59.999Z';
    var time = Date.parse(text);
    return Number.isFinite(time) ? time : null;
  }
  function n(value) { return typeof value === 'bigint' ? Number(value) : Number(value); }
  function trunc(text, length) { return text.length > length ? text.slice(0, length - 1) + '…' : text; }
  function pair(source, target) { return source + '\u0000' + target; }
  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    if (ms < 3600000) return (ms / 60000).toFixed(1) + ' min';
    if (ms < 86400000) return (ms / 3600000).toFixed(1) + ' h';
    return (ms / 86400000).toFixed(1) + ' d';
  }
  function tick(ms, span) {
    var date = new Date(ms);
    if (span > 1000 * 60 * 60 * 24 * 365) return date.getUTCFullYear();
    if (span > 1000 * 60 * 60 * 24 * 21) return date.toISOString().slice(0, 10);
    if (span > 1000 * 60 * 60 * 24) return date.toISOString().slice(5, 10);
    return date.toISOString().slice(11, 16);
  }

  /** Build only the two shapes supported by Promenade's relational contract.
   * Object-centric events are partitioned by object, which is the OCEL
   * analogue of a case lifecycle. */
  function buildSql() {
    var limit = Math.max(5000, Math.min(200000, Number(params.maxSegments) || 60000));
    var activities = selectedValues(params.activities);
    var activityFilter = activities.length
      ? ' AND source_activity IN (' + sqlList(activities) + ') AND target_activity IN (' + sqlList(activities) + ')'
      : '';
    var start = timeBound(params.timeStart, false), end = timeBound(params.timeEnd, true);
    var timeFilter = (start == null ? '' : ' AND epoch_ms(e.ts) >= ' + start)
      + (end == null ? '' : ' AND epoch_ms(e.ts) <= ' + end);
    var sharedEventFilter = sharedInteractionSelection
      ? ' AND source_event_id IN (' + sqlList(sharedInteractionSelection.eventIds) + ')'
      : '';
    var source;
    if (isOC) {
      var objectTypes = selectedValues(params.objectTypes);
      var typeFilter = objectTypes.length ? ' AND o.object_type IN (' + sqlList(objectTypes) + ')' : '';
      source =
        'SELECT r.object_id AS entity_id, e.activity AS source_activity, epoch_ms(e.ts) AS start_ms, e.event_id AS event_order, e.event_id AS source_event_id ' +
        'FROM ' + table('event') + ' e JOIN ' + table('e2o') + ' r ON r.event_id = e.event_id ' +
        'JOIN ' + table('object') + ' o ON o.object_id = r.object_id ' +
        'WHERE e.ts IS NOT NULL' + typeFilter + timeFilter;
    } else {
      source =
        'SELECT CAST(e.trace_idx AS VARCHAR) AS entity_id, e.activity AS source_activity, epoch_ms(e.ts) AS start_ms, CAST(e.event_idx AS VARCHAR) AS event_order, CAST(e.event_idx AS VARCHAR) AS source_event_id ' +
        'FROM ' + table('event') + ' e WHERE e.ts IS NOT NULL' + timeFilter;
    }
    return 'WITH events AS (' + source + '), ordered AS (' +
      'SELECT entity_id, source_activity, start_ms, ' +
      'LEAD(source_activity) OVER (PARTITION BY entity_id ORDER BY start_ms, event_order) AS target_activity, ' +
      'LEAD(start_ms) OVER (PARTITION BY entity_id ORDER BY start_ms, event_order) AS end_ms ' +
      'FROM events' +
      '), segments AS (' +
      'SELECT entity_id, source_activity, target_activity, start_ms, end_ms, end_ms - start_ms AS duration_ms ' +
      'FROM ordered WHERE target_activity IS NOT NULL AND end_ms >= start_ms' + activityFilter + sharedEventFilter +
      '), sample AS (SELECT * FROM segments USING SAMPLE ' + limit + ' ROWS), classified AS (' +
      'SELECT *, NTILE(4) OVER (ORDER BY duration_ms) AS performance_class FROM sample' +
      ') SELECT entity_id, source_activity, target_activity, start_ms, end_ms, duration_ms, performance_class FROM classified';
  }

  function load() {
    var revision = ++queryRevision;
    info.textContent = 'Querying individual flows…';
    promenade.sql(buildSql()).then(function (result) {
      if (revision !== queryRevision) return;
      var cols = result.columns;
      var counts = Object.create(null), names = Object.create(null), rows = [];
      for (var i = 0; i < result.numRows; i++) {
        var source = String(cols.source_activity[i] == null ? '(none)' : cols.source_activity[i]);
        var target = String(cols.target_activity[i] == null ? '(none)' : cols.target_activity[i]);
        var key = pair(source, target);
        counts[key] = (counts[key] || 0) + 1;
        names[key] = { source: source, target: target };
        rows.push({
          entity: String(cols.entity_id[i] == null ? '(none)' : cols.entity_id[i]), source: source, target: target,
          key: key, start: n(cols.start_ms[i]), end: n(cols.end_ms[i]), duration: n(cols.duration_ms[i]),
          klass: Math.max(1, Math.min(4, n(cols.performance_class[i]) || 1)),
        });
      }
      var bands = Object.keys(counts).map(function (key) { return { key: key, count: counts[key], source: names[key].source, target: names[key].target }; });
      bands.sort(function (a, b) { return b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target); });
      var maxBands = Math.max(3, Math.min(80, Number(params.maxBands) || 18));
      bands = bands.slice(0, maxBands);
      data = { allRows: rows, total: rows.length, allBands: bands, rows: [], bands: [], bandIndex: Object.create(null) };
      // A new data perspective can make a previously selected pair disappear.
      if (bandSelection) {
        bandSelection = new Set(Array.from(bandSelection).filter(function (key) {
          return bands.some(function (band) { return band.key === key; });
        }));
        if (bandSelection.size === bands.length) bandSelection = null;
      }
      refreshVisibleBands();
      selectedBands = new Set();
      draw();
    }).catch(function (error) {
      if (revision !== queryRevision) return;
      data = null;
      info.textContent = 'Could not compute spectrum: ' + (error && error.message ? error.message : error);
      draw();
    });
  }
  function scheduleLoad() {
    ++queryRevision;
    clearTimeout(reloadTimer);
    info.textContent = 'Querying individual flows…';
    reloadTimer = setTimeout(load, 120);
  }

  /** Re-index after a menu selection. The selected subset, rather than all
   * candidate pairs, is deliberately stretched over the full canvas height. */
  function refreshVisibleBands() {
    if (!data) return;
    data.bands = bandSelection === null ? data.allBands.slice() : data.allBands.filter(function (band) { return bandSelection.has(band.key); });
    data.bandIndex = Object.create(null);
    data.bands.forEach(function (band, index) { data.bandIndex[band.key] = index; });
    data.rows = data.allRows.filter(function (row) { return data.bandIndex[row.key] !== undefined; });
    if (selectedBands.size) {
      var stillVisible = new Set();
      selectedBands.forEach(function (key) { if (data.bandIndex[key] !== undefined) stillVisible.add(key); });
      selectedBands = stillVisible;
    }
    updateBandButton();
  }

  function updateBandButton() {
    if (!data) { bandButton.textContent = 'Segments…'; return; }
    bandButton.textContent = 'Segments: ' + (bandSelection === null ? 'all ' + data.allBands.length : data.bands.length + ' of ' + data.allBands.length) + '  ▾';
    bandButton.title = 'Choose the activity-pair spectra to distribute vertically';
  }

  /**
   * The host advertises only exact, source-bound Atlas lassos to manifests
   * opting into interaction-cohort-v1. This view maps their event membership
   * to outgoing directly-follows segments: the source event is selected while
   * its next event remains the next event in the complete object lifecycle.
   */
  function configureInteractionSelections() {
    var offered = isOC && Array.isArray(artifact.interactionSelections) ? artifact.interactionSelections : [];
    interactionSelection.textContent = '';
    interactionSelection.appendChild(new Option('All source events', ''));
    offered.forEach(function (candidate) {
      interactionSelection.appendChild(new Option('Lasso cohort · ' + String(candidate.name || candidate.id), String(candidate.id)));
    });
    interactionSelection.style.display = offered.length ? 'block' : 'none';
    bandButton.style.right = offered.length ? '250px' : '10px';
    bandButton.style.maxWidth = offered.length ? 'calc(100% - 270px)' : 'calc(100% - 20px)';
  }
  interactionSelection.addEventListener('change', function () {
    var id = interactionSelection.value;
    if (!id) { sharedInteractionSelection = null; scheduleLoad(); return; }
    interactionSelection.disabled = true;
    info.textContent = 'Loading exact source-bound lasso selection…';
    promenade.interactionSelection(id).then(function (result) {
      var value = result && result.value, members = value && value.members, mask = value && value.selection && value.selection.binMask;
      if (!members || !Array.isArray(members.eventIds) || !mask || !Number.isInteger(mask.binCount) || !Array.isArray(mask.bins)) {
        throw new Error('The advertised selection is not an exact lifecycle-bin cohort.');
      }
      sharedInteractionSelection = { id: id, name: String(result.name || id), eventIds: members.eventIds.map(String) };
      scheduleLoad();
    }).catch(function (error) {
      interactionSelection.value = '';
      sharedInteractionSelection = null;
      info.textContent = 'Could not load interaction selection: ' + (error && error.message ? error.message : error);
    }).then(function () { interactionSelection.disabled = false; });
  });

  function hideBandMenu() { bandMenu.style.display = 'none'; }
  function showBandMenu() {
    if (!data) return;
    bandMenu.textContent = '';
    var all = document.createElement('label');
    all.style.cssText = 'display:block;padding:5px 6px 7px;border-bottom:1px solid var(--border,#e0e4eb);font-weight:600;cursor:pointer;';
    var allBox = document.createElement('input'); allBox.type = 'checkbox'; allBox.checked = bandSelection === null;
    allBox.style.marginRight = '6px'; all.appendChild(allBox); all.appendChild(document.createTextNode('All visible segments (' + data.allBands.length + ')'));
    allBox.addEventListener('change', function () { bandSelection = allBox.checked ? null : new Set(); refreshVisibleBands(); renderBandMenu(); draw(); });
    bandMenu.appendChild(all);
    data.allBands.forEach(function (band) {
      var line = document.createElement('label');
      line.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;';
      var box = document.createElement('input'); box.type = 'checkbox'; box.checked = bandSelection === null || bandSelection.has(band.key);
      var name = document.createElement('span'); name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'; name.textContent = band.source + ' → ' + band.target;
      var count = document.createElement('span'); count.style.cssText = 'color:var(--text-dim,#687080);font-variant-numeric:tabular-nums;'; count.textContent = String(band.count);
      box.addEventListener('change', function () {
        if (bandSelection === null) bandSelection = new Set(data.allBands.map(function (candidate) { return candidate.key; }));
        if (box.checked) bandSelection.add(band.key); else bandSelection.delete(band.key);
        if (bandSelection.size === data.allBands.length) bandSelection = null;
        refreshVisibleBands(); renderBandMenu(); draw();
      });
      line.appendChild(box); line.appendChild(name); line.appendChild(count); bandMenu.appendChild(line);
    });
  }
  function renderBandMenu() { if (bandMenu.style.display !== 'none') showBandMenu(); }

  /** Toggle `klass` (1-4) into/out of `selectedSpeeds`, same single/multi-select
   * convention as the band `click` handler below: a plain click isolates this
   * one class (or clears back to "all" if it was already the only one), a
   * Cmd/Ctrl-click adds or removes it from a multi-class selection. */
  function toggleSpeed(klass, event) {
    if (event.metaKey || event.ctrlKey) {
      selectedSpeeds = new Set(selectedSpeeds);
      if (selectedSpeeds.has(klass)) selectedSpeeds.delete(klass); else selectedSpeeds.add(klass);
    } else {
      selectedSpeeds = (selectedSpeeds.size === 1 && selectedSpeeds.has(klass)) ? new Set() : new Set([klass]);
    }
    draw();
  }

  function drawLegend() {
    legend.innerHTML = '';
    SPEED.forEach(function (color, index) {
      var klass = index + 1, on = selectedSpeeds.size === 0 || selectedSpeeds.has(klass);
      var item = document.createElement('span');
      item.title = 'Click to isolate this duration class, Cmd/Ctrl-click to add or remove it';
      item.style.cssText = 'display:inline-flex;align-items:center;cursor:pointer;opacity:' + (on ? '1' : '.4') + ';';
      var dot = document.createElement('i');
      dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:' + color + ';';
      item.appendChild(dot); item.appendChild(document.createTextNode(SPEED_LABELS[index]));
      item.addEventListener('click', function (event) { event.stopPropagation(); toggleSpeed(klass, event); });
      legend.appendChild(item);
    });
    var note = document.createElement('span');
    note.style.cssText = 'opacity:.72;cursor:default;';
    note.textContent = selectedSpeeds.size ? 'Click a class to change the filter, or Cmd/Ctrl-click to combine' : 'Each line is one observed flow';
    legend.appendChild(note);
  }

  bandButton.addEventListener('click', function (event) {
    event.stopPropagation();
    if (bandMenu.style.display === 'none') { bandMenu.style.display = 'block'; showBandMenu(); }
    else hideBandMenu();
  });
  bandMenu.addEventListener('click', function (event) { event.stopPropagation(); });
  document.addEventListener('click', hideBandMenu);

  function draw() {
    if (!size.w || !size.h) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(size.w * dpr)); canvas.height = Math.max(1, Math.floor((size.h - HEADER_H) * dpr));
    canvas.style.width = size.w + 'px'; canvas.style.height = Math.max(1, size.h - HEADER_H) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var width = size.w, height = Math.max(1, size.h - HEADER_H);
    var theme = promenade.theme ? promenade.theme() : {};
    ctx.clearRect(0, 0, width, height);
    drawLegend();
    if (!data) return;
    if (!data.total) { info.textContent = 'No timestamped directly-follows segments in this perspective.'; return; }
    if (!data.bands.length) { info.textContent = 'Select one or more segments from the Segments menu.'; return; }

    var values = data.rows, min = Infinity, max = -Infinity;
    values.forEach(function (row) { min = Math.min(min, row.start); max = Math.max(max, row.end); });
    if (!Number.isFinite(min)) { info.textContent = 'No visible segments.'; return; }
    var span = Math.max(1, max - min), labelW = params.showLabels ? Math.min(205, Math.max(110, width * .19)) : 12;
    var pad = { left: labelW + 9, right: 16, top: 25, bottom: 20 };
    var chartW = Math.max(1, width - pad.left - pad.right), chartH = Math.max(1, height - pad.top - pad.bottom);
    var bandH = chartH / Math.max(1, data.bands.length);
    var x = function (time) { return pad.left + ((time - min) / span) * chartW; };
    var y = function (band, fraction) { return pad.top + band * bandH + fraction * bandH; };
    var background = theme.bg || '#ffffff', border = theme.border || '#d7dce5', text = theme.text || '#252a33', dim = theme['text-dim'] || '#6e7685';
    ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);

    if (params.showGrid) {
      var ticks = Math.max(3, Math.min(8, Math.floor(chartW / 115)));
      ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.globalAlpha = .75;
      for (var tickIndex = 0; tickIndex <= ticks; tickIndex++) {
        var px = pad.left + chartW * tickIndex / ticks;
        ctx.beginPath(); ctx.moveTo(px + .5, pad.top - 7); ctx.lineTo(px + .5, height - pad.bottom); ctx.stroke();
        ctx.fillStyle = dim; ctx.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        ctx.fillText(tick(min + span * tickIndex / ticks, span), Math.min(width - 58, px + 3), 11);
      }
      ctx.globalAlpha = 1;
    }

    data.bands.forEach(function (band, index) {
      var top = y(index, 0), bottom = y(index, 1), selected = selectedBands.has(band.key);
      if (selected) {
        ctx.save(); ctx.globalAlpha = .1; ctx.fillStyle = theme.accent || '#2563eb';
        ctx.fillRect(pad.left, top, width - pad.left - pad.right, bottom - top); ctx.restore();
      }
      ctx.strokeStyle = border; ctx.globalAlpha = .8; ctx.beginPath(); ctx.moveTo(pad.left, top + .5); ctx.lineTo(width - pad.right, top + .5); ctx.stroke(); ctx.globalAlpha = 1;
      if (params.showLabels) {
        var label = trunc(band.source + ' → ' + band.target, 29);
        ctx.fillStyle = selected ? (theme.accent || '#2563eb') : text;
        ctx.font = (selected ? '600 ' : '') + '10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        ctx.textAlign = 'right'; ctx.fillText(label, pad.left - 7, top + bandH / 2 + 3);
        ctx.fillStyle = dim; ctx.font = '9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        ctx.fillText(String(band.count), pad.left - 7, Math.min(bottom - 2, top + bandH / 2 + 14));
      }
    });
    ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(pad.left, height - pad.bottom + .5); ctx.lineTo(width - pad.right, height - pad.bottom + .5); ctx.stroke();

    var lineWidth = data.rows.length > 35000 ? 1 : 1.25;
    values.forEach(function (row) {
      var band = data.bandIndex[row.key];
      var bandOn = selectedBands.size === 0 || selectedBands.has(row.key);
      var speedOn = selectedSpeeds.size === 0 || selectedSpeeds.has(row.klass);
      var highlight = bandOn && speedOn;
      ctx.strokeStyle = SPEED[row.klass - 1]; ctx.lineWidth = lineWidth; ctx.globalAlpha = highlight ? .68 : .055;
      ctx.beginPath(); ctx.moveTo(x(row.start), y(band, .13)); ctx.lineTo(x(row.end), y(band, .87)); ctx.stroke();
    });
    if (dragSelection) {
      var selStart = Math.max(min, Math.min(dragSelection.start, dragSelection.end));
      var selEnd = Math.min(max, Math.max(dragSelection.start, dragSelection.end));
      if (selEnd > selStart) {
        var sx = x(selStart), ex = x(selEnd);
        ctx.save();
        ctx.fillStyle = theme.accent || '#2563eb'; ctx.globalAlpha = .12;
        ctx.fillRect(sx, pad.top, ex - sx, chartH);
        ctx.globalAlpha = 1; ctx.strokeStyle = theme.accent || '#2563eb'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(sx + .5, pad.top); ctx.lineTo(sx + .5, height - pad.bottom); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ex + .5, pad.top); ctx.lineTo(ex + .5, height - pad.bottom); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
    info.textContent = data.total.toLocaleString() + ' sampled flows · ' + data.bands.length + ' visible segments' + (sharedInteractionSelection ? ' · exact lasso cohort: ' + sharedInteractionSelection.name : '') + ' · ' + new Date(min).toISOString().slice(0, 10) + ' → ' + new Date(max).toISOString().slice(0, 10);
    geometry = { x: x, y: y, min: min, max: max, span: span, pad: pad, bandH: bandH, chartH: chartH, chartW: chartW };
  }

  /** Inverse of `geometry.x`: a canvas-local pixel back to epoch ms, clamped to the plotted span. */
  function timeAtPx(px) {
    if (!geometry) return null;
    var t = geometry.min + ((px - geometry.pad.left) / geometry.chartW) * geometry.span;
    return Math.max(geometry.min, Math.min(geometry.max, t));
  }

  function nearest(event) {
    if (!data || !geometry || !params.showHover) return null;
    var rect = canvas.getBoundingClientRect(), mx = event.clientX - rect.left, my = event.clientY - rect.top;
    var best = null, distance = 90;
    data.rows.forEach(function (row) {
      var band = data.bandIndex[row.key];
      var x1 = geometry.x(row.start), y1 = geometry.y(band, .13), x2 = geometry.x(row.end), y2 = geometry.y(band, .87);
      var dx = x2 - x1, dy = y2 - y1, length = dx * dx + dy * dy || 1;
      var t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / length));
      var px = x1 + t * dx, py = y1 + t * dy, d = (mx - px) * (mx - px) + (my - py) * (my - py);
      if (d < distance) { distance = d; best = row; }
    });
    return best;
  }

  canvas.addEventListener('mousemove', function (event) {
    if (dragState) { tooltip.style.display = 'none'; return; }
    var row = nearest(event);
    if (!row) { tooltip.style.display = 'none'; return; }
    var rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    tooltip.textContent = row.source + ' → ' + row.target + '\n' +
      'Duration: ' + formatDuration(row.duration) + ' (' + SPEED_LABELS[row.klass - 1] + ')' + '\n' +
      (isOC ? 'Object: ' : 'Case: ') + row.entity + '\n' + new Date(row.start).toISOString();
    tooltip.style.left = Math.min(size.w - 278, Math.max(4, x + 13)) + 'px';
    tooltip.style.top = Math.min(size.h - 85, Math.max(4, HEADER_H + y + 12)) + 'px'; tooltip.style.display = 'block';
  });
  canvas.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
  function broadcastSelection() {
    var items = [], seen = Object.create(null);
    selectedBands.forEach(function (key) {
      var band = data && data.bands[data.bandIndex[key]];
      if (!band) return;
      [band.source, band.target].forEach(function (id) {
        if (!seen[id]) { seen[id] = true; items.push({ kind: 'activity', id: id }); }
      });
    });
    promenade.select(items);
  }

  function bandAt(event) {
    var rect = canvas.getBoundingClientRect(), y = event.clientY - rect.top;
    var bandIndex = Math.floor((y - geometry.pad.top) / geometry.bandH);
    return bandIndex < 0 || bandIndex >= data.bands.length ? null : data.bands[bandIndex];
  }

  /** A left-drag anywhere in the plot marks out a time window — which row it
   * starts on doesn't matter, every band shares the same time axis. A short
   * press without meaningful movement is left alone so it still reaches the
   * band-selection `click` handler below, same as before this existed. */
  canvas.addEventListener('mousedown', function (event) {
    if (event.button !== 0 || !data || !geometry) return;
    var rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left;
    if (px < geometry.pad.left || px > geometry.pad.left + geometry.chartW) return;
    dragState = { downPx: px, moved: false };
  });
  window.addEventListener('mousemove', function (event) {
    if (!dragState) return;
    var rect = canvas.getBoundingClientRect(), px = event.clientX - rect.left;
    if (!dragState.moved && Math.abs(px - dragState.downPx) > 4) dragState.moved = true;
    if (!dragState.moved) return;
    var lo = Math.min(dragState.downPx, px), hi = Math.max(dragState.downPx, px);
    dragSelection = { start: timeAtPx(lo), end: timeAtPx(hi) };
    draw();
  });
  window.addEventListener('mouseup', function () {
    if (!dragState) return;
    if (dragState.moved) suppressClick = true;
    dragState = null;
  });

  canvas.addEventListener('click', function (event) {
    if (suppressClick) { suppressClick = false; return; }
    if (!data || !geometry) return;
    var band = bandAt(event);
    if (!band) { if (selectedBands.size) { selectedBands = new Set(); broadcastSelection(); draw(); } return; }
    if (event.metaKey || event.ctrlKey) {
      selectedBands = new Set(selectedBands);
      if (selectedBands.has(band.key)) selectedBands.delete(band.key); else selectedBands.add(band.key);
    } else {
      selectedBands = (selectedBands.size === 1 && selectedBands.has(band.key)) ? new Set() : new Set([band.key]);
    }
    broadcastSelection();
    draw();
  });

  function hideContextMenu() { contextMenu.style.display = 'none'; }
  function menuItem(label, enabled, handler) {
    var el = document.createElement('div');
    el.textContent = label;
    el.style.cssText = 'padding:6px 10px;border-radius:3px;white-space:nowrap;cursor:' + (enabled ? 'pointer' : 'default') + ';color:' + (enabled ? 'var(--text,#252a33)' : 'var(--text-dim,#a3a9b3)') + ';';
    if (enabled) {
      el.addEventListener('mouseenter', function () { el.style.background = 'var(--hover,#eef1f6)'; });
      el.addEventListener('mouseleave', function () { el.style.background = ''; });
      el.addEventListener('click', function (event) { event.stopPropagation(); hideContextMenu(); handler(); });
    }
    contextMenu.appendChild(el);
  }
  function showContextMenu(clientX, clientY) {
    contextMenu.textContent = '';
    var count = selectedBands.size;
    menuItem(count === 1 ? 'Isolate this segment' : 'Isolate ' + count + ' segments', count > 0, function () {
      bandSelection = new Set(selectedBands);
      selectedBands = new Set();
      broadcastSelection();
      refreshVisibleBands(); renderBandMenu(); draw();
    });
    menuItem('Show all segments', bandSelection !== null, function () {
      bandSelection = null;
      refreshVisibleBands(); renderBandMenu(); draw();
    });
    menuItem('Clear selection', count > 0, function () {
      selectedBands = new Set(); broadcastSelection(); draw();
    });
    var range = dragSelection && {
      start: Math.max(geometry.min, Math.min(dragSelection.start, dragSelection.end)),
      end: Math.min(geometry.max, Math.max(dragSelection.start, dragSelection.end)),
    };
    var hasRange = !!range && range.end > range.start;
    var divider = document.createElement('div');
    divider.style.cssText = 'margin:4px 2px;border-top:1px solid var(--border,#e0e4eb);';
    contextMenu.appendChild(divider);
    menuItem('Set time range', hasRange, function () {
      promenade.setParams({ timeStart: new Date(range.start).toISOString(), timeEnd: new Date(range.end).toISOString() });
      dragSelection = null;
      draw();
    });
    menuItem('Clear time range selection', !!dragSelection, function () {
      dragSelection = null; draw();
    });
    contextMenu.style.display = 'block';
    contextMenu.style.left = clientX + 'px';
    contextMenu.style.top = clientY + 'px';
    var rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) contextMenu.style.left = Math.max(4, window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight) contextMenu.style.top = Math.max(4, window.innerHeight - rect.height - 4) + 'px';
    // Deferred so the click/contextmenu pair that opened the menu (which can
    // otherwise bubble to document in the same tick, e.g. via synthesized
    // input) doesn't immediately close it -- the same reason bandMenu's own
    // opener relies on stopPropagation rather than a permanently-attached
    // document listener.
    setTimeout(function () { document.addEventListener('click', hideContextMenu, { once: true }); }, 0);
  }
  contextMenu.addEventListener('click', function (event) { event.stopPropagation(); });
  canvas.addEventListener('contextmenu', function (event) {
    if (!data || !geometry) return;
    event.preventDefault();
    event.stopPropagation();
    var band = bandAt(event);
    if (!band && !dragSelection) return;
    if (band && !selectedBands.has(band.key)) { selectedBands = new Set([band.key]); broadcastSelection(); draw(); }
    showContextMenu(event.clientX, event.clientY);
  });

  function measure() { var rect = root.getBoundingClientRect(); if (rect.width && rect.height) { size = { w: rect.width, h: rect.height }; draw(); } }
  if (window.ResizeObserver) new ResizeObserver(measure).observe(root);
  requestAnimationFrame(measure); setTimeout(measure, 0);
  promenade.on('resize', function (next) { size = next; draw(); });
  promenade.on('theme', draw);
  promenade.on('selection', function (selection) {
    var activities = (selection.items || []).filter(function (item) { return item.kind === 'activity'; }).map(function (item) { return item.id; });
    if (!activities.length) { selectedBands = new Set(); draw(); return; }
    var matches = data ? data.bands.filter(function (band) { return activities.indexOf(band.source) >= 0 || activities.indexOf(band.target) >= 0; }) : [];
    selectedBands = new Set(matches.map(function (band) { return band.key; })); draw();
  });
  var KEYS = ['activities', 'objectTypes', 'timeStart', 'timeEnd', 'maxSegments', 'maxBands', 'showGrid', 'showLabels', 'showHover'];
  promenade.on('params', function (incoming) {
    var next = {}, mustLoad = false;
    KEYS.forEach(function (key) { next[key] = incoming[key] === undefined ? params[key] : incoming[key]; });
    mustLoad = JSON.stringify(next.activities) !== JSON.stringify(params.activities)
      || JSON.stringify(next.objectTypes) !== JSON.stringify(params.objectTypes)
      || next.timeStart !== params.timeStart || next.timeEnd !== params.timeEnd
      || next.maxSegments !== params.maxSegments || next.maxBands !== params.maxBands;
    params = next;
    if (mustLoad) scheduleLoad(); else draw();
  });
  configureInteractionSelections();
  promenade.ready();
  load();
})();
