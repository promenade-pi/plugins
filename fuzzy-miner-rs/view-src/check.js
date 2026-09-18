// Bundles each *.check.ts file to a temp CJS module and runs it — keeps the
// plugin dependency-free (no test-runner dep) while still gating on the
// invariants. Every check must pass; the first failure stops the build.
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const CHECKS = ['src/filters.check.ts', 'src/matrixMetrics.check.ts'];

for (const entry of CHECKS) {
  const out = path.join(os.tmpdir(), `fuzzy-check-${path.basename(entry, '.ts')}-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry],
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
}
