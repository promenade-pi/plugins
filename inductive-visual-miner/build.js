const esbuild = require('esbuild');

esbuild.build({
  entryPoints: { plugin: 'src/plugin.tsx', 'dfg-plugin': 'src/dfg-plugin.tsx' }, outdir: 'build', bundle: true,
  format: 'iife', platform: 'browser', target: 'es2020', minify: true,
  loader: { '.css': 'text' }, logLevel: 'info',
}).catch(() => process.exit(1));
