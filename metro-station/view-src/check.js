// Bundles the view's own invariant check to a temp file and runs it — keeps
// the plugin dependency-free (no test-runner dep) while still gating the build
// on the invariants. `package.sh` runs this before esbuild.
//
// The plan's invariants live in Rust (`cargo test -p station-map-core`); these
// are the ones the *view* is responsible for, and they are all about the one
// thing the view adds to the payload: the third dimension.
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `metro-station-check-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: ['src/depth.check.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
});
try {
  execFileSync(process.execPath, [out], { stdio: 'inherit' });
} catch {
  process.exit(1);
}
