// Builds the Windows diagnostic tools into single executables (Node SEA) for the current platform:
//   hqp-probe  — read-only Gate A/B probe
//   hqp-gatec  — Gate C write-command test (approved plan, step-by-step, restores the playlist)
// On the Windows CI runner this produces dist/*.exe — no Node install needed on the target PC.
// Requires Node >= 25.5 (`node --build-sea`).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const tools = [
  { name: 'hqp-probe', entry: 'src/main.ts', banner: 'read-only HQPlayer Control API diagnostic' },
  {
    name: 'hqp-gatec',
    entry: 'src/gatec-main.ts',
    banner: 'Gate C write-command test (approved plan)',
  },
];

for (const tool of tools) {
  const bundle = join(dist, `${tool.name}.cjs`);
  await build({
    entryPoints: [join(root, tool.entry)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    logLevel: 'info',
    banner: { js: `/* ${tool.name} — ${tool.banner}. MIT. */` },
  });
  const exe = join(dist, process.platform === 'win32' ? `${tool.name}.exe` : tool.name);
  const config = join(dist, `${tool.name}.sea-config.json`);
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
}
