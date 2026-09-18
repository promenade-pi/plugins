// Stages the dev harness into the app's `public/` directory so vite serves
// it. Copy of `plugins/fuzzy-miner-rs/view-src/harness/stage.js`, adjusted
// for this plugin's file names.
//
//   npm run harness      then open  http://localhost:<vite port>/__lpm-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../../app/public/__lpm-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(dest, { recursive: true, force: true });
if (remove) { console.log(`removed ${dest}`); process.exit(0); }

fs.mkdirSync(dest, { recursive: true });
const copy = (from, name) => fs.copyFileSync(from, path.join(dest, name));
copy(path.join(here, 'index.html'), 'index.html');
copy(path.resolve(here, '../../view/plugin.js'), 'plugin.js');
copy(path.resolve(here, '../../pkg/promenade_lpm.js'), 'promenade_lpm.js');
copy(path.resolve(here, '../../pkg/promenade_lpm_bg.wasm'), 'promenade_lpm_bg.wasm');
console.log(`staged ${dest}\nopen /__lpm-harness/ on the app's dev server`);
