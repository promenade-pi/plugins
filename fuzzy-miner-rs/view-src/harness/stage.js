// Stages the dev harness into the app's `public/` directory so vite serves it.
//
// The shipped view runs inside a sandboxed, opaque-origin iframe, and a test
// driver's synthetic input events do not reach it — which makes the slider
// rail, the one part of this plugin that is purely interactive, impossible to
// exercise in place. This page loads the *same* bundle and the *same* wasm
// kernel in an ordinary same-origin page, where they can be.
//
//   npm run harness      then open  http://localhost:<vite port>/__fuzzy-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../../app/public/__fuzzy-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(dest, { recursive: true, force: true });
if (remove) { console.log(`removed ${dest}`); process.exit(0); }

fs.mkdirSync(dest, { recursive: true });
const copy = (from, name) => fs.copyFileSync(from, path.join(dest, name));
copy(path.join(here, 'index.html'), 'index.html');
copy(path.resolve(here, '../../view/plugin.js'), 'plugin.js');
copy(path.resolve(here, '../../view/matrix.js'), 'matrix.js');
copy(path.resolve(here, '../../pkg/promenade_fuzzy_miner.js'), 'promenade_fuzzy_miner.js');
copy(path.resolve(here, '../../pkg/promenade_fuzzy_miner_bg.wasm'), 'promenade_fuzzy_miner_bg.wasm');
console.log(`staged ${dest}\nopen /__fuzzy-harness/ on the app's dev server`);
