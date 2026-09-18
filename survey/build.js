// Bundles the plugin into one classic-script IIFE — the sandboxed frame evals
// a single file, and all four of this package's views share it (they tell
// themselves apart with `promenade.view().id`).
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: 'build/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
