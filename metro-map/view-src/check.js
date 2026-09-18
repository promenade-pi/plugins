// Bundles this plugin's check entry to a temp file and runs it — keeps the
// plugin dependency-free (no test-runner dep) while still gating on the
// invariant. The entry pulls in `metro-layout`'s own suite first, so a
// change to the shared layout is caught here as well as in the package.
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `metro-map-check-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: ['src/check.ts'],
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
