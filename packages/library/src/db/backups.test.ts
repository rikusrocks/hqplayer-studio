import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import {
  BACKUP_KEEP,
  applyPendingRestore,
  backupDatabaseInWorker,
  backupFileName,
  backupPath,
  checkRestorable,
  inspectDatabaseFile,
  lastRestoreResult,
  listBackups,
  parseBackupFileName,
  pendingRestore,
  pruneBackups,
  requestRestore,
} from './backups';
import { DatabaseTooNewError, MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from './migrations';

const T = 30_000; // Windows CI is slow

let dir: string;
let dataDir: string;
let backupDir: string;
let ctx: LibraryContext | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-backup-'));
  dataDir = join(dir, 'data');
  backupDir = join(dataDir, 'backups');
});

afterEach(() => {
  ctx?.close();
  ctx = null;
  rmSync(dir, { recursive: true, force: true });
});

function open(appVersion = '0.5.0'): LibraryContext {
  ctx?.close();
  ctx = openLibrary(dataDir, join(dataDir, 'artwork'), { appVersion });
  return ctx;
}

function closeCtx(): void {
  ctx?.close();
  ctx = null;
}

/** A database file as an older Studio left it: migrations up to `upTo`, plus one setting. */
function writeOldDatabase(upTo: number, extraIds: number[] = []): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  db.exec(`CREATE TABLE schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  for (const m of MIGRATIONS.filter((m) => m.id <= upTo)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
      m.id,
      m.name,
    );
  }
  for (const id of extraIds) {
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
      id,
      `future migration ${id}`,
    );
  }
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('probe', '\"old\"', 0)",
  ).run();
  db.close();
}

describe('backup file names', () => {
  it('round-trips kind, time, schema and app version', () => {
    const at = Date.UTC(2026, 10, 17, 10, 15, 30, 123);
    const name = backupFileName('pre-migration', at, 5, '0.5.0-rc.1');
    expect(name).toBe('studio-20261117T101530123Z-pre-migration-s5-v0.5.0-rc.1.sqlite');
    expect(parseBackupFileName(name)).toEqual({
      id: name,
      kind: 'pre-migration',
      createdAt: at,
      schemaVersion: 5,
      appVersion: '0.5.0-rc.1',
    });
  });

  it('accepts only its own names as ids (no paths, no other files)', () => {
    for (const bad of ['../studio.sqlite', 'studio.sqlite', 'a/b.sqlite', '..\\x.sqlite', '']) {
      expect(() => backupPath(backupDir, bad)).toThrow();
    }
    const ok = backupFileName('manual', Date.now(), 5, '0.5.0');
    expect(backupPath(backupDir, ok)).toBe(join(backupDir, ok));
  });
});

describe('pre-migration backups and the downgrade guard', () => {
  it(
    'backs up an older database before migrating it, and the backup holds the old data',
    () => {
      writeOldDatabase(4);
      const c = open('0.5.0');
      expect(c.storage?.migrated).toEqual(MIGRATIONS.filter((m) => m.id > 4).map((m) => m.id));
      const backup = c.storage?.preMigrationBackup;
      expect(backup?.kind).toBe('pre-migration');
      expect(backup?.schemaVersion).toBe(4);
      expect(backup?.appVersion).toBe('0.5.0');
      expect(c.settings.get('probe', null)).toBe('old');
      const info = inspectDatabaseFile(join(backupDir, backup!.id));
      expect(info).toEqual({ ok: true, schemaVersion: 4 });
    },
    T,
  );

  it('makes no backup for a new database or one that is already current', () => {
    let c = open();
    expect(c.storage?.preMigrationBackup).toBeNull();
    closeCtx();
    c = open();
    expect(c.storage?.migrated).toEqual([]);
    expect(c.storage?.preMigrationBackup).toBeNull();
    expect(listBackups(backupDir)).toEqual([]);
  });

  it('refuses a database from a newer Studio and leaves it untouched', () => {
    writeOldDatabase(SUPPORTED_SCHEMA_VERSION, [SUPPORTED_SCHEMA_VERSION + 1]);
    let error: unknown;
    try {
      open();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DatabaseTooNewError);
    expect((error as DatabaseTooNewError).dbVersion).toBe(SUPPORTED_SCHEMA_VERSION + 1);
    expect((error as DatabaseTooNewError).supportedVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    // not switched to WAL, nothing added
    const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'delete',
    );
    expect(db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get()).toEqual({
      v: SUPPORTED_SCHEMA_VERSION + 1,
    });
    db.close();
    expect(existsSync(backupDir)).toBe(false);
  });

  it(
    'rolling back: the older app restores the backup made before the upgrade',
    () => {
      // 1. the current app upgrades a database (pre-migration backup s4)
      writeOldDatabase(4);
      const preUpgrade = open('0.5.0').storage!.preMigrationBackup!;
      ctx!.settings.set('probe', 'new');
      closeCtx();
      // 2. pretend a newer app added a migration the current build does not know
      const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
        SUPPORTED_SCHEMA_VERSION + 1,
        'future',
      );
      db.close();
      expect(() => open('0.5.0')).toThrow(DatabaseTooNewError);
      // 3. the compatible backup is offered and restored at the next open
      const compatible = listBackups(backupDir).filter(
        (b) => b.schemaVersion <= SUPPORTED_SCHEMA_VERSION,
      );
      expect(compatible.map((b) => b.id)).toEqual([preUpgrade.id]);
      requestRestore(dataDir, backupDir, preUpgrade.id);
      const c = open('0.5.0');
      expect(c.storage?.restore?.ok).toBe(true);
      expect(c.settings.get('probe', null)).toBe('old');
      // the newer database was kept, not deleted
      const safety = listBackups(backupDir).find(
        (b) => b.id === c.storage?.restore?.safetyBackupId,
      );
      expect(safety?.kind).toBe('pre-restore');
      expect(safety?.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION + 1);
    },
    T,
  );
});

describe('backups while Studio runs', () => {
  it(
    'copies a live WAL database from a worker thread',
    async () => {
      const c = open();
      c.settings.set('probe', 'committed-in-wal');
      const file = await backupDatabaseInWorker(
        join(dataDir, 'studio.sqlite'),
        backupDir,
        'manual',
        '0.5.0',
      );
      expect(file.kind).toBe('manual');
      expect(file.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(listBackups(backupDir).map((b) => b.id)).toEqual([file.id]);
      const copy = new DatabaseSync(join(backupDir, file.id), { readOnly: true });
      expect(copy.prepare("SELECT value FROM app_settings WHERE key = 'probe'").get()).toEqual({
        value: '"committed-in-wal"',
      });
      copy.close();
    },
    T,
  );

  it(
    'reports a failed copy and leaves no partial file behind',
    async () => {
      await expect(
        backupDatabaseInWorker(join(dir, 'missing', 'nope.sqlite'), backupDir, 'manual', '0.5.0'),
      ).rejects.toThrow(/Backup failed/);
      expect(listBackups(backupDir)).toEqual([]);
    },
    T,
  );

  it('keeps a fixed number of backups per kind', () => {
    const base = Date.UTC(2026, 0, 1);
    const make = (kind: 'daily' | 'manual', i: number) =>
      writeFileSync(join(backupDir, backupFileName(kind, base + i * 1000, 5, '0.5.0')), 'x');
    mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 10; i++) make('daily', i);
    for (let i = 0; i < 3; i++) make('manual', i);
    writeFileSync(join(backupDir, 'notes.txt'), 'not a backup');
    const removed = pruneBackups(backupDir);
    expect(removed).toHaveLength(10 - BACKUP_KEEP.daily);
    const left = listBackups(backupDir);
    expect(left.filter((b) => b.kind === 'daily')).toHaveLength(BACKUP_KEEP.daily);
    expect(left.filter((b) => b.kind === 'manual')).toHaveLength(3);
    // the newest daily ones survive
    expect(Math.min(...left.filter((b) => b.kind === 'daily').map((b) => b.createdAt))).toBe(
      base + (10 - BACKUP_KEEP.daily) * 1000,
    );
    expect(existsSync(join(backupDir, 'notes.txt'))).toBe(true);
  });
});

describe('restore', () => {
  it(
    'replaces the data at the next start and keeps the replaced data as a backup',
    async () => {
      const c = open();
      c.settings.set('probe', 'A');
      const a = await backupDatabaseInWorker(
        join(dataDir, 'studio.sqlite'),
        backupDir,
        'manual',
        '0.5.0',
      );
      c.settings.set('probe', 'B');
      requestRestore(dataDir, backupDir, a.id);
      expect(pendingRestore(dataDir)).toBe(a.id);
      closeCtx();

      const after = open();
      expect(after.settings.get('probe', null)).toBe('A');
      expect(pendingRestore(dataDir)).toBeNull();
      const result = after.storage!.restore!;
      expect(result).toMatchObject({ ok: true, backupId: a.id, error: null });
      expect(lastRestoreResult(dataDir)).toEqual(result);
      const safety = new DatabaseSync(join(backupDir, result.safetyBackupId!), { readOnly: true });
      expect(safety.prepare("SELECT value FROM app_settings WHERE key = 'probe'").get()).toEqual({
        value: '"B"',
      });
      safety.close();
      // a second start does not restore again
      closeCtx();
      expect(open().storage?.restore).toBeNull();
    },
    T,
  );

  it('refuses unknown, damaged and newer-schema backups', () => {
    open();
    mkdirSync(backupDir, { recursive: true });
    expect(() => requestRestore(dataDir, backupDir, '../studio.sqlite')).toThrow(/Unknown backup/);
    const missing = backupFileName('manual', Date.now(), 5, '0.5.0');
    expect(() => requestRestore(dataDir, backupDir, missing)).toThrow(/no longer exists/);
    const damaged = backupFileName('manual', Date.now() + 1, 5, '0.5.0');
    writeFileSync(join(backupDir, damaged), 'this is not a database');
    expect(checkRestorable(backupDir, damaged).ok).toBe(false);
    expect(() => requestRestore(dataDir, backupDir, damaged)).toThrow();
    const newer = backupFileName('manual', Date.now() + 2, SUPPORTED_SCHEMA_VERSION + 1, '9.0.0');
    ctx!.db.prepare('VACUUM INTO ?').run(join(backupDir, newer));
    const v = new DatabaseSync(join(backupDir, newer));
    v.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 0)').run(
      SUPPORTED_SCHEMA_VERSION + 1,
      'future',
    );
    v.close();
    expect(() => requestRestore(dataDir, backupDir, newer)).toThrow(/newer version/);
    expect(pendingRestore(dataDir)).toBeNull();
  });

  it('a restore whose backup vanished reports the error once and keeps the current data', () => {
    const c = open();
    c.settings.set('probe', 'current');
    const id = backupFileName('manual', Date.now(), SUPPORTED_SCHEMA_VERSION, '0.5.0');
    mkdirSync(backupDir, { recursive: true });
    c.db.prepare('VACUUM INTO ?').run(join(backupDir, id));
    requestRestore(dataDir, backupDir, id);
    rmSync(join(backupDir, id));
    closeCtx();
    const result = applyPendingRestore(dataDir, backupDir, '0.5.0');
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/no longer exists/);
    const again = open();
    expect(again.storage?.restore).toBeNull();
    expect(again.settings.get('probe', null)).toBe('current');
  });
});
