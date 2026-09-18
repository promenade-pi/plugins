/*
 * Interaction Atlas analytical kernel. It deliberately has no DOM or
 * Promenade dependency so the worker/SQL boundary can use exactly these
 * semantics and Node can verify them without a browser.
 */
(function (global) {
  'use strict';
  var SCHEMA_VERSION = 1;
  var COORDINATE_SYSTEM = { kind: 'lifecycle-phase', version: 1 };

  function stable(value) { return String(value == null ? '' : value); }
  function number(value) { if (value == null || value === '') return null; var n = Number(value); return Number.isFinite(n) ? n : null; }
  function key(a, b) { return a + '\u0000' + b; }
  function pairOrder(a, b) { return a <= b ? [a, b] : [b, a]; }
  function bin(phase, n) { return Math.min(Math.floor(Math.max(0, Math.min(1, phase)) * n), n - 1); }
  function category(a, b) { return a === 1 && b === 1 ? 'one-to-one' : a === 1 ? 'one-to-many' : b === 1 ? 'many-to-one' : 'many-to-many'; }

  /** lifecycle-phase coordinate provider; future model providers use this shape. */
  function lifecyclePhase(bounds, objectId, timestamp) {
    var bound = bounds.get(objectId);
    if (!bound || timestamp == null) return null;
    return bound.start === bound.end ? 0.5 : (timestamp - bound.start) / (bound.end - bound.start);
  }

  function normalizedParameters(raw) {
    raw = raw || {};
    return {
      objectTypes: (raw.objectTypes || []).map(stable), activities: (raw.activities || []).map(stable),
      timeRange: raw.timeRange || {}, lifecycleBounds: raw.lifecycleBounds === 'filtered' ? 'filtered' : 'fixed',
      weighting: raw.weighting === 'pair-mass' ? 'pair-mass' : 'equal-event-mass',
      binCount: Math.max(2, Math.min(512, Math.floor(Number(raw.binCount) || 24))),
      displayScale: raw.displayScale || 'sqrt', includeZeroDurationObjects: raw.includeZeroDurationObjects !== false,
      multiplicity: raw.multiplicity || [], coordinateSystem: COORDINATE_SYSTEM
    };
  }

  /**
   * `rows`: canonical relation rows { eventId, objectId, objectType, timestamp,
   * activity, included? }. `included` denotes the active event population;
   * fixed lifecycles still use every timestamped row. Duplicate relations are
   * collapsed deliberately because OCEL e2o is a set relation.
   */
  function compute(rows, rawParameters, sourceArtifactId) {
    var p = normalizedParameters(rawParameters), warnings = [], seen = new Set(), clean = [], objectTypes = new Set();
    var excludedTimestampEvents = new Set(), allByObject = new Map(), populationByObject = new Map();
    var includedTypes = new Set(p.objectTypes);
    rows.forEach(function (r) {
      var eventId = stable(r.eventId), objectId = stable(r.objectId), type = stable(r.objectType);
      if (!eventId || !objectId || !type || (includedTypes.size && !includedTypes.has(type))) return;
      objectTypes.add(type);
      var dedupe = eventId + '\u0000' + objectId;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      var timestamp = number(r.timestamp);
      if (timestamp == null) { excludedTimestampEvents.add(eventId); return; }
      var item = { eventId: eventId, objectId: objectId, objectType: type, timestamp: timestamp, activity: stable(r.activity), included: r.included !== false };
      clean.push(item);
      var target = item.included ? populationByObject : allByObject;
      var all = allByObject.get(objectId) || []; all.push(item); allByObject.set(objectId, all);
      if (item.included) { var current = populationByObject.get(objectId) || []; current.push(item); populationByObject.set(objectId, current); }
    });
    var bounds = new Map(), zeroDuration = new Set();
    allByObject.forEach(function (items, objectId) {
      var selected = p.lifecycleBounds === 'filtered' ? (populationByObject.get(objectId) || []) : items;
      if (!selected.length) return;
      var start = Infinity, end = -Infinity;
      selected.forEach(function (item) { start = Math.min(start, item.timestamp); end = Math.max(end, item.timestamp); });
      bounds.set(objectId, { start: start, end: end });
      if (start === end) zeroDuration.add(objectId);
    });
    if (excludedTimestampEvents.size) warnings.push({ code: 'excluded-timestamps', count: excludedTimestampEvents.size, message: excludedTimestampEvents.size + ' events without usable timestamps were excluded.' });

    var byEvent = new Map(), denominator = new Map();
    clean.forEach(function (item) {
      if (!item.included || !bounds.has(item.objectId) || (!p.includeZeroDurationObjects && zeroDuration.has(item.objectId))) return;
      var phase = lifecyclePhase(bounds, item.objectId, item.timestamp);
      if (phase == null) return;
      item.phase = phase;
      var event = byEvent.get(item.eventId); if (!event) { event = []; byEvent.set(item.eventId, event); }
      event.push(item);
      var set = denominator.get(item.objectType); if (!set) { set = new Set(); denominator.set(item.objectType, set); } set.add(item.objectId);
    });
    var pairs = new Map();
    function resultFor(typeA, typeB) {
      var ordered = pairOrder(typeA, typeB), k = key(ordered[0], ordered[1]), result = pairs.get(k);
      if (!result) {
        result = { typeA: ordered[0], typeB: ordered[1], bins: new Float64Array(p.binCount * p.binCount), rawBins: new Uint32Array(p.binCount * p.binCount), rawObservationCount: 0, eventIds: new Set(), objectA: new Set(), objectB: new Set(), contactsA: new Set(), contactsB: new Set(), totalMass: 0, multiplicity: { 'one-to-one': 0, 'one-to-many': 0, 'many-to-one': 0, 'many-to-many': 0 }, observations: [] };
        pairs.set(k, result);
      }
      return result;
    }
    objectTypes.forEach(function (a) { objectTypes.forEach(function (b) { if (a <= b) resultFor(a, b); }); });
    byEvent.forEach(function (items, eventId) {
      var groups = new Map();
      items.forEach(function (item) { var group = groups.get(item.objectType) || []; group.push(item); groups.set(item.objectType, group); });
      var types = Array.from(groups.keys()).sort();
      for (var ti = 0; ti < types.length; ti++) for (var tj = ti; tj < types.length; tj++) {
        var a = types[ti], b = types[tj], left = groups.get(a), right = groups.get(b), isSame = a === b;
        var pairsInEvent = isSame ? left.length * (left.length - 1) / 2 : left.length * right.length;
        if (!pairsInEvent) continue;
        var multiplicity = category(left.length, right.length), mass = p.weighting === 'pair-mass' ? 1 : 1 / pairsInEvent, result = resultFor(a, b);
        result.eventIds.add(eventId); result.multiplicity[multiplicity]++;
        for (var i = 0; i < left.length; i++) for (var j = 0; j < right.length; j++) {
          if (isSame && j <= i) continue;
          var x = left[i], y = right[j], bi = bin(x.phase, p.binCount), bj = bin(y.phase, p.binCount), index = bi * p.binCount + bj;
          result.bins[index] += mass; result.rawBins[index]++; result.rawObservationCount++; result.totalMass += mass;
          result.objectA.add(x.objectId); result.objectB.add(y.objectId); result.contactsA.add(x.objectId); result.contactsB.add(y.objectId);
          result.observations.push({ eventId: eventId, objectA: x.objectId, objectB: y.objectId, typeA: a, typeB: b, activity: x.activity, timestamp: x.timestamp, phaseA: x.phase, phaseB: y.phase, lifetimeA: bounds.get(x.objectId).end - bounds.get(x.objectId).start, lifetimeB: bounds.get(y.objectId).end - bounds.get(y.objectId).start, multiplicityA: left.length, multiplicityB: right.length, mass: mass });
        }
      }
    });
    var summaries = Array.from(pairs.values()).map(function (r) {
      return { typeA: r.typeA, typeB: r.typeB, bins: r.bins, rawBins: r.rawBins, rawObservationCount: r.rawObservationCount, eventCount: r.eventIds.size, objectCountA: r.objectA.size, objectCountB: r.objectB.size, totalMass: r.totalMass, coverageAToB: r.contactsA.size / Math.max(1, (denominator.get(r.typeA) || new Set()).size), coverageBToA: r.contactsB.size / Math.max(1, (denominator.get(r.typeB) || new Set()).size), zeroDurationObjectCountA: countType(zeroDuration, r.typeA, clean), zeroDurationObjectCountB: countType(zeroDuration, r.typeB, clean), multiplicity: r.multiplicity, observations: r.observations };
    });
    return { schemaVersion: SCHEMA_VERSION, sourceArtifactId: sourceArtifactId || '', parameters: p, objectTypes: Array.from(objectTypes).sort().map(function (type) { return { type: type, objectCount: (denominator.get(type) || new Set()).size, zeroDurationObjectCount: countType(zeroDuration, type, clean) }; }), pairs: summaries, warnings: warnings, coordinateProvider: { descriptor: COORDINATE_SYSTEM, status: 'ready' }, futureProviders: { modelAware: 'not-available', darkMatter: 'Experimental absence analysis—not available for this artifact.' } };
  }
  function countType(ids, type, rows) { var matching = new Set(); rows.forEach(function (row) { if (row.objectType === type && ids.has(row.objectId)) matching.add(row.objectId); }); return matching.size; }
  function transpose(pair, binCount) { var out = new Float64Array(pair.bins.length); for (var y = 0; y < binCount; y++) for (var x = 0; x < binCount; x++) out[y * binCount + x] = pair.bins[x * binCount + y]; return Object.assign({}, pair, { typeA: pair.typeB, typeB: pair.typeA, bins: out, coverageAToB: pair.coverageBToA, coverageBToA: pair.coverageAToB }); }
  function select(pair, field) { return pair.observations.filter(function (o) { return o.phaseA >= field.minPhaseA && o.phaseA <= field.maxPhaseA && o.phaseB >= field.minPhaseB && o.phaseB <= field.maxPhaseB; }); }
  function representative(observations) { var seen = new Set(), output = []; if (!observations.length) return output; var cx = observations.reduce(function (s, o) { return s + o.phaseA * o.mass; }, 0) / observations.reduce(function (s, o) { return s + o.mass; }, 0), cy = observations.reduce(function (s, o) { return s + o.phaseB * o.mass; }, 0); var candidates = [ ['Nearest weighted centroid', observations.slice().sort(function(a,b){ return (a.phaseA-cx)*(a.phaseA-cx)+(a.phaseB-cy)*(a.phaseB-cy)-(b.phaseA-cx)*(b.phaseA-cx)-(b.phaseB-cy)*(b.phaseB-cy); })[0]], ['Highest multiplicity', observations.slice().sort(function(a,b){ return (b.multiplicityA*b.multiplicityB)-(a.multiplicityA*a.multiplicityB); })[0]], ['Earliest calendar time', observations.slice().sort(function(a,b){ return a.timestamp-b.timestamp || a.eventId.localeCompare(b.eventId); })[0]], ['Latest calendar time', observations.slice().sort(function(a,b){ return b.timestamp-a.timestamp || a.eventId.localeCompare(b.eventId); })[0]] ]; candidates.forEach(function(c) { var id = c[1].eventId+'\u0000'+c[1].objectA+'\u0000'+c[1].objectB; if (!seen.has(id)) { seen.add(id); output.push({ reason:c[0], observation:c[1] }); } }); return output; }
  global.InteractionAtlasEngine = { SCHEMA_VERSION: SCHEMA_VERSION, COORDINATE_SYSTEM: COORDINATE_SYSTEM, bin: bin, lifecyclePhase: lifecyclePhase, compute: compute, transpose: transpose, select: select, representative: representative };
})(typeof globalThis === 'undefined' ? this : globalThis);
