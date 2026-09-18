// Stages the dev harness into the app's `public/` directory so vite serves it.
//
// The shipped view runs inside a sandboxed, opaque-origin iframe: a driver's
// synthetic clicks never reach it and `read_page` sees none of its content, so
// an in-app screenshot can prove the panel renders and nothing more. This page
// loads the *same* bundle in an ordinary same-origin page, against the *same*
// `dataClient` — so the real worker handlers, the real DuckDB relations and the
// real Parquet files are all in the loop; only the iframe boundary is not.
//
//   npm run harness      then open  http://localhost:<vite port>/__raw-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../app/public/__raw-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(dest, { recursive: true, force: true });
if (remove) { console.log(`removed ${dest}`); process.exit(0); }

fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(dest, 'index.html'));
fs.copyFileSync(path.resolve(here, '../build/plugin.js'), path.join(dest, 'plugin.js'));
console.log(`staged ${dest}\nopen /__raw-harness/ on the app's dev server`);
