// Bundles the plugin into one classic-script IIFE — the sandboxed frame
// evals a single file (`views[].entry` is resolved to a flat basename, see
// `host/plugins/store.ts`), loaded as a classic script, not a module. Output
// goes directly into the sibling `view/` directory `manifest.json` and
// `package.sh` already point at (mirrors `plugins/ocpn-flow-view/build.js`).
//
// `.css` imports are pulled in as raw text (not written as a separate
// stylesheet) and injected via a `<style>` tag at runtime — the frame's CSP
// (`style-src 'unsafe-inline'`, no external loads) has no other way to get
// React Flow's own stylesheet into the document.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: '../view/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
}).catch(() => process.exit(1));
