/**
 * Standalone Studio Core for development on the Mac (mock engine + fictional demo library).
 *
 *   pnpm dev:core                       # watch mode
 *   pnpm demo:reset                     # wipe .data/dev and re-seed the demo library
 *   STUDIO_ADAPTER=live pnpm dev:core   # experimental read-only live adapter (Windows only)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseTooNewError, listBackups, SUPPORTED_SCHEMA_VERSION } from '@hqps/library';
import { bootstrapStudio } from './bootstrap';
import { installCrashHandlers } from './logging/crash-handlers';
import { FileLog } from './logging/studio-log';

const repoRoot = resolve(import.meta.dirname, '../../..');
const args = new Set(process.argv.slice(2));
const env = process.env;

const dataDir = resolve(env.STUDIO_DATA_DIR ?? resolve(repoRoot, '.data/dev'));
const remoteDist = resolve(repoRoot, 'apps/remote/dist');
const desktopDist = resolve(repoRoot, 'apps/desktop/dist/renderer');

const appVersion = env.npm_package_version ?? '0.1.0-dev';
// Local log + crash reports next to the dev data (same privacy filter as the desktop app).
const log = new FileLog({
  dir: resolve(dataDir, 'logs'),
  appVersion,
  appRoots: [repoRoot],
  echo: env.STUDIO_LOG === '1',
});
log.startSession();
installCrashHandlers(log, {
  onUncaught: (err) => {
    console.error('[studio] uncaught exception (crash report written to the log folder):', err);
    log.endSession();
    process.exit(1);
  },
});

let started: Awaited<ReturnType<typeof bootstrapStudio>>;
try {
  started = await bootstrapStudio({
    dataDir,
    appVersion,
    adapter:
      env.STUDIO_ADAPTER === 'live' || env.STUDIO_ADAPTER === 'mock'
        ? env.STUDIO_ADAPTER
        : undefined,
    port: env.STUDIO_PORT ? Number(env.STUDIO_PORT) : undefined,
    hqplayer: { host: env.HQP_HOST, port: env.HQP_PORT ? Number(env.HQP_PORT) : undefined },
    staticDirs: {
      remote: existsSync(remoteDist) ? remoteDist : undefined,
      desktop: existsSync(desktopDist) ? desktopDist : undefined,
    },
    demo: env.STUDIO_DEMO !== '0',
    resetData: args.has('--reset-demo'),
    logger: env.STUDIO_LOG === '1',
    log,
    soakDir: resolve(dataDir, 'soak-reports'),
  });
} catch (err) {
  if (err instanceof DatabaseTooNewError) {
    const usable = listBackups(resolve(dataDir, 'backups')).filter(
      (b) => b.schemaVersion <= SUPPORTED_SCHEMA_VERSION,
    );
    console.error(`[studio] ${err.message}`);
    console.error(
      usable.length
        ? `[studio] Backups this version can use (newest first):\n${usable.map((b) => `  ${b.id}`).join('\n')}`
        : '[studio] No backup this version can use was found.',
    );
  } else {
    log.crash('core-start-failed', { error: err });
  }
  log.endSession();
  process.exit(1);
}
const { server, url } = started;

console.log(
  `[studio] Core listening on ${url}  (adapter: ${server.engine.adapter.kind}, data: ${dataDir})`,
);
console.log(`[studio] API ${url}/api/v1/health · events ws://${url.slice(7)}/api/v1/events`);

if (args.has('--exit')) {
  await server.close();
  log.endSession();
  process.exit(0);
}

const shutdown = async () => {
  await server.close();
  server.ctx.close();
  log.endSession();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
