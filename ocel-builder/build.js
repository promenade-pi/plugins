// Bundles the plugin into one classic-script IIFE — the sandboxed frame evals
// a single file, loaded as a classic script, not a module. CSS is pulled in as
// raw text and injected via a <style> tag at runtime: the frame's CSP
// (`style-src 'unsafe-inline'`, no external loads) has no other way in.
import * as esbuild from 'esbuild';

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
