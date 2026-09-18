// Bundles the plugin into one classic-script IIFE — the sandboxed frame evals
// a single file, loaded as a classic script, not a module (see
// `app/src/ui/plugin-frame.html`).
//
// Bare `three` is redirected to three's WebGPU build, exactly as
// `plugins/friction-topography/view-src/build.js` does and for the same
// reasons: that build's `WebGPURenderer` covers WebGPU and WebGL 2 from one
// code path, and the redirect has to be global because `@react-three/fiber`
// does `import * as THREE from 'three'` itself — two copies of three in one
// bundle means two sets of class identities, and an `instanceof` check inside
// R3F silently stops recognising objects this plugin created.
//
// esbuild's `alias` option cannot express this: it rewrites the *prefix*, so
// aliasing `three` also mangles `three/webgpu` and `three/examples/jsm/...`.
// An `onResolve` filter anchored with `^three$` hits the bare specifier only.
//
// `.css` comes in as raw text and is injected via a `<style>` tag at runtime:
// the frame's CSP (`style-src 'unsafe-inline'`, no external loads) has no
// other way to get a stylesheet into the document.
const esbuild = require('esbuild');
const path = require('path');

const WEBGPU_BUILD = path.join(__dirname, 'node_modules/three/build/three.webgpu.js');

esbuild.build({
  entryPoints: ['src/plugin.tsx'],
  outfile: '../view/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  plugins: [{
    name: 'three-webgpu',
    setup(build) {
      build.onResolve({ filter: /^three$/ }, () => ({ path: WEBGPU_BUILD }));
    },
  }],
}).catch(() => process.exit(1));
