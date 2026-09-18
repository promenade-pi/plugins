// Bundles each of the plugin's five views into its own classic-script IIFE —
// the sandboxed frame evals a single file per view (`views[].entry` is
// resolved to a flat basename, see `host/plugins/store.ts`), loaded as a
// classic script, not a module. Shared code under `src/lib` is inlined into
// every one of the five bundles independently; some duplication across the
// output files is expected, the same as any two unrelated plugins that both
// bundle React today.
//
// `.css` imports are pulled in as raw text (not written as a separate
// stylesheet) and injected via a `<style>` tag at runtime — the frame's CSP
// (`style-src 'unsafe-inline'`, no external loads) has no other way to get
// React Flow's own stylesheet into the document.
const esbuild = require('esbuild');

const views = ['overview', 'object-types', 'objects', 'event-types', 'events'];

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
