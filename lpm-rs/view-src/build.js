// Bundles the plugin into one classic-script IIFE — the sandboxed frame
// evals a single file (`views[].entry` is resolved to a flat basename), not
// a module. Output goes into the sibling `view/` directory `manifest.json`
// and `package.sh` already point at. No React here (see `src/plugin.ts`'s
// header comment for why) so there is no CSS to inline either.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.ts'],
  outfile: '../view/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  logLevel: 'info',
}).catch(() => process.exit(1));
