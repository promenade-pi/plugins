/**
 * Petri net (layered) — a second renderer for AcceptingPetriNet, built to
 * answer one question: does a proper Sugiyama-style layered layout (what
 * Graphviz's `dot` actually implements — rank assignment, crossing
 * reduction, coordinate assignment) make Promenade's Petri nets look like
 * ProM's, where the host's own view (a plain longest-path ranking, no
 * crossing reduction) does not.
 *
 * Not a Graphviz-WASM binding. The sandboxed view boundary's CSP
 * (`default-src 'none'`, no `connect-src`) blocks every subresource load a
 * WASM build's Emscripten glue normally makes, and the harness delivers a
 * plugin as one bundle of source text, not a bundle plus a companion binary
 * — there is nowhere for a multi-megabyte .wasm file to come from short of
 * inlining it as base64 inside this file, which is fragile for what a pure
 * JS implementation of the same *algorithm* gets for free. `dot`'s layout
 * stage (Gansner, Koutsofios, North & Vo 1993) is not proprietary — this
 * file runs the same three stages it does, natively, on whatever the host
 * hands over through `promenade.artifact()`.
 *
 * Two net shapes reach here — see `host/actions/alignmentModel.ts`'s
 * `buildAlignModel` for the same split on the host side. pm4py's shape
 * (`net.labels`, parallel to `net.activities`, `null` for a silent
 * transition) is fully self-describing. The Alpha Miner's shape is not: the
 * real activity name lives in a sibling `resultStore` field the plugin
 * boundary does not expose (only the artifact's own inline payload
 * crosses), so a net without `net.labels` falls back to `#<id>` — a real
 * gap, not a bug this file can close from its side of the boundary.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.style.cssText = 'display:block';
  root.appendChild(svg);

  var artifact = promenade.artifact();
  var net = artifact.value;
  var size = { w: 0, h: 0 };
  var selected = null;

  // --- geometry ------------------------------------------------------------
  var T_W = 46, T_H = 30;      // transition box
  var P_R = 12;                 // place circle radius
  var COL_GAP = 64;             // horizontal gap between rank columns
  var ROW_GAP = 14;             // vertical gap between nodes sharing a rank
  var PAD = 20;
  var SLOT_H = Math.max(T_H, P_R * 2) + ROW_GAP;
  var COL_W = T_W + COL_GAP;

  /** `net.labels[a]` when the payload is self-describing; `#<id>` otherwise. */
  var labels = Array.isArray(net.labels) ? net.labels : null;
  function labelOf(a) { return labels ? labels[a] : '#' + a; }

  /**
   * Builds the bipartite place/transition graph the layout runs on, in one
   * id space (`p<i>` / `t<a>`) so rank assignment and crossing reduction do
   * not need to know which kind of node they are looking at.
   */
  function buildGraph() {
    var nodes = {};   // id -> { kind, ref }
    var out = {};     // id -> [id]
    var i, p, t, pair;

    for (i = 0; i < net.places.length; i++) {
      nodes['p' + i] = { kind: 'place', ref: i };
      out['p' + i] = [];
    }
    var acts = net.activities || [];
    for (i = 0; i < acts.length; i++) {
      t = acts[i];
      nodes['t' + t] = { kind: 'transition', ref: t };
      out['t' + t] = [];
    }
    var edges = [];
    (net.place_to_transition || []).forEach(function (pt) {
      var s = 'p' + pt[0], d = 't' + pt[1];
      if (!nodes[s] || !nodes[d]) return;
      out[s].push(d);
      edges.push({ s: s, d: d });
    });
    (net.transition_to_place || []).forEach(function (tp) {
      var s = 't' + tp[0], d = 'p' + tp[1];
      if (!nodes[s] || !nodes[d]) return;
      out[s].push(d);
      edges.push({ s: s, d: d });
    });
    var roots = (net.initial_marking || []).map(function (p) { return 'p' + p; })
      .filter(function (id) { return nodes[id]; });
    return { nodes: nodes, out: out, edges: edges, roots: roots };
  }

  /**
   * Layered layout: rank assignment (DFS, single-parent — the first path to
   * discover a node fixes its rank and cannot be pulled later by some other,
   * unrelated edge, which also keeps the graph acyclic without a separate
   * cycle-removal pass), barycenter crossing-reduction sweeps, then a
   * median-nudge coordinate pass. Same three stages `dot` runs; rank drives
   * the x-column here rather than a y-row, because that is the convention
   * every Petri net tool — ProM included — actually draws with.
   */
  function layout(g) {
    var ids = Object.keys(g.nodes);
    if (!ids.length) return { pos: {}, rank: {}, width: 0, height: 0 };

    var state = {}, rank = {}, discovery = [];
    function dfs(id, r) {
      state[id] = 1;
      rank[id] = r;
      discovery.push(id);
      (g.out[id] || []).forEach(function (to) {
        if (!state[to]) dfs(to, r + 1);
      });
      state[id] = 2;
    }
    g.roots.forEach(function (id) { if (!state[id]) dfs(id, 0); });
    // Anything the initial marking never reaches (an orphaned sub-graph)
    // still needs a rank, visited in a stable, deterministic order.
    ids.forEach(function (id) { if (!state[id]) dfs(id, 0); });

    var maxRank = 0;
    ids.forEach(function (id) { if (rank[id] > maxRank) maxRank = rank[id]; });

    var ranksList = [];
    for (var r = 0; r <= maxRank; r++) ranksList.push([]);
    discovery.forEach(function (id) { ranksList[rank[id]].push(id); });

    var neighborsOf = {};
    ids.forEach(function (id) { neighborsOf[id] = []; });
    g.edges.forEach(function (e) {
      neighborsOf[e.s].push(e.d);
      neighborsOf[e.d].push(e.s);
    });

    function posIndex(arr) {
      var m = {};
      arr.forEach(function (id, i) { m[id] = i; });
      return m;
    }
    for (var sweep = 0; sweep < 4; sweep++) {
      var down = sweep % 2 === 0;
      var order = [];
      for (var i2 = 0; i2 <= maxRank; i2++) order.push(down ? i2 : maxRank - i2);
      order.forEach(function (ri) {
        var neighborRank = down ? ri - 1 : ri + 1;
        if (neighborRank < 0 || neighborRank > maxRank) return;
        var posPrev = posIndex(ranksList[neighborRank]);
        var scored = ranksList[ri].map(function (id, i) {
          var positions = (neighborsOf[id] || [])
            .map(function (n) { return posPrev[n]; })
            .filter(function (p) { return p !== undefined; });
          var bary = positions.length
            ? positions.reduce(function (a, b) { return a + b; }, 0) / positions.length
            : null;
          return { id: id, bary: bary, i: i };
        });
        scored.sort(function (a, b) {
          if (a.bary === null && b.bary === null) return a.i - b.i;
          if (a.bary === null) return 1;
          if (b.bary === null) return -1;
          return a.bary - b.bary || a.i - b.i;
        });
        ranksList[ri] = scored.map(function (s) { return s.id; });
      });
    }

    // Coordinate assignment: evenly spaced, then nudged toward the median of
    // each node's neighbours so chains straighten instead of staying put at
    // their seeded slot.
    var y = {};
    ranksList.forEach(function (arr) {
      arr.forEach(function (id, i) { y[id] = PAD + i * SLOT_H; });
    });
    for (var it = 0; it < 3; it++) {
      ranksList.forEach(function (arr) {
        var desired = arr.map(function (id) {
          var ys = (neighborsOf[id] || [])
            .map(function (n) { return y[n]; })
            .filter(function (v) { return v !== undefined; })
            .sort(function (a, b) { return a - b; });
          if (!ys.length) return y[id];
          var mid = ys.length >> 1;
          return ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
        });
        var prev = PAD - SLOT_H;
        arr.forEach(function (id, i) {
          var v = Math.max(desired[i], prev + SLOT_H);
          y[id] = v;
          prev = v;
        });
      });
    }

    // Recentre each column on the diagram's shared vertical midpoint — the
    // packing above starts every rank flush against `PAD`, which otherwise
    // reads as lopsided rather than the balanced shape a process diagram is
    // expected to have.
    var globalMin = Infinity, globalMax = -Infinity;
    ids.forEach(function (id) {
      if (y[id] < globalMin) globalMin = y[id];
      if (y[id] > globalMax) globalMax = y[id];
    });
    var globalMid = (globalMin + globalMax) / 2;
    ranksList.forEach(function (arr) {
      if (!arr.length) return;
      var ys = arr.map(function (id) { return y[id]; });
      var mid = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      var shift = globalMid - mid;
      arr.forEach(function (id) { y[id] += shift; });
    });
    var minY = Infinity;
    ids.forEach(function (id) { if (y[id] < minY) minY = y[id]; });
    var norm = PAD - minY;
    ids.forEach(function (id) { y[id] += norm; });

    var pos = {};
    ids.forEach(function (id) {
      pos[id] = { x: PAD + rank[id] * COL_W, y: y[id] };
    });
    var maxY = 0;
    ids.forEach(function (id) { if (y[id] > maxY) maxY = y[id]; });
    return {
      pos: pos, rank: rank,
      width: PAD * 2 + (maxRank + 1) * COL_W,
      height: maxY + PAD + Math.max(T_H, P_R * 2),
    };
  }

  var graph = buildGraph();
  var lay = layout(graph);

  function el(tag, attrs) {
    var e = document.createElementNS(svgNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function theme(key, fallback) {
    var t = promenade.theme();
    return (t && t[key]) || fallback;
  }

  function draw() {
    // Checked before touching the DOM at all — a dockview tab that is
    // hidden (not closed) can report a transient `{w:0,h:0}` resize, and
    // clearing the SVG for that event and then bailing left the panel
    // permanently blank the next time its tab was reactivated: nothing
    // afterwards ever re-populated it, since focusing an existing panel
    // does not by itself send a fresh resize. Bailing *before* the clear
    // means a bogus zero-size event just does nothing, leaving whatever
    // was already drawn on screen exactly as it was.
    if (!lay.width || !size.w) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Drawn at natural size, not scaled to fit — a wide net stays legible
    // and the panel scrolls to it, the same trade the host's own Petri net
    // view makes. `#root` gets its own scroll here because the shared frame
    // body is `overflow:hidden` (no plugin draws outside its panel by
    // default), which this view's diagram is exactly the case that needs.
    root.style.overflow = 'auto';
    svg.setAttribute('width', Math.max(lay.width, size.w));
    svg.setAttribute('height', Math.max(lay.height, size.h));

    var marker = el('marker', {
      id: 'pnl-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse',
    });
    marker.appendChild(el('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: theme('text-dim', '#888') }));
    var defs = el('defs', {});
    defs.appendChild(marker);
    svg.appendChild(defs);

    var initialSet = {}, finalSet = {};
    (net.initial_marking || []).forEach(function (p) { initialSet[p] = true; });
    (net.final_marking || []).forEach(function (p) { finalSet[p] = true; });

    // Edges first, so nodes paint over their own connection points.
    graph.edges.forEach(function (e) {
      var a = lay.pos[e.s], b = lay.pos[e.d];
      if (!a || !b) return;
      var ac = center(e.s), bc = center(e.d);
      var x1 = a.x + ac.dx, y1 = a.y + ac.dy;
      var x2 = b.x + bc.dx, y2 = b.y + bc.dy;
      // A gentle curve, not a straight line — two arcs between the same rank
      // gap otherwise overlap into one visually ambiguous stroke.
      var mx = (x1 + x2) / 2;
      var line = el('path', {
        d: 'M ' + x1 + ' ' + y1 + ' Q ' + mx + ' ' + y1 + ' ' + mx + ' ' + ((y1 + y2) / 2) +
           ' T ' + x2 + ' ' + y2,
        fill: 'none', stroke: theme('text-dim', '#888'), 'stroke-width': '1.2',
        opacity: '0.55', 'marker-end': 'url(#pnl-arrow)',
      });
      svg.appendChild(line);
    });

    function center(id) {
      var n = graph.nodes[id];
      return n.kind === 'place'
        ? { dx: P_R, dy: P_R }
        : { dx: T_W / 2, dy: T_H / 2 };
    }

    Object.keys(graph.nodes).forEach(function (id) {
      var n = graph.nodes[id];
      var p = lay.pos[id];
      if (!p) return;
      var g = el('g', { transform: 'translate(' + p.x + ',' + p.y + ')' });

      if (n.kind === 'place') {
        var marked = initialSet[n.ref] || finalSet[n.ref];
        var circle = el('circle', {
          cx: P_R, cy: P_R, r: P_R, fill: theme('bg', '#fff'),
          stroke: theme('border', '#ccc'), 'stroke-width': '1.4',
        });
        g.appendChild(circle);
        if (marked) {
          g.appendChild(el('circle', { cx: P_R, cy: P_R, r: P_R * 0.36, fill: theme('accent', '#4a7') }));
        }
      } else {
        var label = labelOf(n.ref);
        if (label == null) {
          // Silent (tau) transition — the small filled square every Petri
          // net tool uses for it, not a mislabelled activity box.
          g.appendChild(el('rect', {
            x: (T_W - 16) / 2, y: (T_H - 16) / 2, width: 16, height: 16,
            fill: theme('text-dim', '#888'),
          }));
        } else {
          var isSel = selected !== null && selected === label;
          var rect = el('rect', {
            width: T_W, height: T_H, rx: 3,
            fill: theme('bg', '#fff'),
            stroke: isSel ? theme('accent', '#4a7') : promenade.color('activity', label),
            'stroke-width': isSel ? '2.4' : '1.6',
          });
          g.appendChild(rect);
          var title = el('title', {});
          title.textContent = label;
          g.appendChild(title);
          var text = el('text', {
            x: T_W / 2, y: T_H / 2 + 3, 'text-anchor': 'middle',
            'font-size': '8', fill: theme('text', '#1c2027'),
            'pointer-events': 'none',
          });
          text.textContent = label.length > 9 ? label.slice(0, 8) + '…' : label;
          g.appendChild(text);
          g.style.cursor = 'pointer';
          g.addEventListener('click', function () {
            var willSelect = selected !== label;
            selected = willSelect ? label : null;
            promenade.select(willSelect ? [{ kind: 'activity', id: label }] : []);
            draw();
          });
        }
      }
      svg.appendChild(g);
    });
  }

  promenade.on('selection', function (sel) {
    var hit = (sel.items || []).find(function (i) { return i.kind === 'activity'; });
    selected = hit ? hit.id : null;
    draw();
  });
  promenade.on('resize', function (s) { size = s; draw(); });
  promenade.on('theme', function () { draw(); });

  promenade.ready();
  draw();
})();
