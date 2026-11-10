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
} from './settings-keys';
import { createStudioServer, DEFAULT_PORT, type StudioServer } from './server';

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
  const ctx = openLibrary(opts.dataDir, join(opts.dataDir, 'artwork'));
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
          policy: { controlEnabled: ctx.settings.get<boolean>(ENGINE_CONTROL_SETTING, false) },
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
  });
  const { url, port } = await server.listen();
  return { server, ctx, url, port };
}
