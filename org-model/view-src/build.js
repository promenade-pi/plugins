// Bundles the view into a classic-script IIFE — the sandboxed frame evals a
// single file, loaded as a classic script rather than a module. Output goes
// into the sibling `view/` directory the manifest and package.sh point at.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: '../view/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  logLevel: 'info',
}).catch(() => process.exit(1));
