// Bundles the single view into a classic-script IIFE — same idiom as
// plugins/ocelot/build.js. `.css` imports come in as raw text and are
// injected via a <style> tag at runtime (the sandboxed frame's CSP allows
// no external stylesheet loads).
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
