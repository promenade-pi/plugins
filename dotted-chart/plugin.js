/**
 * Dotted chart — example third-party view plugin.
 *
 * Runs inside the host's sandboxed frame with an opaque origin. It has no
 * access to the host DOM, no storage, no credentialed network, and no handle
 * to any panel. It reaches data only through `promenade.sql()`.
 *
 * Written in plain JS against a canvas on purpose: the plugin boundary must
 * not presume React, and a bundle that ships its own framework must not be
 * the price of entry.
 *
 * One query fetches each row's first/last timestamp and each event's
 * position within its row alongside the raw points, so — once fetched —
 * the time axis and row order are pure client-side redraws, no matter how
 * often they change. `rowsBy`, `colorBy` and `sampleLimit` still requery:
 * each names which SQL column comes back, not just how it is displayed.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  var canvas = document.createElement('canvas');
  var info = document.createElement('div');
  var legend = document.createElement('div');
  var tooltip = document.createElement('div');
  var HEADER_H = 52;
  info.style.cssText =
    'position:absolute;top:0;left:10px;right:10px;height:25px;line-height:25px;font-size:11px;opacity:.82;' +
    'pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  legend.style.cssText =
    'position:absolute;top:26px;left:9px;right:9px;height:22px;display:flex;align-items:center;gap:9px;' +
    'overflow:hidden;white-space:nowrap;font-size:10px;pointer-events:auto;color:var(--text-dim,#6b7280);';
  tooltip.style.cssText =
    'display:none;position:absolute;z-index:2;max-width:220px;padding:5px 7px;border-radius:3px;' +
    'font-size:11px;line-height:1.35;white-space:pre-line;pointer-events:none;background:rgba(25,25,25,.88);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.22)';
  root.style.position = 'relative';
  canvas.style.cssText = 'position:absolute;left:0;right:0;top:' + HEADER_H + 'px;bottom:0;';
  root.appendChild(canvas);
  root.appendChild(info);
  root.appendChild(legend);
  root.appendChild(tooltip);

  var ctx = canvas.getContext('2d');
  var data = null;
  var params = {
    rowsBy: 'case', colorBy: 'activity', timeMode: 'actual',
    sortRowsBy: 'firstEvent', sortDescending: false, sampleLimit: 40000,
    timeStart: '', timeEnd: '', dotSize: 2, showCaseIds: true, showHover: false,
  };
  var selectedColors = Object.create(null); // legend toggles, local to this chart
  var size = { w: 0, h: 0 };
  var geometry = null;
  var queryRevision = 0;
  var reloadTimer = 0;

  var artifact = promenade.artifact();
  var isOC = artifact.type === 'ObjectCentricEventLog';

  function table(logical) { return artifact.tables[logical]; }

  /** A row/colour choice the current log type cannot honour falls back cleanly. */
  function effectiveRowsBy(p) {
    if (isOC) {
      if (p.rowsBy === 'activity') return 'activity';
      if (p.rowsBy === 'objectType') return 'objectType';
      // Selecting a case notion gives each object of that type its own row.
      return p.objectType ? 'object' : 'objectType';
    }
    return p.rowsBy === 'objectType' || p.rowsBy === 'object' ? 'case' : p.rowsBy;
  }
  function effectiveColorBy(p) {
    if (isOC) return (p.colorBy === 'objectType' || p.colorBy === 'activity') ? p.colorBy : 'activity';
    return p.colorBy === 'objectType' ? 'activity' : p.colorBy;
  }

  /** Valid user-entered time bounds become numbers before they enter SQL. */
  function timeBound(value, endOfDay) {
    if (!value) return null;
    var text = String(value).trim();
    if (!text) return null;
    // A bare date is a user-facing day range, not midnight at its end.
    if (endOfDay && /^\d{4}-\d\d-\d\d$/.test(text)) text += 'T23:59:59.999Z';
    var ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * A small local palette for colour dimensions the host's shared colour
   * registry does not know about (`resource`, `lifecycle` — only
   * `activity` and `objectType` are host domains). Assigned by first
   * appearance within this panel, same rule the host uses, just not shared
   * across panels: acceptable for a dimension no other view colours by.
   */
  var LOCAL_PALETTE = [
    '#0072B2', '#E69F00', '#009E73', '#CC79A7',
    '#56B4E9', '#D55E00', '#8E6C8A', '#4C9F70',
    '#B07AA1', '#8C564B', '#7F7F7F', '#17919B',
  ];
  var localColorIndex = Object.create(null);
  function colorFor(domain, value) {
    if (domain === 'activity' || domain === 'objectType') return promenade.color(domain, value);
    var key = domain + ':' + value;
    var i = localColorIndex[key];
    if (i === undefined) {
      i = Object.keys(localColorIndex).length;
      localColorIndex[key] = i;
    }
    return LOCAL_PALETTE[i % LOCAL_PALETTE.length];
  }

  /**
   * One query, shaped by rows/colour. The row and colour expressions are
   * plain column references built from the resolved dimension, never from
   * unsanitised input — both only ever come from this manifest's own enums.
   */
  function buildSql(p) {
    var rowsBy = effectiveRowsBy(p);
    var colorBy = effectiveColorBy(p);
    var limit = Math.max(1000, Number(p.sampleLimit) || 40000);
    var from, rowExpr, colorExpr;
    var eventIdExpr, activityExpr;

    if (isOC) {
      var needsObject = rowsBy === 'object' || rowsBy === 'objectType' || colorBy === 'objectType';
      if (needsObject) {
        from = table('event') + ' e JOIN ' + table('e2o') + ' r ON r.event_id = e.event_id' +
          ' JOIN ' + table('object') + ' o ON o.object_id = r.object_id';
      } else {
        from = table('event') + ' e';
      }
      rowExpr = rowsBy === 'object' ? 'o.object_id' : rowsBy === 'objectType' ? 'o.object_type' : 'e.activity';
      colorExpr = colorBy === 'objectType' ? 'o.object_type' : 'e.activity';
      eventIdExpr = 'e.event_id';
      activityExpr = 'e.activity';
    } else {
      if (rowsBy === 'case') {
        from = table('event') + ' e JOIN ' + table('trace') + ' tr ON tr.trace_idx = e.trace_idx';
        rowExpr = 'tr.case_id';
      } else {
        from = table('event') + ' e';
        rowExpr = rowsBy === 'resource' ? 'e.resource' : 'e.activity';
      }
      colorExpr = colorBy === 'resource' ? 'e.resource'
        : colorBy === 'lifecycle' ? 'e.lifecycle' : 'e.activity';
      eventIdExpr = 'CAST(e.event_idx AS VARCHAR)';
      activityExpr = 'e.activity';
    }

    var start = timeBound(p.timeStart, false);
    var end = timeBound(p.timeEnd, true);
    var timeFilter = '';
    if (start != null) timeFilter += ' AND epoch_ms(e.ts) >= ' + start;
    if (end != null) timeFilter += ' AND epoch_ms(e.ts) <= ' + end;
    var objectFilter = rowsBy === 'object' && p.objectType
      ? " AND o.object_type = '" + String(p.objectType).replace(/'/g, "''") + "'"
      : '';

    // `USING SAMPLE` sits on the outermost FROM, reading from `enriched` —
    // never straight off `base` — so every window aggregate below is computed
    // over the *full* matching event set before a single row is thrown away.
    // Sampling `base` directly would let a case's first/last timestamp (and
    // therefore relative time, duration-sort and row order) drift with
    // whatever happened to survive sampling, silently, on every log large
    // enough for sampling to matter.
    return (
      'WITH base AS (' +
      '  SELECT e.ts AS ts, (' + rowExpr + ') AS row_key, (' + colorExpr + ') AS color_val,' +
      '    (' + eventIdExpr + ') AS event_id, (' + activityExpr + ') AS activity' +
      '  FROM ' + from +
      '  WHERE e.ts IS NOT NULL' + timeFilter + objectFilter +
      '), enriched AS (' +
      '  SELECT epoch_ms(ts) AS t, row_key AS g, color_val AS c, event_id, activity,' +
      '    epoch_ms(MIN(ts) OVER (PARTITION BY row_key)) AS first_t,' +
      '    epoch_ms(MAX(ts) OVER (PARTITION BY row_key)) AS last_t,' +
      '    ROW_NUMBER() OVER (PARTITION BY row_key ORDER BY ts) AS logical_idx' +
      '  FROM base' +
      ') SELECT t, g, c, event_id, activity, first_t, last_t, logical_idx FROM enriched USING SAMPLE ' + limit + ' ROWS'
    );
  }

  /**
   * True only for a change that alters which rows — or which columns —
   * come back from SQL. The query fetches exactly one colour column, the
   * one `colorBy` currently names, not every candidate at once; changing
   * it always needs a requery, on both log types. The time range must also
   * requery because it constrains the population before SQL sampling. Row
   * order and the time axis are genuinely free redraws.
   */
  function needsReload(next, prev) {
    return next.rowsBy !== prev.rowsBy
      || next.colorBy !== prev.colorBy
      || next.sampleLimit !== prev.sampleLimit
      || next.objectType !== prev.objectType
      || next.timeStart !== prev.timeStart
      || next.timeEnd !== prev.timeEnd;
  }

  function load() {
    var revision = ++queryRevision;
    info.textContent = 'querying…';
    promenade.sql(buildSql(params)).then(function (res) {
      // A range-handle drag can issue a newer query while this one is still
      // in flight.  Never let the older response paint over the newer range.
      if (revision !== queryRevision) return;
      var t = res.columns.t, g = res.columns.g, c = res.columns.c;
      var eventIds = res.columns.event_id, activities = res.columns.activity;
      var firstT = res.columns.first_t, lastT = res.columns.last_t;
      var logicalIdx = res.columns.logical_idx;
      var groups = [];
      var index = Object.create(null);
      var gi = new Int32Array(res.numRows);
      var groupFirst = [], groupLast = [];
      for (var i = 0; i < res.numRows; i++) {
        var name = g[i] == null ? '(none)' : String(g[i]);
        var k = index[name];
        if (k === undefined) {
          k = groups.length; index[name] = k; groups.push(name);
          groupFirst.push(Number(firstT[i])); groupLast.push(Number(lastT[i]));
        }
        gi[i] = k;
      }
      data = {
        t: t, g: gi, c: c, eventIds: eventIds, activities: activities, groups: groups,
        groupFirst: groupFirst, groupLast: groupLast,
        logicalIdx: logicalIdx, n: res.numRows,
      };
      draw();
    }).catch(function (e) {
      if (revision !== queryRevision) return;
      info.textContent = 'error: ' + e.message;
    });
  }

  function scheduleLoad() {
    // Range handles update continuously, but the SQL filter intentionally
    // runs before `USING SAMPLE`; coalesce a drag into its settled position.
    queryRevision++;
    clearTimeout(reloadTimer);
    info.textContent = 'querying…';
    reloadTimer = setTimeout(load, 140);
  }

  /** x-position for point `j`, in whatever unit `timeMode` calls for. */
  function xOf(j) {
    if (params.timeMode === 'relative') return Number(data.t[j]) - data.groupFirst[data.g[j]];
    if (params.timeMode === 'logical') return Number(data.logicalIdx[j]);
    return Number(data.t[j]);
  }

  /** Row order: a permutation of group indices, and each group's assigned lane. */
  function laneOrder() {
    var order = data.groups.map(function (_, i) { return i; });
    var key;
    if (params.sortRowsBy === 'lastEvent') key = function (i) { return data.groupLast[i]; };
    else if (params.sortRowsBy === 'duration') key = function (i) { return data.groupLast[i] - data.groupFirst[i]; };
    else if (params.sortRowsBy === 'name') key = function (i) { return data.groups[i]; };
    else key = function (i) { return data.groupFirst[i]; };
    order.sort(function (a, b) { var ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    if (params.sortDescending) order.reverse();
    var laneOfGroup = new Array(data.groups.length);
    order.forEach(function (groupIdx, lane) { laneOfGroup[groupIdx] = lane; });
    return { order: order, laneOfGroup: laneOfGroup };
  }

  /** Axis tick text for a raw x-value, unit-aware per `timeMode`. */
  function fmtTick(v) {
    if (params.timeMode === 'logical') return String(Math.round(v));
    if (params.timeMode === 'actual') return new Date(v).toISOString().slice(0, 10);
    // relative: a duration in ms, shown at whatever granularity it needs.
    var ms = Math.max(0, v);
    var s = ms / 1000, m = s / 60, h = m / 60, d = h / 24;
    if (d >= 1) return d.toFixed(d < 10 ? 1 : 0) + 'd';
    if (h >= 1) return h.toFixed(h < 10 ? 1 : 0) + 'h';
    if (m >= 1) return m.toFixed(0) + 'm';
    return Math.round(s) + 's';
  }

  var colorDomainOf = function () { return effectiveColorBy(params); };

  /** A compact DOM legend is crisper than painting small text into the canvas. */
  function drawLegend(domain) {
    legend.textContent = '';
    var title = document.createElement('span');
    title.textContent = domain === 'activity' ? 'Activity' : domain === 'objectType' ? 'Object type' : domain;
    title.style.cssText = 'font-weight:600;color:var(--text,#1c2027);margin-right:2px;';
    title.title = 'Click one or more legend values to highlight their dots.';
    legend.appendChild(title);
    var counts = Object.create(null);
    for (var i = 0; i < data.n; i++) {
      var name = String(data.c[i] == null ? '(none)' : data.c[i]);
      counts[name] = (counts[name] || 0) + 1;
    }
    var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var shown = names.slice(0, 12);
    shown.forEach(function (name) {
      var active = !!selectedColors[name];
      var item = document.createElement('button');
      item.type = 'button';
      item.title = name + ' (' + counts[name].toLocaleString() + ' points) — click to ' + (active ? 'remove highlight' : 'highlight');
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
      item.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;min-width:0;padding:1px 3px;margin:0;' +
        'border:1px solid ' + (active ? 'var(--accent,#2563eb)' : 'transparent') + ';border-radius:3px;' +
        'background:' + (active ? 'var(--accent-soft,rgba(37,99,235,.12))' : 'transparent') + ';' +
        'color:inherit;font:inherit;cursor:pointer;';
      var swatch = document.createElement('i');
      swatch.style.cssText = 'display:block;flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:' + colorFor(domain, name) + ';';
      var label = document.createElement('span');
      label.textContent = name;
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;max-width:110px;';
      item.appendChild(swatch); item.appendChild(label);
      item.addEventListener('click', function () {
        if (selectedColors[name]) delete selectedColors[name];
        else selectedColors[name] = true;
        draw();
      });
      legend.appendChild(item);
    });
    if (names.length > shown.length) {
      var rest = document.createElement('span');
      rest.textContent = '+' + (names.length - shown.length) + ' more';
      rest.title = names.slice(shown.length).join(', ');
      legend.appendChild(rest);
    }
  }

  function draw() {
    if (!data || !size.w || !size.h) return;
    var chartH = Math.max(0, size.h - HEADER_H);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = chartH * dpr;
    canvas.style.width = size.w + 'px';
    canvas.style.height = chartH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, chartH);
    var theme = promenade.theme();
    ctx.fillStyle = theme.bg || '#fff';
    ctx.fillRect(0, 0, size.w, chartH);

    if (!data.n) {
      info.textContent = 'No timestamped events in the selected time range.';
      geometry = null;
      tooltip.style.display = 'none';
      legend.textContent = '';
      return;
    }

    var rowKind = effectiveRowsBy(params);
    var labelsVisible = params.showCaseIds && (rowKind === 'case' || rowKind === 'object');
    var padL = labelsVisible ? 108 : 8, padR = 8, padT = 24, padB = 18;
    var w = size.w - padL - padR;
    var h = chartH - padT - padB;
    if (w <= 0 || h <= 0) return;

    var n = data.n;
    var xs = new Float64Array(n);
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < n; i++) {
      var v = xOf(i);
      xs[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var span = Math.max(1, max - min);

    var lanes = data.groups.length;
    var laneH = h / Math.max(1, lanes);
    var lo = laneOrder();
    var domain = colorDomainOf();
    var hitX = new Float32Array(n), hitY = new Float32Array(n);
    var dotSize = Math.max(1, Math.min(10, Number(params.dotSize) || 2));
    var colorHighlighted = Object.keys(selectedColors).length > 0;

    for (var j = 0; j < n; j++) {
      // A point is dimmed only by the legend's colour highlight — clicking
      // the canvas itself no longer does anything (see history below).
      var colorName = String(data.c[j] == null ? '(none)' : data.c[j]);
      var dim = colorHighlighted && !selectedColors[colorName];
      ctx.fillStyle = colorFor(domain, colorName);
      ctx.globalAlpha = dim ? 0.06 : colorHighlighted ? 0.88 : 0.5;
      var x = padL + ((xs[j] - min) / span) * w;
      var lane = lo.laneOfGroup[data.g[j]];
      // Jitter within the lane so dense regions still show density.
      var y = padT + lane * laneH + (((j * 2654435761) % 1000) / 1000) * Math.max(1, laneH - 2) + 1;
      if (dotSize <= 2) {
        ctx.fillRect(x - dotSize / 2, y - dotSize / 2, dotSize, dotSize);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      hitX[j] = x; hitY[j] = y;
    }
    ctx.globalAlpha = 1;

    // Top axis: a handful of evenly spaced ticks, unit-aware.
    ctx.strokeStyle = theme.border || '#ddd';
    ctx.fillStyle = theme['text-dim'] || '#888';
    ctx.font = '9px -apple-system, sans-serif';
    var ticks = Math.max(2, Math.min(6, Math.floor(w / 90)));
    for (var ti = 0; ti <= ticks; ti++) {
      var tv = min + (span * ti) / ticks;
      var tx = padL + (w * ti) / ticks;
      ctx.beginPath();
      ctx.moveTo(tx, padT - 4);
      ctx.lineTo(tx, chartH - padB);
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtTick(tv), Math.min(tx + 2, size.w - 60), 11);
    }

    // Case IDs get a reserved left column, never paint over the dots. A dense
    // log cannot show every id legibly, so make the sampling explicit: show a
    // small, evenly-spaced subset including the first and last sorted rows,
    // and put a vertical ellipsis in every omitted interval.
    var MAX_CASE_LABELS = 24;
    var labelStride = labelsVisible ? Math.max(
      Math.ceil(11 / Math.max(laneH, 0.01)),
      Math.ceil(Math.max(0, lanes - 1) / Math.max(1, MAX_CASE_LABELS - 1))
    ) : 0;
    if (labelsVisible) {
      var labelLanes = [];
      for (var labelLane = 0; labelLane < lanes; labelLane += labelStride) labelLanes.push(labelLane);
      // The final lane is important context: this is a sample over the full
      // sorted case list, not a prefix that happened to fit on screen.
      if (lanes > 1 && labelLanes[labelLanes.length - 1] !== lanes - 1) labelLanes.push(lanes - 1);
      labelLanes.forEach(function (lane, index) {
        var groupIdx = lo.order[lane];
        ctx.fillStyle = theme.text || '#1c2027';
        ctx.globalAlpha = 0.9;
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        var label = data.groups[groupIdx];
        ctx.textAlign = 'right';
        ctx.fillText(label.length > 18 ? label.slice(0, 17) + '…' : label, padL - 5, padT + lane * laneH + laneH / 2 + 3);
        var nextLane = labelLanes[index + 1];
        if (nextLane != null && nextLane - lane > 1) {
          ctx.fillStyle = theme['text-dim'] || '#888';
          ctx.globalAlpha = 0.65;
          ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.fillText('⋮', padL - 5, padT + (lane + nextLane) * laneH / 2 + 4);
        }
      });
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    geometry = { padT: padT, laneH: laneH, lo: lo, hitX: hitX, hitY: hitY, chartH: chartH, dotSize: dotSize };
    tooltip.style.display = 'none';
    drawLegend(domain);
    info.textContent =
      data.n.toLocaleString() + ' points · ' + lanes + ' rows (' + effectiveRowsBy(params) + ')' +
      ' · ' + fmtTick(min) + ' → ' + fmtTick(max) +
      (labelStride > 1 ? ' · ' + labelLanes.length + ' sampled ' + (rowKind === 'object' ? 'object' : 'case') + ' labels' : '') +
      (Object.keys(selectedColors).length ? ' · ' + Object.keys(selectedColors).length + ' legend value' + (Object.keys(selectedColors).length === 1 ? '' : 's') + ' highlighted' : '');
  }

  canvas.addEventListener('mousemove', function (e) {
    if (!params.showHover || !data || !geometry) { tooltip.style.display = 'none'; return; }
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var best = -1, bestDistance = Math.max(64, Math.pow((geometry.dotSize || 2) / 2 + 6, 2));
    for (var i = 0; i < data.n; i++) {
      var dx = geometry.hitX[i] - x, dy = geometry.hitY[i] - y;
      var distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    if (best < 0) { tooltip.style.display = 'none'; return; }
    var row = data.groups[data.g[best]];
    var activity = data.activities[best] == null ? '(none)' : String(data.activities[best]);
    var id = data.eventIds[best] == null ? '' : '\nEvent: ' + data.eventIds[best];
    tooltip.textContent =
      (effectiveRowsBy(params) === 'object' ? 'Object: ' : effectiveRowsBy(params) === 'case' ? 'Case: ' : 'Row: ') + row +
      '\nActivity: ' + activity +
      '\nTime: ' + new Date(Number(data.t[best])).toISOString() + id;
    tooltip.style.left = Math.min(size.w - 228, Math.max(4, x + 12)) + 'px';
    tooltip.style.top = (HEADER_H + Math.min(geometry.chartH - 62, Math.max(4, y + 12))) + 'px';
    tooltip.style.display = 'block';
  });
  canvas.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });

  // Resize and theme have to be injected; a sandboxed frame sees neither the
  // docking manager's layout nor the host's stylesheet.
  function measure() {
    var rect = root.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) { size = { w: rect.width, h: rect.height }; draw(); }
  }
  // The first plugin query can resolve before Dockview publishes its first
  // resize message. Observe locally as well, so a loaded chart never remains
  // stuck on "querying…" until the user manually resizes the window.
  if (window.ResizeObserver) new ResizeObserver(measure).observe(root);
  requestAnimationFrame(measure);
  setTimeout(measure, 0);
  promenade.on('resize', function (s) { size = s; draw(); });
  promenade.on('theme', function () { draw(); });
  /**
   * Pushed params are merged over what is already known, never assigned
   * wholesale. A freshly opened, untouched panel has no saved `viewParams`
   * at all, so the very first push here is `{}` — replacing `params`
   * outright would silently wipe every field (rows, colour, everything) to
   * `undefined` before the user has touched a single control.
   */
  var PARAM_KEYS = ['rowsBy', 'objectType', 'colorBy', 'timeMode', 'sortRowsBy', 'sortDescending', 'sampleLimit', 'timeStart', 'timeEnd', 'dotSize', 'showCaseIds', 'showHover'];
  promenade.on('params', function (p) {
    var merged = {};
    for (var i = 0; i < PARAM_KEYS.length; i++) {
      var k = PARAM_KEYS[i];
      merged[k] = p[k] !== undefined ? p[k] : params[k];
    }
    var reload = needsReload(merged, params);
    if (merged.colorBy !== params.colorBy) selectedColors = Object.create(null);
    params = merged;
    if (reload) scheduleLoad(); else draw();
  });

  promenade.ready();
  load();
})();
