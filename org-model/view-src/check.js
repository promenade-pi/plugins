// Bundles each *.check.ts to a temp CJS module and runs it — the invariants
// gate the build without the package taking on a test-runner dependency.
const esbuild = require('esbuild');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

for (const entry of ['src/dendrogram.check.ts']) {
  const out = path.join(os.tmpdir(), `org-check-${path.basename(entry, '.ts')}-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry], outfile: out,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning',
  });
  try { execFileSync(process.execPath, [out], { stdio: 'inherit' }); } catch { process.exit(1); }
}
