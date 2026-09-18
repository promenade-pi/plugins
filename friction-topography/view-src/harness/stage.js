// Stages the dev harness into the app so vite serves it.
//
// Two destinations, deliberately:
//
//   app/__ft-harness/index.html   is inside vite's served root, so its module
//                                 script can import `@duckdb/duckdb-wasm` by
//                                 bare specifier and its wasm with `?url`.
//   app/public/__ft-harness/      is copied verbatim. The view bundle must NOT
//     plugin.js                   go through vite's transform: it is a
//                                 pre-bundled classic-script IIFE, and vite
//                                 rewrites it into something four times the
//                                 size that is no longer what ships.
//
// The page appends a cache-busting query to the bundle URL, so a rebuild is
// picked up by a plain reload rather than silently serving the previous one.
//
//   npm run harness      then open  http://localhost:<vite port>/__ft-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const app = path.resolve(here, '../../../../app');
const pageDir = path.join(app, '__ft-harness');
const bundleDir = path.join(app, 'public/__ft-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(pageDir, { recursive: true, force: true });
fs.rmSync(bundleDir, { recursive: true, force: true });
if (remove) { console.log(`removed ${pageDir} and ${bundleDir}`); process.exit(0); }

fs.mkdirSync(pageDir, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(pageDir, 'index.html'));
// A second, debug-only page with a densely interconnected synthetic log and
// the Labels.tsx position-change instrumentation turned on - see its own
// header comment. Only staged if present, so this is a no-op for anyone who
// hasn't pulled that debug file in.
const debugCrowd = path.join(here, 'debug-crowd.html');
if (fs.existsSync(debugCrowd)) fs.copyFileSync(debugCrowd, path.join(pageDir, 'debug-crowd.html'));
fs.copyFileSync(path.resolve(here, '../../view/plugin.js'), path.join(bundleDir, 'plugin.js'));
console.log(`staged ${pageDir}\nopen /__ft-harness/ on the app's dev server`);
