/**
 * Standalone Studio Core for development on the Mac (mock engine + fictional demo library).
 *
 *   pnpm dev:core                       # watch mode
 *   pnpm demo:reset                     # wipe .data/dev and re-seed the demo library
 *   STUDIO_ADAPTER=live pnpm dev:core   # experimental read-only live adapter (Windows only)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapStudio } from './bootstrap';

const repoRoot = resolve(import.meta.dirname, '../../..');
const args = new Set(process.argv.slice(2));
const env = process.env;

const dataDir = resolve(env.STUDIO_DATA_DIR ?? resolve(repoRoot, '.data/dev'));
const remoteDist = resolve(repoRoot, 'apps/remote/dist');
const desktopDist = resolve(repoRoot, 'apps/desktop/dist/renderer');

const { server, url } = await bootstrapStudio({
  dataDir,
  appVersion: env.npm_package_version ?? '0.1.0-dev',
  adapter:
    env.STUDIO_ADAPTER === 'live' || env.STUDIO_ADAPTER === 'mock' ? env.STUDIO_ADAPTER : undefined,
  port: env.STUDIO_PORT ? Number(env.STUDIO_PORT) : undefined,
  hqplayer: { host: env.HQP_HOST, port: env.HQP_PORT ? Number(env.HQP_PORT) : undefined },
  staticDirs: {
    remote: existsSync(remoteDist) ? remoteDist : undefined,
    desktop: existsSync(desktopDist) ? desktopDist : undefined,
  },
  demo: env.STUDIO_DEMO !== '0',
  resetData: args.has('--reset-demo'),
  logger: env.STUDIO_LOG === '1',
});

console.log(
  `[studio] Core listening on ${url}  (adapter: ${server.engine.adapter.kind}, data: ${dataDir})`,
);
console.log(`[studio] API ${url}/api/v1/health · events ws://${url.slice(7)}/api/v1/events`);

if (args.has('--exit')) {
  await server.close();
  process.exit(0);
}

const shutdown = async () => {
  await server.close();
  server.ctx.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
