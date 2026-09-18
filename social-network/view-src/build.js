// Bundles both views into classic-script IIFEs — the sandboxed frame evals a
// single file per view, loaded as a classic script rather than a module.
// Output goes into the sibling `view/` directory that `manifest.json` and
// `package.sh` point at.
const esbuild = require('esbuild');

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  logLevel: 'info',
};

Promise.all([
  esbuild.build({ ...shared, entryPoints: ['src/plugin.tsx'], outfile: '../view/plugin.js' }),
  esbuild.build({ ...shared, entryPoints: ['src/matrix.tsx'], outfile: '../view/matrix.js' }),
]).catch(() => process.exit(1));
