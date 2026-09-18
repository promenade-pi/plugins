// Stages a dev harness into the app's `public/` directory so vite serves it.
// The shipped views run in a sandboxed, opaque-origin iframe the host page
// cannot read into; this page loads the same bundles same-origin, where it can.
//
//   npm run harness      then open  http://localhost:<vite port>/__rb-harness/
//   npm run harness:rm   to remove it again
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../../app/public/__rb-harness');
if (process.argv.includes('--remove')) {
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`removed ${dest}`);
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['index.html']) fs.copyFileSync(path.join(here, f), path.join(dest, f));
for (const f of ['plugin.js', 'timeline.js']) {
  fs.copyFileSync(path.resolve(here, '../../view', f), path.join(dest, f));
}
console.log(`staged ${dest}\nopen /__rb-harness/ on the app's dev server`);
