// Stages a dev harness into the app's `public/` directory so vite serves it.
//
// The shipped views run inside a sandboxed, opaque-origin iframe: the host
// page cannot read into it, and a driver's synthetic events do not reach it.
// This page loads the *same* bundles in an ordinary same-origin page, where
// both are possible — which is the only way to see why a view rendered blank.
//
//   npm run harness      then open  http://localhost:<vite port>/__sna-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../../app/public/__sna-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(dest, { recursive: true, force: true });
if (remove) { console.log(`removed ${dest}`); process.exit(0); }

fs.mkdirSync(dest, { recursive: true });
const copy = (from, name) => fs.copyFileSync(from, path.join(dest, name));
copy(path.join(here, 'index.html'), 'index.html');
copy(path.resolve(here, '../../view/plugin.js'), 'plugin.js');
copy(path.resolve(here, '../../view/matrix.js'), 'matrix.js');
console.log(`staged ${dest}\nopen /__sna-harness/ on the app's dev server`);
