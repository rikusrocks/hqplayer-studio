// Bundles the Electron main process (incl. Studio Core) and the preload with esbuild.
// Everything is bundled, so the packaged app ships no node_modules and no native addons
// (SQLite comes from Electron's built-in node:sqlite).
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'linked',
  // ws optional native accelerators; electron is provided by the runtime.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
};

await build({
  ...common,
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(root, 'dist/main/main.mjs'),
  format: 'esm',
  banner: {
    js: "import { createRequire as __hqpsCreateRequire } from 'node:module'; const require = __hqpsCreateRequire(import.meta.url);",
  },
});

await build({
  ...common,
  entryPoints: [join(root, 'src/main/preload.ts')],
  outfile: join(root, 'dist/main/preload.cjs'),
  format: 'cjs',
  sourcemap: false,
});
