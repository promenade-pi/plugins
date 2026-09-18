// Stages the dev harness into the app so vite serves it same-origin.
//
//   npm run harness                    stage with the checked-in fixture
//   npm run harness -- --payload x.json  stage a payload built from a real log
//   npm run harness:rm                 remove it again
//
// Everything lands in `app/public/__vm-harness/`, which vite copies verbatim:
// the view bundle must NOT go through vite's transform — it is a pre-bundled
// classic-script IIFE, and vite would rewrite it into something that is no
// longer what ships.
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const app = path.resolve(here, '../../../../app');
const target = path.join(app, 'public', '__vm-harness');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes('--rm')) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
  process.exit(0);
}

const bundle = path.resolve(here, '../../view/plugin.js');
if (!fs.existsSync(bundle)) {
  console.error('view/plugin.js is missing — run `npm run build` first');
  process.exit(1);
}
const payload = path.resolve(arg('payload', path.join(here, 'payload.json')));
if (!fs.existsSync(payload)) {
  console.error(`payload not found: ${payload}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(target, 'index.html'));
fs.copyFileSync(bundle, path.join(target, 'plugin.js'));
fs.copyFileSync(payload, path.join(target, 'payload.json'));
console.log(`staged ${target}\n  payload: ${payload}\n  open http://localhost:<vite port>/__vm-harness/index.html`);
