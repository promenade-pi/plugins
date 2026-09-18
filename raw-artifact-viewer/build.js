// Bundles the plugin into one classic-script IIFE — the sandboxed frame evals
// a single file (`views[].entry` is resolved to a flat basename, see
// `host/plugins/store.ts`), loaded as a classic script, not a module.
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
