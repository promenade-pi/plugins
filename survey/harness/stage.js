// Stages the dev harness into the app's `public/` directory so vite serves it.
//
// The shipped views run in a sandboxed, opaque-origin iframe: a driver's
// synthetic clicks never reach them and `read_page` sees none of their
// content, so an in-app screenshot proves a panel renders and nothing more.
// This page loads the *same* bundle in an ordinary same-origin page against a
// scripted `promenade` — which for this plugin is the right stub, because what
// needs exercising is the questionnaire logic against a *controllable*
// workspace (a panel whose parameters change on command), not DuckDB.
//
//   npm run harness      then open  /__survey-harness/index.html
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../app/public/__survey-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(dest, { recursive: true, force: true });
if (remove) { console.log(`removed ${dest}`); process.exit(0); }

fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(dest, 'index.html'));
fs.copyFileSync(path.resolve(here, '../build/plugin.js'), path.join(dest, 'plugin.js'));
console.log(`staged ${dest}\nopen /__survey-harness/index.html on the app's dev server`);
