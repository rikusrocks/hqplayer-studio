import type { BackupInfo, BackupState } from '@hqps/contracts';
import {
  SUPPORTED_SCHEMA_VERSION,
  backupDatabaseInWorker,
  cancelRestore,
  lastRestoreResult,
  listBackups,
  pendingRestore,
  requestRestore,
  schemaVersion,
  type BackupFile,
  type BackupKind,
  type LibraryContext,
} from '@hqps/library';
import { HttpError } from '../http/errors';
import type { StudioLog } from '../logging/studio-log';

export interface BackupServiceOptions {
  appVersion: string;
  log?: StudioLog;
  /** Is HQPlayer playing right now? Daily backups wait for a pause (up to `maxDeferMs`). */
  isPlaying?: () => boolean;
  /** A daily backup is due when the newest is older than this. Default 24 h. */
  dailyEveryMs?: number;
  /** …and is made even during playback once the newest is older than this. Default 48 h. */
  maxDeferMs?: number;
  /** First check after start, then every `checkEveryMs`. */
  firstCheckMs?: number;
  checkEveryMs?: number;
  now?: () => number;
}

/**
 * Database backups while Studio runs (the pre-migration backup and restores happen when the
 * database is opened, see `openLibrary`): a daily backup, "back up now", and asking for a
 * restore at the next start. Backups are written by a worker thread with its own connection, so
 * the main thread (HQPlayer connection, UI API) is never blocked by a large library.
 */
export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<BackupFile> | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(
    private readonly ctx: LibraryContext,
    private readonly opts: BackupServiceOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  get available(): boolean {
    return this.ctx.storage !== null;
  }

  start(): void {
    if (!this.available || this.timer) return;
    this.firstTimer = setTimeout(() => void this.maybeDaily(), this.opts.firstCheckMs ?? 120_000);
    this.timer = setInterval(() => void this.maybeDaily(), this.opts.checkEveryMs ?? 3600_000);
    this.firstTimer.unref?.();
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  state(): BackupState {
    const storage = this.ctx.storage;
    if (!storage) {
      return {
        available: false,
        schemaVersion: 0,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        backups: [],
        pendingRestore: null,
        lastRestore: null,
        lastDailyAt: null,
        running: false,
        lastError: null,
      };
    }
    const backups = listBackups(storage.backupDir);
    return {
      available: true,
      schemaVersion: schemaVersion(this.ctx.db),
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      backups: backups.map(toInfo),
      pendingRestore: pendingRestore(storage.dataDir),
      lastRestore: lastRestoreResult(storage.dataDir),
      lastDailyAt: backups.find((b) => b.kind === 'daily')?.createdAt ?? null,
      running: this.running !== null,
      lastError: this.lastError,
    };
  }

  /** Make a backup now (one at a time; a second request waits for the first). */
  async create(kind: BackupKind = 'manual'): Promise<BackupFile> {
    const storage = this.ctx.storage;
    if (!storage) {
      throw new HttpError(409, 'conflict', 'Backups are not available for this database');
    }
    if (this.running) await this.running.catch(() => undefined);
    const started = this.now();
    const job = backupDatabaseInWorker(
      storage.dbFile,
      storage.backupDir,
      kind,
      this.opts.appVersion,
      started,
    );
    this.running = job;
    try {
      const file = await job;
      this.lastError = null;
      this.opts.log?.info('backup', `${kind} backup written`, {
        schema: file.schemaVersion,
        sizeKB: Math.round(file.sizeBytes / 1024),
        ms: this.now() - started,
      });
      return file;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.opts.log?.error('backup', `${kind} backup failed`, { error: this.lastError });
      throw err;
    } finally {
      if (this.running === job) this.running = null;
    }
  }

  /** Daily backup if due; waits for a pause in playback for up to `maxDeferMs`. */
  async maybeDaily(): Promise<BackupFile | null> {
    const storage = this.ctx.storage;
    if (!storage || this.running) return null;
    const now = this.now();
    const newest = listBackups(storage.backupDir).find((b) => b.kind === 'daily');
    const age = newest ? now - newest.createdAt : Infinity;
    if (age < (this.opts.dailyEveryMs ?? 24 * 3600_000)) return null;
    if (this.opts.isPlaying?.() && age < (this.opts.maxDeferMs ?? 48 * 3600_000)) return null;
    try {
      return await this.create('daily');
    } catch {
      return null; // logged; retried at the next check
    }
  }

  requestRestore(id: string): BackupState {
    const storage = this.ctx.storage;
    if (!storage) {
      throw new HttpError(409, 'conflict', 'Backups are not available for this database');
    }
    try {
      requestRestore(storage.dataDir, storage.backupDir, id, this.now());
    } catch (err) {
      throw new HttpError(409, 'conflict', (err as Error).message);
    }
    this.opts.log?.warn('backup', 'restore requested for the next start', {
      backup: id,
    });
    return this.state();
  }

  cancelRestore(): BackupState {
    const storage = this.ctx.storage;
    if (storage) cancelRestore(storage.dataDir);
    return this.state();
  }
}

function toInfo(b: BackupFile): BackupInfo {
  return { ...b, restorable: b.schemaVersion <= SUPPORTED_SCHEMA_VERSION };
}
