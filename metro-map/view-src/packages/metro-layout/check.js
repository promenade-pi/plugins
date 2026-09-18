// Bundles the router check to a temp file and runs it — keeps the plugin
// dependency-free (no test-runner dep) while still gating on the invariant.
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `metro-layout-check-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: ['src/router.check.ts'],
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
