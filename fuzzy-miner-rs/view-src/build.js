// Bundles both plugin views into classic-script IIFEs — the sandboxed frame
// evals a single file per view (`views[].entry` names one bundle each), each
// loaded as a classic script, not a module. Output goes into the sibling
// `view/` directory `manifest.json` and `package.sh` point at.
//
// `.css` imports are pulled in as raw text and injected via a `<style>` tag at
// runtime — the frame's CSP (`style-src 'unsafe-inline'`, no external loads)
// has no other way to get React Flow's own stylesheet into the document. Only
// `plugin.tsx` (the graph view) imports React Flow; `matrix.tsx` (the metrics
// view) draws its own canvas and carries no such stylesheet, but shares the
// same loader config for a single esbuild options object.
const esbuild = require('esbuild');

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  loader: { '.css': 'text' },
  logLevel: 'info',
};

Promise.all([
  esbuild.build({ ...shared, entryPoints: ['src/plugin.tsx'], outfile: '../view/plugin.js' }),
  esbuild.build({ ...shared, entryPoints: ['src/matrix.tsx'], outfile: '../view/matrix.js' }),
]).catch(() => process.exit(1));
