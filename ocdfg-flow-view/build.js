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
