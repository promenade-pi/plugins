/**
 * Relation gap evaluation.
 *
 * Reads the payload `plugin.py` returns and shows it in the order the question
 * is actually asked: is this pair of logs even comparable, then how well the
 * gaps were closed, then where the ranking went wrong, then individual cases.
 *
 * The rank distribution gets as much room as the headline metrics because a
 * ranking model's failure mode is the shape of that distribution — "usually
 * first, occasionally hopeless" and "reliably third" can share an MRR, and
 * only one of them is worth shipping.
 */
(function () {
  'use strict';

  var root = document.getElementById('root');
  root.style.cssText =
    'height:100%;overflow:auto;background:var(--bg,#fff);color:var(--text,#20242d);' +
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  var DIM = 'var(--text-dim,#687080)';
  var BORDER = 'var(--border,#dce1e9)';
  var PANEL = 'var(--panel,#fbfcfe)';
  var DANGER = 'var(--danger,#d64b43)';
  var GOOD = '#1f8a5f';
  var ACCENT = '#3a5fef';

  var params = { outcome: 'all' };

  function payload() {
    var artifact = promenade.artifact() || {};
    return artifact.value || artifact.payload || null;
  }

  function escape(text) {
    var span = document.createElement('span');
    span.textContent = String(text == null ? '' : text);
    return span.innerHTML;
  }

  function percent(value) {
    return (Number(value || 0) * 100).toFixed(1) + '%';
  }

  function number(value) {
    return Number(value || 0).toLocaleString();
  }

  function tile(label, value, note, tone) {
    return '<div style="flex:1 1 118px;min-width:118px;padding:11px 13px;border:1px solid ' + BORDER +
      ';border-radius:8px;background:' + PANEL + '">' +
      '<div style="font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' + DIM + '">' +
      escape(label) + '</div>' +
      '<div style="font-size:23px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;color:' +
      (tone || 'inherit') + '">' + escape(value) + '</div>' +
      (note ? '<div style="font-size:11.5px;color:' + DIM + ';margin-top:1px">' + escape(note) + '</div>' : '') +
      '</div>';
  }

  /** Horizontal bars, drawn to the largest bucket so the shape is readable. */
  function distribution(buckets) {
    var peak = buckets.reduce(function (max, bucket) { return Math.max(max, bucket.n); }, 0) || 1;
    var total = buckets.reduce(function (sum, bucket) { return sum + bucket.n; }, 0) || 1;
    return buckets.map(function (bucket) {
      var unranked = bucket.bucket === 'unranked';
      var width = (bucket.n / peak) * 100;
      return '<div style="display:grid;grid-template-columns:62px 1fr 104px;gap:10px;align-items:center;padding:2px 0">' +
        '<div style="text-align:right;font-variant-numeric:tabular-nums;color:' +
        (unranked ? DANGER : DIM) + '">' + escape(unranked ? 'not ranked' : bucket.bucket) + '</div>' +
        '<div style="height:15px;background:var(--bg,#fff);border:1px solid ' + BORDER + ';border-radius:3px;overflow:hidden">' +
        '<div style="height:100%;width:' + width.toFixed(2) + '%;background:' +
        (unranked ? DANGER : ACCENT) + ';opacity:.82"></div></div>' +
        '<div style="font-variant-numeric:tabular-nums;color:' + DIM + '">' +
        number(bucket.n) + ' · ' + ((bucket.n / total) * 100).toFixed(1) + '%</div>' +
        '</div>';
    }).join('');
  }

  function typeTable(rows) {
    if (!rows.length) return '';
    // "Outside", not "Outside pool": the docked inspector panel is about 310px
    // wide, and a header long enough to push the table past its container is
    // read as a clipped column rather than as a scrollable one.
    return '<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;min-width:352px">' +
      '<thead><tr>' +
      ['Object type', 'Gaps', 'Hits@1', 'MRR', 'Outside'].map(function (head, index) {
        return '<th title="' + (index === 4 ? 'Gaps whose true object was never a candidate' : '') +
          '" style="text-align:' + (index ? 'right' : 'left') + ';padding:6px 7px;border-bottom:1px solid ' +
          BORDER + ';font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:' +
          DIM + '">' + escape(head) + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td style="padding:6px 7px;border-bottom:1px solid ' + BORDER + '">' +
          escape(row.objectType) + '</td>' +
          [number(row.evaluated), percent(row.hitsAt1), Number(row.mrr || 0).toFixed(3),
           number(row.unreachable)].map(function (cell) {
            return '<td style="padding:6px 7px;border-bottom:1px solid ' + BORDER +
              ';text-align:right;font-variant-numeric:tabular-nums">' + escape(cell) + '</td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function example(entry) {
    var verdict = entry.correct
      ? '<span style="color:' + GOOD + ';font-weight:700">top-1 correct</span>'
      : '<span style="color:' + DANGER + ';font-weight:700">top-1 wrong</span>';
    var missing = entry.missing.map(function (item) {
      var rank = item.rank == null
        ? '<span style="color:' + DANGER + '">not in the candidate pool</span>'
        : 'rank ' + (Math.round(item.rank * 10) / 10);
      return '<div style="margin-top:2px"><code>' + escape(item.objectId) + '</code> ' +
        '<span style="color:' + DIM + '">' + escape(item.objectType) + ' · </span>' + rank + '</div>';
    }).join('');
    var predictions = entry.predictions.length
      ? entry.predictions.map(function (prediction, index) {
          return '<div style="display:grid;grid-template-columns:22px 1fr auto;gap:8px;padding:1px 0;' +
            (prediction.correct ? 'font-weight:700;color:' + GOOD : 'color:inherit') + '">' +
            '<span style="color:' + DIM + ';text-align:right">' + (index + 1) + '.</span>' +
            '<span><code>' + escape(prediction.objectId) + '</code></span>' +
            '<span style="font-variant-numeric:tabular-nums;color:' + DIM + '">' +
            escape(Number(prediction.score).toFixed(2)) + '</span></div>';
        }).join('')
      : '<div style="color:' + DIM + '">no candidate had any co-occurrence evidence</div>';

    return '<article style="border:1px solid ' + BORDER + ';border-left:3px solid ' +
      (entry.correct ? GOOD : DANGER) + ';border-radius:7px;margin:8px 0;padding:11px 13px;background:' + PANEL + '">' +
      '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">' +
      '<strong>' + escape(entry.activity || 'event') + '</strong>' +
      '<code style="color:' + DIM + ';font-size:11px">' + escape(entry.eventId) + '</code>' +
      '<span style="margin-left:auto">' + verdict + '</span></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin-top:9px">' +
      '<div><div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:' +
      DIM + ';margin-bottom:3px">Observed context</div>' +
      entry.observed.map(function (item) {
        return '<div><code>' + escape(item.objectId) + '</code></div>';
      }).join('') + '</div>' +
      '<div><div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:' +
      DIM + ';margin-bottom:3px">Removed</div>' + missing + '</div>' +
      '<div><div style="font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:' +
      DIM + ';margin-bottom:3px">Ranked candidates</div>' + predictions + '</div>' +
      '</div></article>';
  }

  /**
   * The training curve, for the arm that has one.
   *
   * Loss alone does not say whether the run finished: the objective is a hinge
   * at a margin, so what matters is whether the separation between true and
   * false pairs has reached it. Both series are drawn against that line, which
   * is why the margin is on the chart rather than in the caption.
   *
   * Colours are set through `style`, not through `fill`/`stroke` attributes —
   * a CSS variable resolves in a style declaration and is ignored in a
   * presentation attribute, which fails silently and leaves black-on-black in
   * the dark theme.
   */
  function trainingSection(training) {
    if (!training || !training.history || training.history.length < 2) return '';
    var history = training.history;
    var width = 640, height = 132, padLeft = 34, padRight = 10, padTop = 10, padBottom = 22;
    var lastEpoch = history[history.length - 1].epoch || 1;
    var top = Math.max(
      training.margin * 1.15,
      history.reduce(function (max, row) { return Math.max(max, row.loss, row.pos - row.neg); }, 0)
    ) || 1;
    var x = function (epoch) {
      return padLeft + (epoch / lastEpoch) * (width - padLeft - padRight);
    };
    var y = function (value) {
      return height - padBottom - (value / top) * (height - padTop - padBottom);
    };
    var path = function (pick) {
      return history.map(function (row, index) {
        return (index ? 'L' : 'M') + x(row.epoch).toFixed(1) + ' ' + y(pick(row)).toFixed(1);
      }).join(' ');
    };

    var ticks = [0, top / 2, top].map(function (value) {
      return '<text x="' + (padLeft - 5) + '" y="' + (y(value) + 3).toFixed(1) +
        '" text-anchor="end" style="fill:' + DIM + ';font-size:9px">' + value.toFixed(1) + '</text>' +
        '<line x1="' + padLeft + '" y1="' + y(value).toFixed(1) + '" x2="' + (width - padRight) +
        '" y2="' + y(value).toFixed(1) + '" style="stroke:' + BORDER + ';stroke-width:1"></line>';
    }).join('');

    var chart = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Training loss and ' +
      'positive-negative separation over ' + lastEpoch + ' steps" style="width:100%;height:auto;display:block">' +
      ticks +
      '<line x1="' + padLeft + '" y1="' + y(training.margin).toFixed(1) + '" x2="' + (width - padRight) +
      '" y2="' + y(training.margin).toFixed(1) + '" style="stroke:' + GOOD +
      ';stroke-width:1;stroke-dasharray:4 3"></line>' +
      '<path d="' + path(function (r) { return r.loss; }) + '" style="fill:none;stroke:' + ACCENT +
      ';stroke-width:1.6"></path>' +
      '<path d="' + path(function (r) { return r.pos - r.neg; }) + '" style="fill:none;stroke:' + GOOD +
      ';stroke-width:1.6"></path>' +
      '<text x="' + padLeft + '" y="' + (height - 6) + '" style="fill:' + DIM + ';font-size:9px">0</text>' +
      '<text x="' + (width - padRight) + '" y="' + (height - 6) +
      '" text-anchor="end" style="fill:' + DIM + ';font-size:9px">' + lastEpoch + ' steps</text>' +
      '</svg>';

    var facts = [
      ['Width', training.hiddenDim],
      ['Layers', training.layers],
      ['Steps', number(training.epochs)],
      ['Batch', number(training.batchEvents)],
      // The kernel trains in f32 and the payload is f64, so 0.3 arrives as
      // 0.30000001192092896. Six decimals is far more precision than any of
      // these settings carries, and trailing zeros are stripped.
      ['Dropout', +Number(training.dropout).toFixed(6)],
      ['Learning rate', +Number(training.learningRate).toFixed(6)],
      ['Seed', training.seed],
    ].map(function (pair) {
      return '<span style="color:' + DIM + '">' + escape(pair[0]) + ' <strong style="color:inherit">' +
        escape(pair[1]) + '</strong></span>';
    }).join(' · ');

    return '<section style="margin-top:26px"><h2 style="font-size:15px;margin:0 0 4px">Training</h2>' +
      '<p style="margin:0 0 10px;color:' + DIM + '">' +
      '<span style="color:' + ACCENT + ';font-weight:700">loss</span> and ' +
      '<span style="color:' + GOOD + ';font-weight:700">separation</span> per step; the dashed line is the ' +
      'margin the separation has to clear.</p>' +
      '<div style="border:1px solid ' + BORDER + ';border-radius:8px;padding:10px 12px;background:' + PANEL + '">' +
      chart + '</div>' +
      '<p style="margin:9px 0 0">' +
      (training.converged
        ? '<span style="color:' + GOOD + ';font-weight:700">Converged.</span> '
        : '<span style="color:' + DANGER + ';font-weight:700">Not converged.</span> ') +
      'Final loss ' + Number(training.finalLoss).toFixed(4) + ', separation ' +
      Number(training.finalGap).toFixed(3) + ' against a margin of ' +
      (+Number(training.margin).toFixed(6)) +
      (training.converged ? '.' : ' — more steps, or a wider embedding, would still help.') +
      '</p>' +
      '<p style="margin:5px 0 0;font-size:12px;color:' + DIM + '">' + facts + '</p>' +
      '</section>';
  }

  function render() {
    var report = payload();
    if (!report || !report.metrics) {
      root.innerHTML = '<div style="padding:24px;color:' + DIM +
        '">This evaluation has no readable payload.</div>';
      return;
    }

    var metrics = report.metrics;
    var meta = report.meta || {};
    var method = report.method || {};
    var pairing = report.pairing || {};
    var hits = metrics.hitsAt || {};

    var html = '<div style="max-width:1080px;margin:0 auto;padding:22px 26px 40px">';

    html += '<h1 style="margin:0;font-size:22px;letter-spacing:-.02em">Relation gap evaluation</h1>' +
      '<p style="margin:3px 0 0;color:' + DIM + '">' +
      number(metrics.evaluated) + ' missing relations across ' + number(metrics.gappedEvents) +
      ' events · ' + number(meta.observedRelations) + ' relations observed · ' +
      number(meta.objectCount) + ' objects</p>';

    if (pairing.derivedPair === false) {
      html += '<div role="alert" style="margin-top:14px;padding:11px 13px;border:1px solid ' + DANGER +
        ';border-radius:8px;background:' + DANGER + '12">' +
        '<strong style="color:' + DANGER + '">These two logs are not a derived pair.</strong>' +
        '<div style="margin-top:3px">The gapped log holds ' +
        number(pairing.relationsOnlyInPartial) + ' relations, ' +
        number(pairing.eventsOnlyInPartial) + ' events and ' +
        number(pairing.objectsOnlyInPartial) +
        ' objects the reference does not. A gapped log is always a subset of the log it came from, ' +
        'so the figures below describe the difference between two unrelated logs rather than a ' +
        'reconstruction. Run “Simulate relation gaps” on the reference log and evaluate that result.</div></div>';
    }

    html += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:16px">' +
      tile('Hits@1', percent(hits['1']), 'right first time') +
      tile('Hits@5', percent(hits['5']), 'in the top five') +
      tile('Hits@10', percent(hits['10']), 'in the top ten') +
      tile('MRR', Number(metrics.mrr || 0).toFixed(4), 'mean reciprocal rank') +
      '</div>';

    html += '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:9px">' +
      tile('Precision@' + method.topK, percent(metrics.precisionAtK), 'of predictions kept') +
      tile('Recall@' + method.topK, percent(metrics.recallAtK), 'of gaps closed') +
      tile('F1@' + method.topK, Number(metrics.f1AtK || 0).toFixed(4), '') +
      tile('Outside pool', number(metrics.unreachable),
           'never a candidate', metrics.unreachable ? DANGER : DIM) +
      '</div>';

    html += trainingSection(report.training);

    html += '<section style="margin-top:26px"><h2 style="font-size:15px;margin:0 0 4px">Where the true object ranked</h2>' +
      '<p style="margin:0 0 10px;color:' + DIM + '">' +
      (method.candidatePool === 'all'
        ? 'Objects with no co-occurrence evidence share the position after the last scored candidate, so every gap has a rank.'
        : 'Only objects seen beside an observed object are ranked; the rest count as misses.') +
      '</p>' + distribution(report.rankDistribution || []) + '</section>';

    html += '<section style="margin-top:26px"><h2 style="font-size:15px;margin:0 0 10px">By object type</h2>' +
      typeTable(report.byObjectType || []) + '</section>';

    var examples = (report.examples || []).filter(function (entry) {
      return params.outcome === 'all'
        || (params.outcome === 'correct' ? entry.correct : !entry.correct);
    });

    html += '<section style="margin-top:26px">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">' +
      '<h2 style="font-size:15px;margin:0">Worked examples</h2>' +
      '<label for="outcome" style="color:' + DIM + '">Show</label>' +
      '<select id="outcome"><option value="all">All</option>' +
      '<option value="correct">Top-1 correct</option>' +
      '<option value="incorrect">Top-1 wrong</option></select>' +
      '<span style="margin-left:auto;color:' + DIM + '">' + examples.length + ' of ' +
      (report.examples || []).length + '</span></div>';
    html += examples.length
      ? examples.map(example).join('')
      : '<p style="color:' + DIM + '">No example matches this filter.</p>';
    html += '</section>';

    html += '<section style="margin-top:26px;padding-top:14px;border-top:1px solid ' + BORDER +
      ';color:' + DIM + ';font-size:12px">' +
      '<div><strong>Model:</strong> ' + escape(method.model || '') + ' — ' + escape(method.score || '') + '</div>' +
      '<div style="margin-top:3px"><strong>Estimated from:</strong> ' + escape(method.estimatedFrom || '') + '</div>' +
      '<div style="margin-top:3px"><strong>Candidate pool:</strong> ' + escape(method.candidatePool || '') +
      ' · <strong>Predictions kept:</strong> ' + escape(String(method.topK)) + '</div>' +
      '<div style="margin-top:3px">' + escape(method.reference || '') + '</div>' +
      '</section>';

    root.innerHTML = html + '</div>';

    var outcome = document.getElementById('outcome');
    if (outcome) {
      outcome.value = params.outcome;
      outcome.onchange = function () { params.outcome = outcome.value; render(); };
    }
  }

  promenade.on('params', function (next) {
    params = { outcome: (next && next.outcome) || 'all' };
    render();
  });
  promenade.ready();
  render();
})();
