// Stages a dev harness into the app's `public/` directory so vite serves it.
// The shipped view runs in a sandboxed, opaque-origin iframe the host page
// cannot read into; this page loads the same bundle same-origin, where it can.
//
//   npm run harness      then open  http://localhost:<vite port>/__org-harness/
//   npm run harness:rm   to remove it again
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dest = path.resolve(here, '../../../../app/public/__org-harness');
if (process.argv.includes('--remove')) {
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`removed ${dest}`);
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(dest, 'index.html'));
fs.copyFileSync(path.resolve(here, '../../view/plugin.js'), path.join(dest, 'plugin.js'));
console.log(`staged ${dest}\nopen /__org-harness/ on the app's dev server`);
