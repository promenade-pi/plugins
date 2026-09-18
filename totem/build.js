// Bundles the plugin into one classic-script IIFE — the sandboxed frame
// evals a single file (`views[].entry` is resolved to a flat basename, see
// `host/plugins/store.ts`), loaded as a classic script, not a module.
//
// `.css` imports are pulled in as raw text (not written as a separate
// stylesheet) and injected via a `<style>` tag at runtime — the frame's CSP
// (`style-src 'unsafe-inline'`, no external loads) has no other way to get
// React Flow's own stylesheet into the document.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: 'build/view.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
