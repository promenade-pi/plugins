/* Cardinality Impact Explorer — dependency-free sandboxed Promenade view. */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var data = promenade.artifact().value || {};
  var C = { ink: '#162033', muted: '#637087', line: '#dfe5ee', canvas: '#f7f9fc', teal: '#079b9b', tealSoft: '#e7f8f7', violet: '#6d4bd2', violetSoft: '#f0ecff', amber: '#e99b11', amberSoft: '#fff4df', white: '#ffffff', danger: '#ba5a25' };
  var types = data.objectTypes || [];
  var labels = {};
  types.forEach(function (t) { labels[t.id] = t.label || t.id; });
  var state = {
    primary: types[0] && types[0].id,
    reference: types[1] && types[1].id || (types[0] && types[0].id),
    target: types[2] && types[2].id || (types[1] && types[1].id) || (types[0] && types[0].id),
    cardinality: 10, filters: {}, tab: 'explore', saved: []
  };

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function icon(kind) {
    var paths = {
      network: '<circle cx="5" cy="5" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="10" cy="19" r="2.4"/><path d="M7 6.2l8.5 1M6.5 7l2.5 9.4M16.5 10l-5 7"/>',
      layers: '<path d="M12 3l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
      compare: '<rect x="3" y="4" width="10" height="12" rx="2"/><rect x="11" y="8" width="10" height="12" rx="2"/>',
      trend: '<path d="M3 17l6-6 4 3 7-9"/><path d="M15 5h5v5"/>',
      box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4.5 7.8L12 12l7.5-4.2M12 12v9"/>',
      package: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 5v5"/>',
      truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
      edit: '<path d="M4 17.5V20h2.5L18 8.5 15.5 6 4 17.5zM14.5 7l2.5 2.5M12 3v3M3 12h3"/>',
      flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M8 15h8"/>',
      clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
      shield: '<path d="M12 3l7 3v5c0 4.3-2.8 7.8-7 10-4.2-2.2-7-5.7-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>'
    };
    var s = el('span', 'ico'); s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[kind] || paths.box) + '</svg>'; return s;
  }
  function options(select, selected) {
    select.innerHTML = '';
    types.forEach(function (t) { var o = el('option', '', t.label); o.value = t.id; o.selected = t.id === selected; select.appendChild(o); });
  }
  function evidence() { return (data.pairEvidence || {})[state.primary + '\u241f' + state.reference] || { median: 1, p25: 1, p75: 1, observations: 0, support: 0 }; }
  function lifecycle() { return (data.lifecycles || {})[state.target] || { objects: 0, variants: 0, leadHours: 0, reworkRate: 0, activities: ['Start', 'Complete'], reworkActivities: [] }; }
  function estimate() {
    var base = Math.max(1, evidence().median || 1), life = lifecycle();
    var ratio = state.cardinality / base, active = Object.keys(state.filters).length;
    var variants = Math.round((ratio - 1) * 25 + active * 2);
    var leadDays = ((life.leadHours || 0) / 24) * (ratio - 1) * .18 + active * .03;
    var risk = Math.max(0, Math.min(100, (life.reworkRate || 0) + (ratio - 1) * 10 + active * 2));
    return { base: base, variants: variants, leadDays: leadDays, risk: risk, life: life };
  }
  function pct(n) { return (n > 0 ? '+' : '') + Math.round(n) + '%'; }
  function duration(n) { return (n > 0 ? '+' : '') + (Math.round(n * 10) / 10).toFixed(1) + ' d'; }
  function riskName(n) { return n < 12 ? 'low' : n < 28 ? 'medium' : 'high'; }

  var style = document.createElement('style');
  style.textContent = [
    '*{box-sizing:border-box}body{margin:0;color:' + C.ink + ';background:' + C.white + ';font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,select,input{font:inherit}.app{min-height:100vh;display:grid;grid-template-columns:178px minmax(0,1fr)}',
    '.rail{border-right:1px solid ' + C.line + ';background:#fcfdff;padding:24px 9px}.brand{padding:0 14px 23px;font-weight:750;letter-spacing:-.03em;font-size:17px}.nav{display:grid;gap:6px}.nav button{border:0;background:transparent;color:#3e4a5d;padding:13px 16px;border-radius:9px;text-align:left;display:flex;gap:12px;align-items:center;cursor:pointer}.nav button.active{color:#007f82;background:linear-gradient(90deg,' + C.tealSoft + ',#f2fbfb);box-shadow:inset 3px 0 ' + C.teal + '}.nav button:hover{background:#f3f6fa}.ico{display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center}.ico svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
    '.content{min-width:0}.top{height:89px;border-bottom:1px solid ' + C.line + ';padding:0 38px;display:flex;align-items:center;justify-content:space-between;gap:22px}.top h1{font-size:27px;letter-spacing:-.035em;margin:0}.top-meta{display:flex;align-items:center;gap:12px;color:' + C.muted + '}.small-button,.selector{height:38px;border:1px solid #cdd6e3;background:white;border-radius:8px;padding:0 11px;color:#354155}.selector{min-width:170px}.main{padding:23px 26px 28px;max-width:1500px;margin:0 auto}.analysis-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:16px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:750;color:#738097}.hint{color:' + C.muted + ';font-size:12px}.warning{background:#fff8e8;border:1px solid #f3dba4;color:#85600c;padding:9px 12px;border-radius:8px;font-size:12px;margin-bottom:14px}',
    '.grid{display:grid;grid-template-columns:minmax(620px,1fr) 405px;gap:20px}.panel{background:#fff;border:1px solid ' + C.line + ';border-radius:12px;box-shadow:0 2px 8px rgba(24,40,72,.035)}.explorer{min-height:640px;padding:20px}.control-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.field label{display:block;font-size:11px;color:' + C.muted + ';font-weight:700;margin:0 0 5px}.field select{width:100%;height:39px;border:1px solid #cfd8e5;border-radius:7px;background:white;padding:0 10px;color:' + C.ink + '}.relation-stage{min-height:330px;position:relative;display:flex;justify-content:center;align-items:center;padding:66px 10px 15px;overflow:hidden}.relation-stage:before{content:"";position:absolute;inset:15px;background:radial-gradient(circle at 51% 48%,#f5f2ff 0,rgba(255,255,255,0) 46%);pointer-events:none}.cards{display:grid;grid-template-columns:150px 150px 150px;gap:77px;align-items:center;position:relative;z-index:1}.object-card{height:230px;border:1.5px solid;border-radius:12px;padding:18px 16px;text-align:center;box-shadow:0 5px 15px rgba(29,46,73,.08);background:#fff;position:relative}.object-card:after{content:"";position:absolute;top:114px;left:100%;width:77px;border-top:7px solid;opacity:.84}.object-card:last-child:after{display:none}.teal{border-color:' + C.teal + ';color:#00898b}.violet{border-color:' + C.violet + ';color:' + C.violet + '}.amber{border-color:' + C.amber + ';color:#d48600}.teal:after{border-color:' + C.teal + '}.violet:after{border-color:' + C.violet + '}.orb{width:55px;height:55px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;color:white;box-shadow:0 7px 14px rgba(0,0,0,.13)}.teal .orb{background:linear-gradient(135deg,#08a6a6,#007f82)}.violet .orb{background:linear-gradient(135deg,#8e6ce5,#5434bb)}.amber .orb{background:linear-gradient(135deg,#f6bd48,#dc8d00)}.orb .ico svg{width:27px;height:27px}.object-card h3{font-size:19px;margin:0 0 10px;letter-spacing:-.025em}.object-card .count{color:#38465c;border-top:1px solid ' + C.line + ';padding-top:12px;font-size:16px}.object-card .count small{display:block;color:' + C.muted + ';font-size:11px;margin-top:2px}.pulse{margin-top:16px;color:' + C.muted + ';font-size:11px}.spark{height:18px;width:100%;margin:0 0 3px}.rel-badge{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:3;min-width:190px;padding:10px 13px;border:1px solid #cbd3df;background:#fff;border-radius:9px;box-shadow:0 4px 12px rgba(32,43,63,.09);display:flex;gap:7px;align-items:center;justify-content:center;color:#344154}.rel-badge strong{color:' + C.violet + ';font-size:17px}.rel-badge button{border:0;background:transparent;color:' + C.muted + ';padding:1px;cursor:pointer}.relation-note{position:absolute;top:78px;left:31%;width:1px;height:57px;border-left:1px dashed #98a4b7}.edge-split{position:absolute;left:calc(50% + 76px);top:144px;width:76px;height:105px;z-index:0}.edge-split path{fill:none;stroke-width:5;stroke-linecap:round}.edge-tag{position:absolute;right:27%;z-index:2;border:1px solid #efba59;background:#fff;border-radius:10px;padding:3px 6px;font-size:11px;color:#5e4b24}.edge-tag.a{top:125px}.edge-tag.b{top:185px}.edge-tag.c{top:245px}',
    '.scenario{display:flex;align-items:center;gap:14px;border-top:1px solid ' + C.line + ';padding:17px 3px 0}.scenario-title{display:flex;gap:8px;align-items:center;min-width:132px;font-weight:700}.scenario-title .ico{color:' + C.teal + '}.segment{display:flex;border:1px solid #ccd5e1;border-radius:8px;overflow:hidden}.segment button{height:39px;min-width:58px;border:0;border-right:1px solid #ccd5e1;background:#fff;color:#2d394d;cursor:pointer}.segment button:last-child{border:0}.segment button.active{background:linear-gradient(135deg,#704fd2,#5f41c6);color:#fff}.slider-wrap{margin-left:auto;min-width:210px;padding-left:15px;border-left:1px solid #dde3ec}.slider-label{font-size:11px;color:' + C.muted + ';display:flex;justify-content:space-between}.slider-wrap input{width:100%;accent-color:' + C.violet + '}.scenario input[type=number]{width:55px;height:32px;border:1px solid #cbd5e2;border-radius:6px;text-align:center;color:' + C.violet + ';font-weight:700}',
    '.impact{padding:19px}.impact-title{display:flex;align-items:center;gap:10px;font-weight:750;font-size:16px;margin-bottom:17px}.impact-title .ico{color:' + C.teal + '}.impact-kpis{display:grid;gap:10px}.kpi{border:1px solid ' + C.line + ';border-radius:10px;padding:14px;display:grid;grid-template-columns:48px 1fr 90px;align-items:center;gap:12px}.kpi-orb{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center}.kpi-orb.tealBg{background:' + C.tealSoft + ';color:' + C.teal + '}.kpi-orb.violetBg{background:' + C.violetSoft + ';color:' + C.violet + '}.kpi-orb.amberBg{background:' + C.amberSoft + ';color:' + C.amber + '}.kpi-orb .ico svg{width:28px;height:28px}.kpi label{font-size:12px;display:block}.kpi strong{font-size:25px;letter-spacing:-.04em}.kpi small{display:block;color:' + C.muted + ';font-size:11px}.micro{height:27px}.micro path{fill:none;stroke-width:2.3;stroke-linecap:round}.risk-scale{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:7px}.risk-scale i{display:block;width:9px;height:9px;border-radius:9px;border:1px solid #b8c2cf}.risk-scale i.on{background:' + C.amber + ';border-color:' + C.amber + ';box-shadow:0 0 0 3px #fff4dd}.risk-scale span{font-size:9px;color:' + C.muted + '}',
    '.section-title{font-size:14px;margin:22px 0 4px}.process-copy{font-size:12px;color:' + C.muted + ';margin:0 0 12px}.map{width:100%;overflow:hidden}.map svg{width:100%;height:196px}.map .line{stroke:#92a0b3;stroke-width:1.4;fill:none}.map .node{fill:white;stroke:#b9c3d1;stroke-width:1.1}.map .hot{fill:#fff8eb;stroke:' + C.amber + '}.map text{font-size:9px;fill:#344155;text-anchor:middle}.map .caption{fill:#657286;font-size:9px}.breakdowns{margin-top:13px;border-top:1px solid ' + C.line + ';padding-top:14px}.breakdowns-title{font-size:12px;font-weight:750;margin-bottom:8px}.filter-row{display:flex;gap:7px;flex-wrap:wrap}.filter-chip{border:1px solid #cfd8e5;background:#fff;color:#465267;padding:7px 8px;border-radius:7px;font-size:11px;cursor:pointer}.filter-chip.active{border-color:' + C.teal + ';background:' + C.tealSoft + ';color:#007b7e}.empty{padding:34px;color:' + C.muted + ';text-align:center}.save{margin-top:16px;width:100%;height:36px;border:1px solid ' + C.violet + ';border-radius:7px;background:#fff;color:' + C.violet + ';font-weight:700;cursor:pointer}.save:hover{background:' + C.violetSoft + '}.saved{font-size:12px;color:' + C.muted + ';margin:9px 0 0}.tab-note{padding:18px 6px;color:' + C.muted + ';font-size:13px}',
    '@media(max-width:1080px){.grid{grid-template-columns:1fr}.impact{min-height:0}.app{grid-template-columns:70px 1fr}.rail{padding:24px 7px}.brand{font-size:0;padding:0 0 23px;text-align:center}.brand:after{content:"P";font-size:19px}.nav button{justify-content:center;padding:13px}.nav button span:last-child{display:none}}@media(max-width:760px){.app{display:block}.rail{display:none}.top{height:auto;padding:17px 18px}.top h1{font-size:22px}.top-meta{display:none}.main{padding:16px 12px}.explorer{padding:13px}.control-row{grid-template-columns:1fr}.relation-stage{min-height:540px;align-items:flex-start;padding-top:80px}.cards{grid-template-columns:1fr;gap:34px;width:180px}.object-card{height:145px}.object-card:after{top:100%;left:72px;width:0;height:34px;border-top:0;border-left:7px solid}.object-card h3{margin-bottom:4px}.pulse{display:none}.rel-badge{top:7px}.relation-note,.edge-split,.edge-tag{display:none}.scenario{flex-wrap:wrap}.slider-wrap{margin-left:0;border-left:0;padding-left:0;width:100%}.grid{display:block}.impact{margin-top:16px}.kpi{grid-template-columns:44px 1fr 70px;gap:8px}.kpi strong{font-size:21px}}'
  ].join('');
  document.head.appendChild(style);

  function card(tone, iconName, title, count, delta) {
    var c = el('article', 'object-card ' + tone);
    var orb = el('div', 'orb'); orb.appendChild(icon(iconName)); c.appendChild(orb);
    c.appendChild(el('h3', '', title));
    var countNode = el('div', 'count', Number(count || 0).toLocaleString()); countNode.appendChild(el('small', '', 'instances')); c.appendChild(countNode);
    var pulse = el('div', 'pulse'); pulse.innerHTML = '<svg class="spark" viewBox="0 0 110 18" preserveAspectRatio="none"><path d="M1 15 L13 10 L23 12 L33 5 L44 11 L57 8 L68 10 L78 3 L89 7 L101 2 L109 4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' + delta; c.appendChild(pulse);
    return c;
  }
  function selectField(title, key) {
    var field = el('div', 'field'); field.appendChild(el('label', '', title));
    var select = el('select'); options(select, state[key]); select.addEventListener('change', function () { state[key] = select.value; update(); }); field.appendChild(select); return field;
  }
  function kpi(title, valueClass, iconName, main, note, line) {
    var box = el('div', 'kpi'); var orb = el('div', 'kpi-orb ' + valueClass); orb.appendChild(icon(iconName)); box.appendChild(orb);
    var copy = el('div'); copy.appendChild(el('label', '', title)); copy.appendChild(el('strong', '', main)); copy.appendChild(el('small', '', note)); box.appendChild(copy);
    var graph = el('div', 'micro'); graph.innerHTML = line; box.appendChild(graph); return box;
  }
  function makeProcess(life) {
    var acts = (life.activities || []).slice(0, 5); if (acts.length < 2) acts = ['Start', 'Complete'];
    var hot = life.reworkActivities || [];
    var svg = '<svg viewBox="0 0 390 196" role="img" aria-label="Target process map"><defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#92a0b3"/></marker></defs>';
    var x = 24;
    svg += '<line class="line" x1="14" y1="72" x2="374" y2="72" marker-end="url(#arr)"/>';
    acts.forEach(function (a, i) { var w = Math.max(46, Math.min(71, a.length * 5.4 + 16)); var isHot = hot.indexOf(a) >= 0 || (i > 1 && i < acts.length - 1); svg += '<rect class="node ' + (isHot ? 'hot' : '') + '" x="' + x + '" y="54" rx="7" width="' + w + '" height="36"/><text x="' + (x + w / 2) + '" y="70">' + esc(a).slice(0, 13) + '</text>'; if (a.length > 13) svg += '<text x="' + (x + w / 2) + '" y="81">…</text>'; x += w + 11; });
    if (acts.length > 3) { svg += '<path class="line" stroke-dasharray="4 3" d="M210 91v47h-45v-30" marker-end="url(#arr)"/><text class="caption" x="120" y="150">rework loop</text><rect class="node hot" x="170" y="120" rx="7" width="55" height="35"/><text x="197" y="136">Quality</text><text x="197" y="147">check</text>'; }
    return svg + '</svg>';
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]; }); }

  var app = el('div', 'app'); root.appendChild(app);
  var rail = el('aside', 'rail'); rail.appendChild(el('div', 'brand', 'Promenade'));
  var nav = el('nav', 'nav'); [['explore', 'network', 'Explore'], ['scenarios', 'layers', 'Scenarios'], ['compare', 'compare', 'Compare']].forEach(function (item) { var b = el('button', item[0] === state.tab ? 'active' : ''); b.appendChild(icon(item[1])); b.appendChild(el('span', '', item[2])); b.addEventListener('click', function () { state.tab = item[0]; update(); }); nav.appendChild(b); }); rail.appendChild(nav); app.appendChild(rail);
  var content = el('div', 'content'); app.appendChild(content);
  var top = el('header', 'top'); top.appendChild(el('h1', '', 'Cardinality Impact Explorer'));
  var topMeta = el('div', 'top-meta'); var context = el('select', 'selector'); context.appendChild(el('option', '', 'Object-centric analysis')); topMeta.appendChild(context); topMeta.appendChild(el('span', '', 'ⓘ  About this view')); top.appendChild(topMeta); content.appendChild(top);
  var main = el('main', 'main'); content.appendChild(main);

  function update() {
    main.innerHTML = '';
    Array.prototype.forEach.call(nav.children, function (b, i) { b.className = ['explore', 'scenarios', 'compare'][i] === state.tab ? 'active' : ''; });
    if (!types.length) { main.appendChild(el('div', 'panel empty', (data.meta || {}).message || 'No object types are available for this analysis.')); promenade.ready(); return; }
    var head = el('div', 'analysis-head'); var intro = el('div'); intro.appendChild(el('div', 'eyebrow', state.tab === 'explore' ? 'What-if workspace' : state.tab === 'scenarios' ? 'Scenario library' : 'Scenario comparison')); intro.appendChild(el('div', 'hint', state.tab === 'explore' ? 'Change a relation, then inspect the downstream target lifecycle.' : state.tab === 'scenarios' ? 'Save decision-ready cardinality assumptions from the Explore view.' : 'Compare saved assumptions against the observed cardinality baseline.')); head.appendChild(intro); head.appendChild(el('div', 'hint', (data.meta || {}).eventCount ? Number(data.meta.eventCount).toLocaleString() + ' observed events' : '')); main.appendChild(head);
    if ((data.meta || {}).truncated) main.appendChild(el('div', 'warning', 'The action used the configured event limit. Scenario evidence is based on the sampled event set.'));
    if (state.tab !== 'explore') { renderLibrary(); promenade.ready(); return; }
    renderExplorer(); promenade.ready();
  }
  function renderLibrary() {
    var box = el('section', 'panel'); box.style.padding = '20px';
    if (!state.saved.length) { box.appendChild(el('div', 'empty', 'No scenarios saved yet. Configure a relationship in Explore and choose “Save scenario”.')); }
    else { state.saved.forEach(function (s) { var r = el('div', 'tab-note'); r.style.borderBottom = '1px solid ' + C.line; r.textContent = labels[s.primary] + ' : ' + s.cardinality + ' ' + labels[s.reference] + ' → ' + labels[s.target] + ' · ' + s.variants + ' variants · ' + s.risk + ' rework risk'; box.appendChild(r); }); }
    main.appendChild(box);
  }
  function renderExplorer() {
    var grid = el('div', 'grid'); main.appendChild(grid);
    var explorer = el('section', 'panel explorer'); grid.appendChild(explorer);
    var controls = el('div', 'control-row'); controls.appendChild(selectField('Primary object', 'primary')); controls.appendChild(selectField('Related object', 'reference')); controls.appendChild(selectField('Downstream target', 'target')); explorer.appendChild(controls);
    var stage = el('div', 'relation-stage');
    var cards = el('div', 'cards'); var e = estimate();
    cards.appendChild(card('teal', 'package', labels[state.primary], types.filter(function(t){return t.id===state.primary})[0].instances, 'observed primary objects'));
    cards.appendChild(card('violet', 'box', labels[state.reference], types.filter(function(t){return t.id===state.reference})[0].instances, 'relation driver'));
    cards.appendChild(card('amber', 'truck', labels[state.target], types.filter(function(t){return t.id===state.target})[0].instances, e.life.variants + ' observed variants'));
    var rel = el('div', 'rel-badge'); rel.appendChild(el('span', '', '1 ' + labels[state.primary].toLowerCase() + ' :')); rel.appendChild(el('strong', '', String(state.cardinality) + ' ' + labels[state.reference].toLowerCase())); var edit = el('button'); edit.title = 'Edit cardinality'; edit.appendChild(icon('edit')); edit.addEventListener('click', function () { var n = window.prompt('Items per primary object (1–50)', String(state.cardinality)); if (n && /^\d+$/.test(n)) { state.cardinality = Math.max(1, Math.min(50, Number(n))); update(); } }); rel.appendChild(edit);
    stage.appendChild(rel); stage.appendChild(el('div', 'relation-note')); stage.appendChild(cards);
    stage.insertAdjacentHTML('beforeend', '<svg class="edge-split" viewBox="0 0 76 105" aria-hidden="true"><path d="M0 52 C28 52 28 10 76 10" stroke="#a485ed"/><path d="M0 52 C25 52 34 52 76 52" stroke="#b395ec"/><path d="M0 52 C28 52 28 95 76 95" stroke="#c2a6ef"/></svg>');
    [['a', Math.max(8, Math.round(evidence().support)) + '%'], ['b', Math.max(3, Math.round(evidence().support * .42)) + '%'], ['c', Math.max(1, Math.round(evidence().support * .17)) + '%']].forEach(function (x) { var tag = el('span', 'edge-tag ' + x[0], x[1]); stage.appendChild(tag); });
    explorer.appendChild(stage);
    var scenario = el('div', 'scenario'); var title = el('div', 'scenario-title'); title.appendChild(icon('flask')); title.appendChild(el('span', '', 'Test cardinality')); scenario.appendChild(title);
    var segment = el('div', 'segment'); [1, 5, 10, 25].forEach(function(n) { var b = el('button', state.cardinality === n ? 'active' : '', '1:' + n); b.addEventListener('click', function () { state.cardinality = n; update(); }); segment.appendChild(b); }); scenario.appendChild(segment);
    var input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '50'; input.value = String(state.cardinality); input.title = 'Exact related-object count'; input.addEventListener('change', function () { state.cardinality = Math.max(1, Math.min(50, Number(input.value) || 1)); update(); }); scenario.appendChild(input);
    var sliderWrap = el('div', 'slider-wrap'); var sliderLabel = el('div', 'slider-label'); sliderLabel.appendChild(el('span', '', labels[state.reference] + ' per ' + labels[state.primary].toLowerCase())); sliderLabel.appendChild(el('span', '', '1 — 25')); sliderWrap.appendChild(sliderLabel); var slider = document.createElement('input'); slider.type = 'range'; slider.min = '1'; slider.max = '25'; slider.value = String(Math.min(25, state.cardinality)); slider.addEventListener('input', function () { state.cardinality = Number(slider.value); update(); }); sliderWrap.appendChild(slider); scenario.appendChild(sliderWrap); explorer.appendChild(scenario);
    var impact = el('aside', 'panel impact'); grid.appendChild(impact); var it = el('div', 'impact-title'); it.appendChild(icon('trend')); it.appendChild(el('span', '', 'Downstream impact')); impact.appendChild(it);
    var kpis = el('div', 'impact-kpis');
    kpis.appendChild(kpi('Process variants', 'tealBg', 'trend', pct(e.variants), 'vs. observed baseline', '<svg viewBox="0 0 90 27"><path d="M1 22L13 19 23 11 34 16 46 8 58 14 68 10 79 3 89 4" stroke="#079b9b"/></svg>'));
    kpis.appendChild(kpi('Lead time', 'violetBg', 'clock', duration(e.leadDays), 'vs. observed baseline', '<svg viewBox="0 0 90 27"><path d="M1 21L11 16 21 15 31 6 42 4 53 13 64 9 75 13 89 5" stroke="#6d4bd2"/></svg>'));
    var riskBox = el('div', 'kpi'); var ro = el('div', 'kpi-orb amberBg'); ro.appendChild(icon('shield')); riskBox.appendChild(ro); var riskCopy = el('div'); riskCopy.appendChild(el('label', '', 'Rework risk')); riskCopy.appendChild(el('strong', '', riskName(e.risk))); riskCopy.appendChild(el('small', '', (e.life.reworkRate || 0).toFixed(1) + '% observed repeat rate')); riskBox.appendChild(riskCopy); var scale = el('div'); var dots = el('div', 'risk-scale'); ['Low','Medium','High'].forEach(function (name, index) { var bit = el('span'); var dot = el('i', (riskName(e.risk) === name.toLowerCase() || (riskName(e.risk) === 'high' && index < 2)) ? 'on' : ''); bit.appendChild(dot); bit.appendChild(el('span', '', name)); dots.appendChild(bit); }); scale.appendChild(dots); riskBox.appendChild(scale); kpis.appendChild(riskBox); impact.appendChild(kpis);
    impact.appendChild(el('h3', 'section-title', 'What’s affected?')); impact.appendChild(el('p', 'process-copy', 'Amber steps are repeated or most sensitive in the selected target lifecycle.'));
    var map = el('div', 'map'); map.innerHTML = makeProcess(e.life); impact.appendChild(map);
    var breakdowns = el('section', 'breakdowns'); breakdowns.appendChild(el('div', 'breakdowns-title', 'Break down the scenario'));
    var row = el('div', 'filter-row'); var defs = data.breakdowns || []; if (!defs.length) defs = [{ title: 'Picker', values: [] }, { title: 'Warehouse', values: [] }, { title: 'Customer segment', values: [] }]; defs.forEach(function (def) { var b = el('button', 'filter-chip' + (state.filters[def.title] ? ' active' : ''), def.title + (state.filters[def.title] ? ': ' + state.filters[def.title] : ' · All')); b.addEventListener('click', function () { var options = (def.values || []).slice(); if (!options.length) options = ['All', 'Group A', 'Group B']; var next = window.prompt(def.title + ' filter\n' + options.join(', '), state.filters[def.title] || ''); if (next !== null) { if (!next || next.toLowerCase() === 'all') delete state.filters[def.title]; else state.filters[def.title] = next; update(); } }); row.appendChild(b); }); breakdowns.appendChild(row); impact.appendChild(breakdowns);
    var save = el('button', 'save', 'Save scenario'); save.addEventListener('click', function () { state.saved.push({ primary: state.primary, reference: state.reference, target: state.target, cardinality: state.cardinality, variants: pct(e.variants), risk: riskName(e.risk) }); save.textContent = 'Scenario saved ✓'; setTimeout(function () { save.textContent = 'Save scenario'; }, 1000); }); impact.appendChild(save); impact.appendChild(el('p', 'saved', 'Observed baseline: 1:' + e.base + ' across ' + Number(evidence().observations || 0).toLocaleString() + ' event-level observations.'));
  }
  update();
})();
