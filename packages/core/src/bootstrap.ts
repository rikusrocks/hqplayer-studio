import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  LiveHQPlayerAdapter,
  MockHQPlayerAdapter,
  type HQPlayerAdapter,
} from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import {
  DEMO_REMOVED_SETTING,
  ENGINE_ADAPTER_SETTING,
  ENGINE_CONTROL_SETTING,
  ENGINE_DSP_SETTING,
} from './settings-keys';
import { createStudioServer, DEFAULT_PORT, type StudioServer } from './server';
import type { StudioLog } from './logging/studio-log';

export { ENGINE_ADAPTER_SETTING };

export interface BootstrapOptions {
  dataDir: string;
  appVersion: string;
  /** Force an adapter (launch flag / env). Omit to use the saved preference. */
  adapter?: 'mock' | 'live';
  port?: number;
  hqplayer?: { host?: string; port?: number };
  staticDirs?: { desktop?: string; remote?: string };
  /** Seed the fictional demo library when the database has no library roots. */
  demo?: boolean;
  resetData?: boolean;
  logger?: boolean;
  /** Local log shared with the caller (Electron main writes to the same file). */
  log?: StudioLog;
  /** Where soak-test reports go. Default `<dataDir>/../soak-reports`. */
  soakDir?: string;
}

export interface Bootstrapped {
  server: StudioServer;
  ctx: LibraryContext;
  url: string;
  port: number;
}

/**
 * Shared start-up path for the standalone dev server (`pnpm dev:core`) and the Electron main
 * process: open DB → (seed demo) → create adapter → start HTTP/WS server on loopback.
 */
export async function bootstrapStudio(opts: BootstrapOptions): Promise<Bootstrapped> {
  if (opts.resetData) rmSync(opts.dataDir, { recursive: true, force: true });
  const log = opts.log;
  // Applies a restore requested before the restart, backs up before migrations, and refuses a
  // database written by a newer Studio (DatabaseTooNewError — the caller offers a backup).
  const ctx = openLibrary(opts.dataDir, join(opts.dataDir, 'artwork'), {
    appVersion: opts.appVersion,
  });
  const storage = ctx.storage;
  if (log && storage) {
    if (storage.restore) {
      if (storage.restore.ok) {
        log.warn('backup', 'restored a backup at start-up', {
          backup: storage.restore.backupId,
          replacedDataKeptAs: storage.restore.safetyBackupId ?? undefined,
        });
      } else {
        log.error('backup', 'restore failed; the current data was kept', {
          backup: storage.restore.backupId,
          error: storage.restore.error ?? undefined,
        });
      }
    }
    if (storage.migrated.length > 0) {
      log.info('database', 'migrated', {
        to: storage.schemaVersion,
        ran: storage.migrated.join(','),
        backup: storage.preMigrationBackup?.id,
      });
    }
  }
  const demo = opts.demo ?? true;
  if (
    demo &&
    ctx.library.listRoots().length === 0 &&
    !ctx.settings.get<boolean>(DEMO_REMOVED_SETTING, false)
  ) {
    seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
  }
  // Precedence: explicit override (CLI flag / env) > saved preference > mock.
  const saved = ctx.settings.get<'mock' | 'live' | null>(ENGINE_ADAPTER_SETTING, null);
  const kind = opts.adapter ?? saved ?? 'mock';
  const source = opts.adapter ? 'override' : saved ? 'setting' : 'default';
  const hqplayer = { host: opts.hqplayer?.host ?? '127.0.0.1', port: opts.hqplayer?.port ?? 4321 };
  const adapter: HQPlayerAdapter =
    kind === 'live'
      ? new LiveHQPlayerAdapter({
          ...hqplayer,
          policy: {
            controlEnabled: ctx.settings.get<boolean>(ENGINE_CONTROL_SETTING, false),
            dspEnabled: ctx.settings.get<boolean>(ENGINE_DSP_SETTING, false),
          },
        })
      : new MockHQPlayerAdapter();
  const server = await createStudioServer({
    adapter,
    ctx,
    appVersion: opts.appVersion,
    port: opts.port ?? DEFAULT_PORT,
    staticDirs: opts.staticDirs,
    demoMode: demo,
    engineInfo: { source, hqplayer },
    logger: opts.logger,
    log,
    soak: { dir: opts.soakDir ?? join(opts.dataDir, '..', 'soak-reports') },
  });
  log?.info('startup', 'Studio Core started', {
    version: opts.appVersion,
    adapter: kind,
    adapterSource: source,
    schema: storage?.schemaVersion,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    electron: process.versions.electron,
  });
  const { url, port } = await server.listen();
  return { server, ctx, url, port };
}
