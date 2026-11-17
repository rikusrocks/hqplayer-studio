import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupState, LogInfo, SoakStatus } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import {
  backupFileName,
  listBackups,
  openLibrary,
  seedDemoLibrary,
  SUPPORTED_SCHEMA_VERSION,
  type LibraryContext,
} from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapStudio } from './bootstrap';
import { FileLog } from './logging/studio-log';
import { createStudioServer, type StudioServer } from './server';
import { BackupService } from './services/backup-service';

// Windows CI is slow (worker threads, SQLite VACUUM INTO, server start-up).
const T = 60_000;

let dir: string;
let dataDir: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let log: FileLog;

async function api<T = unknown>(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers:
      method === 'GET'
        ? { host: '127.0.0.1:47321' }
        : { host: '127.0.0.1:47321', 'content-type': 'application/json' },
    payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  return { status: res.statusCode, body: res.json() as T };
}

describe('maintenance API (backups, logs, soak test)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hqps-maint-'));
    dataDir = join(dir, 'data');
    ctx = openLibrary(dataDir, undefined, { appVersion: '0.5.0' });
    seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
    log = new FileLog({ dir: join(dir, 'logs'), appVersion: '0.5.0', appRoots: [] });
    adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
    server = await createStudioServer({
      adapter,
      ctx,
      appVersion: '0.5.0',
      port: 0,
      demoMode: true,
      engine: { commandTimeoutMs: 2000 },
      queue: { settleMs: 0 },
      log,
      soak: { dir: join(dir, 'soak') },
    });
    await server.listen();
  }, T);

  afterEach(async () => {
    await server.close();
    adapter.dispose();
    ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }, T);

  it(
    'backs up on request, schedules and cancels a restore, refuses unknown backups',
    async () => {
      const empty = await api<BackupState>('GET', '/maintenance/backups');
      expect(empty.body).toMatchObject({
        available: true,
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        backups: [],
        pendingRestore: null,
      });
      const made = await api<BackupState>('POST', '/maintenance/backups');
      expect(made.status).toBe(200);
      expect(made.body.backups).toHaveLength(1);
      const backup = made.body.backups[0]!;
      expect(backup).toMatchObject({ kind: 'manual', appVersion: '0.5.0', restorable: true });
      expect(backup.id).not.toMatch(/[\\/]/);

      const bad = await api('POST', '/maintenance/backups/restore', { id: '../studio.sqlite' });
      expect(bad.status).toBe(409);
      const missing = backupFileName('manual', Date.now() + 5000, 5, '0.5.0');
      expect((await api('POST', '/maintenance/backups/restore', { id: missing })).status).toBe(409);

      const scheduled = await api<BackupState>('POST', '/maintenance/backups/restore', {
        id: backup.id,
      });
      expect(scheduled.body.pendingRestore).toBe(backup.id);
      const cancelled = await api<BackupState>('POST', '/maintenance/backups/restore/cancel');
      expect(cancelled.body.pendingRestore).toBeNull();
      expect(readFileSync(join(dir, 'logs', 'studio.log'), 'utf8')).toContain(
        'manual backup written',
      );
    },
    T,
  );

  it(
    'logs commands and includes a redacted log summary, database and soak facts in diagnostics',
    async () => {
      const albums = await api<{ items: { id: string }[] }>('GET', '/library/albums?limit=1');
      expect((await api('POST', `/playback/album/${albums.body.items[0]!.id}`, {})).status).toBe(
        200,
      );
      expect((await api('POST', '/engine/transport', { action: 'pause' })).status).toBe(200);
      const logs = await api<LogInfo>('GET', '/maintenance/logs');
      expect(logs.body.enabled).toBe(true);
      expect(logs.body.files.map((f) => f.name)).toContain('studio.log');
      const text = readFileSync(join(dir, 'logs', 'studio.log'), 'utf8');
      expect(text).toContain('[command] replaceQueue ok');
      expect(text).toContain('[command] pause ok');
      expect(text).toContain('[engine] HQPlayer connected');

      const soakStart = await api<SoakStatus>('POST', '/maintenance/soak/start', {
        durationHours: 2,
      });
      expect(soakStart.body.running).toBe(true);
      expect(soakStart.body.stopAt).toBeGreaterThan(Date.now());
      const diag = await api<Record<string, unknown>>('GET', '/engine/diagnostics');
      expect(diag.body).toMatchObject({
        database: { schemaVersion: SUPPORTED_SCHEMA_VERSION, backups: 0 },
        log: { enabled: true, counts: { error: 0 } },
        soak: { running: true },
      });
      const stopped = await api<SoakStatus>('POST', '/maintenance/soak/stop');
      expect(stopped.body.running).toBe(false);
      expect(stopped.body.stopReason).toBe('user');
      expect(existsSync(join(dir, 'soak', stopped.body.reportFile!))).toBe(true);
      expect((await api('POST', '/maintenance/soak/start', { durationHours: 100 })).status).toBe(
        400,
      );
    },
    T,
  );

  it(
    'a soak test still running when Studio closes is saved as "app-quit"',
    async () => {
      await api('POST', '/maintenance/soak/start', {});
      const file = server.soak.snapshot().reportFile!;
      await server.close();
      const report = JSON.parse(readFileSync(join(dir, 'soak', file), 'utf8')) as {
        stopReason: string;
      };
      expect(report.stopReason).toBe('app-quit');
      // afterEach closes again: must be harmless
    },
    T,
  );
});

describe('daily backups', () => {
  let c: LibraryContext;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hqps-daily-'));
    c = openLibrary(join(dir, 'data'), undefined, { appVersion: '0.5.0' });
  });
  afterEach(() => {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    'makes one a day, and waits for a pause in playback (but not forever)',
    async () => {
      let now = Date.now();
      let playing = true;
      const svc = new BackupService(c, {
        appVersion: '0.5.0',
        now: () => now,
        isPlaying: () => playing,
      });
      // none yet: due, but music is playing and nothing is older than 48 h → wait
      expect(await svc.maybeDaily()).not.toBeNull(); // no daily backup at all → age ∞ → made
      expect(await svc.maybeDaily()).toBeNull(); // not due again
      now += 25 * 3600_000;
      expect(await svc.maybeDaily()).toBeNull(); // due, but playing
      playing = false;
      const second = await svc.maybeDaily();
      expect(second?.kind).toBe('daily');
      playing = true;
      now += 49 * 3600_000;
      expect((await svc.maybeDaily())?.kind).toBe('daily'); // overdue: made even while playing
      expect(
        listBackups(join(dir, 'data', 'backups')).filter((b) => b.kind === 'daily'),
      ).toHaveLength(3);
    },
    T,
  );
});

describe('restore across a restart', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hqps-restore-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it(
    'bootstrap applies a requested restore and logs it',
    async () => {
      const dataDir = join(dir, 'data');
      const logDir = join(dir, 'logs');
      const first = await bootstrapStudio({
        dataDir,
        appVersion: '0.5.0',
        port: 0,
        adapter: 'mock',
        demo: false,
        log: new FileLog({ dir: logDir, appVersion: '0.5.0', appRoots: [] }),
        soakDir: join(dir, 'soak'),
      });
      first.ctx.settings.set('probe', 'before');
      const backup = await first.server.backups.create('manual');
      first.ctx.settings.set('probe', 'after');
      first.server.backups.requestRestore(backup.id);
      await first.server.close();
      first.ctx.close();

      const second = await bootstrapStudio({
        dataDir,
        appVersion: '0.5.0',
        port: 0,
        adapter: 'mock',
        demo: false,
        log: new FileLog({ dir: logDir, appVersion: '0.5.0', appRoots: [] }),
        soakDir: join(dir, 'soak'),
      });
      try {
        expect(second.ctx.settings.get('probe', null)).toBe('before');
        const state = second.server.backups.state();
        expect(state.pendingRestore).toBeNull();
        expect(state.lastRestore).toMatchObject({ ok: true, backupId: backup.id });
        expect(state.backups.map((b) => b.kind).sort()).toEqual(['manual', 'pre-restore']);
        expect(readFileSync(join(logDir, 'studio.log'), 'utf8')).toContain(
          'restored a backup at start-up',
        );
      } finally {
        await second.server.close();
        second.ctx.close();
      }
    },
    T,
  );
});
