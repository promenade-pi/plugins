// Stages the dev harness into the app so vite serves it.
//
// Two destinations, deliberately:
//
//   app/__ms-harness/index.html   is inside vite's served root, so its module
//                                 script is transformed normally.
//   app/public/__ms-harness/      is copied verbatim. The view bundle must NOT
//     plugin.js                   go through vite's transform: it is a
//     fixture.json                pre-bundled classic-script IIFE, and vite
//                                 rewrites it into something that is no longer
//                                 what ships.
//
//   npm run harness      then open  http://localhost:<vite port>/__ms-harness/
//   npm run harness:rm   to remove it again
//
// Dev-only: never leave it staged in a build.
const fs = require('fs');
const path = require('path');

const here = __dirname;
const app = path.resolve(here, '../../../../app');
const pageDir = path.join(app, '__ms-harness');
const bundleDir = path.join(app, 'public/__ms-harness');
const remove = process.argv.includes('--remove');

fs.rmSync(pageDir, { recursive: true, force: true });
fs.rmSync(bundleDir, { recursive: true, force: true });
if (remove) {
  console.log(`removed ${pageDir} and ${bundleDir}`);
  process.exit(0);
}

fs.mkdirSync(pageDir, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(pageDir, 'index.html'));
fs.copyFileSync(path.join(here, 'fixture.json'), path.join(pageDir, 'fixture.json'));
fs.copyFileSync(path.resolve(here, '../../view/plugin.js'), path.join(bundleDir, 'plugin.js'));
console.log(`staged ${pageDir}\nopen /__ms-harness/ on the app's dev server`);
