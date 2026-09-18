// Bundles each of the plugin's seven views into its own classic-script IIFE
// — same idiom as `ocelot/build.js`: the sandboxed frame evals a single flat
// file per view, loaded as a classic script, not a module. Shared code under
// `src/lib` is inlined into every bundle independently; the resulting
// duplication across output files is expected (see ocelot's own comment
// here) and is the price of each view being an independent panel that can
// open, error, and update without any of the others loaded.
const esbuild = require('esbuild');

const views = [
  'multiplicity',
  'type-signatures',
  'lifecycle-repetition',
  'activity-timing',
  'attribute-distribution',
  'attribute-history',
  'overview',
];

esbuild.build({
  entryPoints: views.map((v) => `src/${v}/plugin.tsx`),
  outdir: 'build',
  outbase: 'src',
  entryNames: '[dir]',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
