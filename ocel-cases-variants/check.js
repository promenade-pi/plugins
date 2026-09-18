// Bundles and runs the pipeline invariants (src/lib/pipeline.check.ts) —
// `package.sh` gates on this, so a change that alters the variant partition
// or reintroduces a long main-thread block cannot be packaged.
//
//   npm run check                 synthetic log only
//   npm run check -- a.json b.json   plus real OCEL 2.0 logs
const { build } = require('esbuild');
const { execFileSync } = require('child_process');
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const out = join(mkdtempSync(join(tmpdir(), 'ocv-check-')), 'check.cjs');
build({
  entryPoints: ['src/lib/pipeline.check.ts'],
  outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning',
}).then(() => {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
}).catch(() => process.exit(1));
