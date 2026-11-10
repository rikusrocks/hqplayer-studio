// Copies the built Web Remote into the desktop bundle so Core can serve it at /remote/.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '../remote/dist');
const dest = join(root, 'dist/remote');
if (!existsSync(src)) {
  console.error('apps/remote/dist not found — run `pnpm --filter @hqps/remote build` first.');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`copied web remote -> ${dest}`);
