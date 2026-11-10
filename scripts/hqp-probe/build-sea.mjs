// Builds hqp-probe into a single executable (Node SEA) for the current platform.
// On the Windows CI runner this produces dist/hqp-probe.exe — no Node install needed on the
// target PC. Requires Node >= 25.5 (`node --build-sea`).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const bundle = join(dist, 'hqp-probe.cjs');
await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  logLevel: 'info',
  banner: { js: '/* hqp-probe — read-only HQPlayer Control API diagnostic. MIT. */' },
});

const exe = join(dist, process.platform === 'win32' ? 'hqp-probe.exe' : 'hqp-probe');
const config = join(dist, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main: bundle,
      output: exe,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });
}
console.log(`built ${exe}`);
