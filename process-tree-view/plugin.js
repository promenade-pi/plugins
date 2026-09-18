/**
 * Process Tree View — example third-party view plugin.
 *
 * Runs inside the host's sandboxed frame with an opaque origin: no host DOM,
 * no storage, no credentialed network, no panel handle. It receives the tree
 * as `promenade.artifact().value` — a process tree has no table to query, so
 * there is nothing for `sql()` to do here.
 *
 * It knows nothing about the Inductive Miner. It knows the `ProcessTree`
 * payload contract, and anything that produces one can be drawn by it.
 *
 * Plain JS on a canvas on purpose: the plugin boundary must not presume React,
 * and shipping a framework must not be the price of entry.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  // The frame's own document does not scroll (host CSS), which is right: a
  // plugin must not be able to move its panel. Scrolling *inside* the plugin's
  // own rect is a different thing, and a tree wider than the panel needs it.
  root.style.cssText = 'position:relative;height:100%;overflow:auto';

  var canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block';
  var info = document.createElement('div');
  // Fixed to the frame, not to the scrolling content, so the summary stays put.
  info.style.cssText =
    'position:fixed;top:6px;left:10px;font-size:11px;opacity:.75;pointer-events:none';
  root.appendChild(canvas);
  root.appendChild(info);

  var ctx = canvas.getContext('2d');
  var params = { orientation: 'vertical', compactSilent: false, compact: false };
  var selected = null;
  var size = { w: 0, h: 0 };
  var laidOut = [];        // drawing rects, kept for hit testing
  var tree = null;

  var OPERATOR = {
    sequence: { symbol: '→', name: 'Sequence' },
    xor: { symbol: '×', name: 'Exclusive choice' },
    parallel: { symbol: '∧', name: 'Parallel' },
    loop: { symbol: '↻', name: 'Loop' },
    or: { symbol: '∨', name: 'Inclusive choice' },
    interleaving: { symbol: '↔', name: 'Interleaving' },
    partialorder: { symbol: '⊑', name: 'Partial order' }
  };

  function theme(name, fallback) {
    var v = promenade.theme()[name];
    return v && v.length ? v : fallback;
  }

  /**
   * Tidy-ish layout: leaves are placed in order, a parent is centred over its
   * children. Depth gives the other axis. Good enough for trees of the size a
   * miner produces, and it never overlaps.
   */
  function layout(payload) {
    var nodes = payload.nodes;
    var visible = [];
    var pos = new Array(nodes.length);
    var depth = new Array(nodes.length);
    var cursor = 0;

    var gapMain = params.compact ? 54 : 74;
    var gapCross = params.compact ? 74 : 104;

    // A tau leaf is never hidden from the layout: it's what makes an XOR
    // branch optional or a loop 0..* vs 1..* rather than mandatory, so
    // removing it would misrepresent the model, not just declutter the
    // drawing (see CHANGELOG). `compactSilent` only shrinks its drawn box,
    // in `draw()` below — every operator keeps its true child count.
    function walk(i, d) {
      depth[i] = d;
      var kids = nodes[i].children;
      if (kids.length === 0) {
        pos[i] = cursor;
        cursor += 1;
      } else {
        var first = null, last = null;
        for (var k = 0; k < kids.length; k++) {
          walk(kids[k], d + 1);
          if (first === null) first = pos[kids[k]];
          last = pos[kids[k]];
        }
        pos[i] = (first + last) / 2;
      }
      visible.push(i);
    }
    walk(payload.root, 0);

    var horizontal = params.orientation === 'horizontal';
    var out = [];
    for (var v = 0; v < visible.length; v++) {
      var i = visible[v];
      var main = pos[i] * gapCross + gapCross / 2;
      var cross = depth[i] * gapMain + gapMain / 2;
      out.push({
        index: i,
        x: horizontal ? cross : main,
        y: horizontal ? main : cross
      });
    }
    return {
      items: out,
      width: (horizontal ? (maxDepth(depth) + 1) * gapMain : cursor * gapCross) + gapCross,
      height: (horizontal ? cursor * gapCross : (maxDepth(depth) + 1) * gapMain) + gapMain
    };
  }

  function maxDepth(depth) {
    var m = 0;
    for (var i = 0; i < depth.length; i++) if (depth[i] > m) m = depth[i];
    return m;
  }

  function draw() {
    if (!tree) return;
    var dpr = window.devicePixelRatio || 1;
    var plan = layout(tree);
    var w = Math.max(size.w || 0, plan.width) || 1;
    var h = Math.max(size.h || 0, plan.height) || 1;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = theme('bg', '#fff');
    ctx.fillRect(0, 0, w, h);

    var at = {};
    for (var i = 0; i < plan.items.length; i++) at[plan.items[i].index] = plan.items[i];

    // Edges first, so nodes sit on top of them.
    ctx.strokeStyle = theme('border', '#dfe3ea');
    ctx.lineWidth = 1;
    for (var k in at) {
      var kids = tree.nodes[k].children;
      for (var c = 0; c < kids.length; c++) {
        var child = at[kids[c]];
        if (!child) continue;
        ctx.beginPath();
        ctx.moveTo(at[k].x, at[k].y);
        ctx.lineTo(child.x, child.y);
        ctx.stroke();
      }
    }

    laidOut = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var j = 0; j < plan.items.length; j++) {
      var it = plan.items[j];
      var node = tree.nodes[it.index];
      var isOp = node.operator != null;
      var isTau = !isOp && node.label == null;
      var label = isOp
        ? (OPERATOR[node.operator] || { symbol: '?' }).symbol
        : isTau ? 'τ' : node.label;

      var compactTau = isTau && params.compactSilent;
      ctx.font = isOp ? '600 15px system-ui, sans-serif' : compactTau ? '9px system-ui, sans-serif' : '12px system-ui, sans-serif';
      var textW = ctx.measureText(label).width;
      var boxW = isOp ? 28 : compactTau ? 14 : Math.min(150, Math.max(46, textW + 16));
      var boxH = isOp ? 28 : compactTau ? 14 : 24;
      var x = it.x - boxW / 2;
      var y = it.y - boxH / 2;
      laidOut.push({ index: it.index, x: x, y: y, w: boxW, h: boxH, label: node.label });

      var isSel = !isOp && node.label != null && node.label === selected;
      ctx.globalAlpha = compactTau ? 0.55 : 1;
      if (isOp) {
        ctx.beginPath();
        ctx.arc(it.x, it.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = theme('bg-soft', '#f7f8fa');
        ctx.fill();
        ctx.strokeStyle = theme('text-dim', '#6b7280');
        ctx.stroke();
        ctx.fillStyle = theme('text', '#1c2027');
      } else {
        ctx.fillStyle = isSel ? theme('accent-soft', '#e8efff') : theme('bg', '#fff');
        roundRect(x, y, boxW, boxH, compactTau ? 3 : 5);
        ctx.fill();
        // Activity colours come from the host's registry, so the same activity
        // is the same colour in every panel — including panels this plugin
        // knows nothing about.
        ctx.strokeStyle = isTau
          ? theme('text-dim', '#6b7280')
          : promenade.color('activity', node.label);
        ctx.lineWidth = isSel ? 2 : 1.5;
        if (isTau) ctx.setLineDash(compactTau ? [2, 2] : [3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.fillStyle = isTau ? theme('text-dim', '#6b7280') : theme('text', '#1c2027');
      }

      var shown = label;
      if (!isOp && !compactTau && textW > boxW - 16) {
        while (shown.length > 2 && ctx.measureText(shown + '…').width > boxW - 16) {
          shown = shown.slice(0, -1);
        }
        shown += '…';
      }
      if (!compactTau) ctx.fillText(shown, it.x, it.y + (isOp ? 1 : 0));
      ctx.globalAlpha = 1;
    }

    var s = tree.stats || {};
    info.style.color = theme('text-dim', '#6b7280');
    info.textContent =
      (s.operators || 0) + ' operators · ' + (s.leaves || 0) + ' leaves · ' +
      (s.silent || 0) + ' silent';
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  canvas.addEventListener('click', function (e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    for (var i = 0; i < laidOut.length; i++) {
      var b = laidOut[i];
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h && b.label) {
        // Publishes into the host's selection vocabulary. Every other panel
        // showing this log highlights the same activity, without either side
        // knowing the other exists.
        promenade.select([{ kind: 'activity', id: b.label }]);
        return;
      }
    }
    promenade.select([]);
  });

  promenade.on('params', function (next) {
    params = Object.assign(params, next || {});
    draw();
  });
  promenade.on('selection', function (sel) {
    var items = (sel && sel.items) || [];
    var act = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'activity') { act = items[i].id; break; }
    }
    selected = act;
    draw();
  });
  promenade.on('theme', draw);
  promenade.on('resize', function (r) {
    // The host reports `{w, h}`. Reading `width`/`height` here yielded
    // undefined, and `Math.max(undefined, …)` is NaN — which silently set the
    // canvas to zero size while every other part of the draw still ran.
    size = { w: r.w || 0, h: r.h || 0 };
    draw();
  });

  var artifact = promenade.artifact();
  var payload = artifact && artifact.value;
  if (!payload || !payload.nodes) {
    info.textContent = 'No process tree on this artifact.';
  } else {
    tree = payload;
    draw();
  }
  promenade.ready();
})();
