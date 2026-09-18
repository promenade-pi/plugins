// Bundles the plugin into one classic-script IIFE — the sandboxed frame evals
// a single file, loaded as a classic script, not a module (see
// `app/src/ui/plugin-frame.html`).
//
// Bare `three` is redirected to three's WebGPU build. That build's
// `WebGPURenderer` targets WebGPU where the browser has it and falls back to
// its own WebGL 2 backend where it does not, so one renderer covers both. The
// redirect has to be global rather than a local import swap:
// `@react-three/fiber` does `import * as THREE from 'three'` itself, and two
// copies of three in one bundle means two sets of class identities, so an
// `instanceof` check inside R3F silently stops recognising objects this plugin
// created.
//
// esbuild's own `alias` option cannot express this: it rewrites the prefix, so
// aliasing `three` also rewrites `three/webgpu` and
// `three/examples/jsm/...` into nonsense paths under the target file. An
// `onResolve` filter anchored with `^three$` hits the bare specifier only, and
// leaves the subpath imports to resolve through the package's own exports map
// — which points `three/webgpu` at the very same file, so esbuild dedupes them
// into one module.
//
// `.css` imports come in as raw text and are injected via a `<style>` tag at
// runtime: the frame's CSP (`style-src 'unsafe-inline'`, no external loads) has
// no other way to get a stylesheet into the document.
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
