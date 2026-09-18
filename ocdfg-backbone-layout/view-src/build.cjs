// Bundles the sandboxed view into one classic-script IIFE: the plugin frame
// evals a single file (`views[].entry`) as a classic script, not a module.
// Mirrors plugins/ocpn-replay/view-src/build.cjs.
//
// React Flow's stylesheet is pulled in as raw text and injected via a <style>
// tag at runtime — the frame CSP allows inline styles but no external loads.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: [`${__dirname}/plugin.tsx`],
  outfile: `${__dirname}/../build/view.js`,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
