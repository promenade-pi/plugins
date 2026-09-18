// Bundles the view into one classic-script IIFE — the sandboxed frame evals
// a single file (`views[].entry` is resolved to a flat basename), loaded as
// a classic script, not a module. `.css` imports are pulled in as raw text
// and injected via a `<style>` tag at runtime, matching every other bundled
// React Flow view in this repo (the frame's CSP has no other way to load a
// stylesheet).
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: '../view/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
