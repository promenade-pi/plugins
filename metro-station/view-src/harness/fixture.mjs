/**
 * Builds the harness fixture by running the *real* wasm kernel.
 *
 * Not a hand-written payload: the point of the harness is to look at what the
 * plugin actually produces, and a fixture typed out by hand is a drawing of
 * what the kernel was believed to do. This is the order-to-cash example the
 * design was drawn against — four object types, one two-day wait before
 * payment, one rework loop.
 *
 *   node harness/fixture.mjs        writes harness/fixture.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '../../pkg');

const { default: init, StationMapConvert } = await import(
  join(pkg, 'promenade_metro_station.js')
);
await init({ module_or_path: readFileSync(join(pkg, 'promenade_metro_station_bg.wasm')) });

// `node harness/fixture.mjs --dense` builds a map at the density a real OCEL
// produces — ten activities, four object types, most types visiting most
// activities. That is the case the worked example does not cover and the one
// that showed the routes rendering as hairlines.
const dense = process.argv.includes('--dense');

const FLOWS = [
  ['Order', 'Create Order', 'Add Item', 900, 55],
  ['Order', 'Add Item', 'Confirm Order', 900, 735],
  ['Order', 'Confirm Order', 'Receive Payment', 880, 207_360],
  ['Order', 'Receive Payment', 'Close Order', 880, 290],
  ['Item', 'Add Item', 'Pick Item', 2400, 720],
  ['Item', 'Pick Item', 'Confirm Order', 2400, 430],
  ['Item', 'Confirm Order', 'Pack Shipment', 2100, 5400],
  ['Invoice', 'Confirm Order', 'Issue Invoice', 700, 64_800],
  ['Invoice', 'Issue Invoice', 'Receive Payment', 700, 91_000],
  ['Shipment', 'Confirm Order', 'Pack Shipment', 640, 5400],
  ['Shipment', 'Pack Shipment', 'Ship Goods', 640, 10_800],
  ['Shipment', 'Ship Goods', 'Receive Payment', 640, 43_200],
  ['Shipment', 'Pack Shipment', 'Issue Invoice', 300, 10_800],
  ['Shipment', 'Ship Goods', 'Pack Shipment', 45, 7200],
];

const nodes = [];
const edges = [];
const seen = new Set();
for (const [objectType, src, dst, freq, avgSecs] of FLOWS) {
  edges.push({ objectType, src, dst, freq, avgSecs });
  for (const activity of [src, dst]) {
    const key = `${objectType}|${activity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      objectType,
      activity,
      count: freq,
      starts: activity === 'Create Order' ? 900 : 0,
      ends: activity === 'Close Order' ? 880 : 0,
    });
  }
}

if (dense) {
  nodes.length = 0;
  edges.length = 0;
  let seed = 0x5eed1234;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1e6) / 1e6;
  };
  const activities = Array.from({ length: 10 }, (_, i) => `Activity ${i}`);
  const types = ['items', 'orders', 'packages', 'products'];
  for (const objectType of types) {
    const mine = activities.filter(() => rnd() < 0.85);
    mine.forEach((activity, i) => nodes.push({
      objectType, activity, count: 100 + rnd() * 900,
      starts: i === 0 ? 10 : 0, ends: i === mine.length - 1 ? 10 : 0,
    }));
    mine.forEach((src, i) => {
      const targets = [];
      if (i + 1 < mine.length) targets.push(i + 1);
      if (i + 2 < mine.length) targets.push(i + 2);
      if (rnd() < 0.4 && i + 4 < mine.length) targets.push(i + 4);
      if (rnd() < 0.3 && i > 1) targets.push(i - 2);
      for (const j of targets) {
        edges.push({ objectType, src, dst: mine[j], freq: 10 + rnd() * 900, avgSecs: rnd() * 900_000 });
      }
    });
  }
}

const map = new StationMapConvert().finalize({
  inputValue: {
    objectTypes: dense ? ['items', 'orders', 'packages', 'products'] : ['Order', 'Item', 'Invoice', 'Shipment'],
    nodes,
    edges,
  },
  objectTypes: [],
  maxActivities: dense ? 10 : 12,
  edgeCoverage: 88,
  showRework: true,
});

writeFileSync(join(here, 'fixture.json'), `${JSON.stringify(map, null, 1)}\n`);
console.log(
  `fixture: ${map.platforms.length} platforms, ${map.lines.length} routes, ` +
  `${map.shafts.length} shafts, deepest ${Math.round(map.stats.maxTimeSecs)} s`
);
