// Bundles the sandboxed Replay-animation view into one classic-script IIFE —
// the plugin frame evals a single file (`views[].entry`), loaded as a classic
// script, not a module. Mirrors plugins/ocpn-flow-view/build.js.
//
// `.css` imports are pulled in as raw text and injected via a <style> tag at
// runtime — the frame CSP (`style-src 'unsafe-inline'`, no external loads) has
// no other way to get React Flow's stylesheet into the document.
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
