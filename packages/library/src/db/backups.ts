import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SUPPORTED_SCHEMA_VERSION } from './migrations';

/**
 * Database backups (Phase 5).
 *
 * A backup is a complete, compacted copy of `studio.sqlite` made with `VACUUM INTO` — a consistent
 * snapshot even while the WAL holds uncommitted pages, and never a half-copied file: it is written
 * as `*.partial` and renamed when complete. Everything a backup needs to be listed (kind, time,
 * schema version, app version) is in its file name, so the folder is the whole catalogue.
 *
 * Kinds: `pre-migration` (before an app update changes the schema — the way back to the older
 * version), `daily`, `manual` (Settings → 常规), `pre-restore` (the data that a restore replaced).
 */

export const DB_FILE_NAME = 'studio.sqlite';
export const BACKUP_DIR_NAME = 'backups';
export const BACKUP_KINDS = ['daily', 'pre-migration', 'manual', 'pre-restore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

/** How many backups of each kind are kept (oldest go first). */
export const BACKUP_KEEP: Record<BackupKind, number> = {
  daily: 7,
  'pre-migration': 5,
  manual: 10,
  'pre-restore': 5,
};

export interface BackupFile {
  /** File name; also the id used by the API (validated, never a path). */
  id: string;
  kind: BackupKind;
  createdAt: number;
  /** Schema version of the data inside (0 = unknown). */
  schemaVersion: number;
  /** Studio version that wrote the backup. */
  appVersion: string;
  sizeBytes: number;
}

const NAME_RE =
  /^studio-(\d{8})T(\d{6})(\d{3})Z-(daily|pre-migration|manual|pre-restore)-s(\d{1,6})-v([0-9A-Za-z.+_-]{1,40})\.sqlite$/;

function stamp(ms: number): string {
  // 2026-11-17T10:15:30.123Z → 20261117T101530123Z
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');
}

function safeVersion(v: string): string {
  const clean = v.replace(/[^0-9A-Za-z.+_-]/g, '').slice(0, 40);
  return clean || 'unknown';
}

export function backupFileName(
  kind: BackupKind,
  createdAt: number,
  schemaVersion: number,
  appVersion: string,
): string {
  return `studio-${stamp(createdAt)}-${kind}-s${Math.max(0, Math.trunc(schemaVersion))}-v${safeVersion(appVersion)}.sqlite`;
}

export function parseBackupFileName(name: string): Omit<BackupFile, 'sizeBytes'> | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, day, time, millis, kind, schema, version] = m as unknown as string[];
  const iso = `${day!.slice(0, 4)}-${day!.slice(4, 6)}-${day!.slice(6, 8)}T${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${millis}Z`;
  const createdAt = Date.parse(iso);
  if (!Number.isFinite(createdAt)) return null;
  return {
    id: name,
    kind: kind as BackupKind,
    createdAt,
    schemaVersion: Number(schema),
    appVersion: version!,
  };
}

/** Absolute path of a backup, for an id that came from outside (rejects anything but a name). */
export function backupPath(dir: string, id: string): string {
  if (!parseBackupFileName(id)) throw new Error('Not a backup file name');
  return join(dir, id);
}

/** Backups in `dir`, newest first. Unknown files are ignored. */
export function listBackups(dir: string): BackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    const meta = parseBackupFileName(name);
    if (!meta) continue;
    try {
      out.push({ ...meta, sizeBytes: statSync(join(dir, name)).size });
    } catch {
      // removed meanwhile
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/**
 * Delete the oldest backups beyond `keep` per kind (and copies left half-written by a crash).
 * Returns the removed ids.
 */
export function pruneBackups(
  dir: string,
  keep: Record<BackupKind, number> = BACKUP_KEEP,
  now = Date.now(),
): string[] {
  const removed: string[] = [];
  const seen: Record<string, number> = {};
  for (const b of listBackups(dir)) {
    seen[b.kind] = (seen[b.kind] ?? 0) + 1;
    if ((seen[b.kind] as number) > keep[b.kind]) {
      try {
        rmSync(join(dir, b.id), { force: true });
        rmSync(join(dir, `${b.id}-wal`), { force: true });
        removed.push(b.id);
      } catch {
        // locked (antivirus, an open file manager preview): try again next time
      }
    }
  }
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.partial')) continue;
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > 24 * 3600_000) rmSync(file, { force: true });
    }
  } catch {
    // folder gone
  }
  return removed;
}

/** Schema version of an open database (0 for an empty one). */
export function readSchemaVersion(db: DatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}

function uniqueTarget(dir: string, kind: BackupKind, at: number, schema: number, app: string) {
  let t = at;
  let name = backupFileName(kind, t, schema, app);
  while (existsSync(join(dir, name)) || existsSync(join(dir, `${name}.partial`))) {
    t += 1;
    name = backupFileName(kind, t, schema, app);
  }
  return { name, createdAt: t };
}

function finish(dir: string, name: string, partial: string): BackupFile {
  renameSync(partial, join(dir, name));
  const meta = parseBackupFileName(name) as Omit<BackupFile, 'sizeBytes'>;
  const file: BackupFile = { ...meta, sizeBytes: statSync(join(dir, name)).size };
  pruneBackups(dir);
  return file;
}

/**
 * Back up through an open connection (synchronous — used at start-up, before anything else
 * runs, e.g. right before migrations).
 */
export function backupDatabase(
  db: DatabaseSync,
  dir: string,
  kind: BackupKind,
  appVersion: string,
  now = Date.now(),
): BackupFile {
  mkdirSync(dir, { recursive: true });
  const schema = readSchemaVersion(db);
  const { name } = uniqueTarget(dir, kind, now, schema, appVersion);
  const partial = join(dir, `${name}.partial`);
  try {
    db.prepare('VACUUM INTO ?').run(partial);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  return finish(dir, name, partial);
}

// Runs in a worker thread with its own read-only connection, so a large library never blocks
// the main thread (which carries the HQPlayer connection and the UI's API) while it is copied.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.src, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000');
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const v = t ? (db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get().v || 0) : 0;
  db.prepare('VACUUM INTO ?').run(workerData.dest);
  parentPort.postMessage({ ok: true, schemaVersion: v });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
} finally {
  try { if (db) db.close(); } catch {}
}
`;

/**
 * Back up a database file that is open (in WAL mode) in this process, from a worker thread.
 * The schema version in the name is the one the worker read inside the copied database.
 */
export async function backupDatabaseInWorker(
  dbFile: string,
  dir: string,
  kind: BackupKind,
  appVersion: string,
  now = Date.now(),
): Promise<BackupFile> {
  mkdirSync(dir, { recursive: true });
  // the real schema version is only known after the copy: write to a neutral temp name first
  const temp = join(
    dir,
    `studio-backup-${now}-${process.pid}-${Math.random().toString(36).slice(2)}.partial`,
  );
  const result = await new Promise<{ ok: boolean; schemaVersion?: number; error?: string }>(
    (resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { src: dbFile, dest: temp } });
      } catch (err) {
        resolve({ ok: false, error: (err as Error).message });
        return;
      }
      let done = false;
      worker.once('message', (m: { ok: boolean; schemaVersion?: number; error?: string }) => {
        done = true;
        resolve(m);
      });
      worker.once('error', (err) => {
        if (!done) resolve({ ok: false, error: err.message });
        done = true;
      });
      worker.once('exit', (code) => {
        if (!done) resolve({ ok: false, error: `backup worker exited with code ${code}` });
        done = true;
      });
    },
  );
  if (!result.ok) {
    rmSync(temp, { force: true });
    throw new Error(`Backup failed: ${result.error ?? 'unknown error'}`);
  }
  const { name } = uniqueTarget(dir, kind, now, result.schemaVersion ?? 0, appVersion);
  return finish(dir, name, temp);
}

export type DatabaseInspection = { ok: true; schemaVersion: number } | { ok: false; error: string };

/** Open a database file read-only and check it (quick_check + schema version). */
export function inspectDatabaseFile(file: string): DatabaseInspection {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    const ok = check.length === 1 && check[0]?.quick_check === 'ok';
    if (!ok) return { ok: false, error: 'The backup file is damaged (integrity check failed).' };
    return { ok: true, schemaVersion: readSchemaVersion(db) };
  } catch (err) {
    return { ok: false, error: `The backup file cannot be read: ${(err as Error).message}` };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// ------------------------------------------------------------------ restore (applied at start-up)

const RESTORE_MARKER = 'restore-pending.json';
const RESTORE_RESULT = 'restore-result.json';

export interface RestoreResult {
  ok: boolean;
  /** The backup that was (or should have been) restored. */
  backupId: string;
  at: number;
  /** Where the replaced data went (a `pre-restore` backup), if there was any. */
  safetyBackupId: string | null;
  error: string | null;
}

/** Check a backup can be restored by this build (readable, intact, not from a newer schema). */
export function checkRestorable(backupDir: string, id: string): DatabaseInspection {
  let file: string;
  try {
    file = backupPath(backupDir, id);
  } catch {
    return { ok: false, error: 'Unknown backup.' };
  }
  if (!existsSync(file)) return { ok: false, error: 'The backup file no longer exists.' };
  const info = inspectDatabaseFile(file);
  if (info.ok && info.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This backup was made by a newer version of HQPlayer Studio (database version ${info.schemaVersion}; this version supports up to ${SUPPORTED_SCHEMA_VERSION}).`,
    };
  }
  return info;
}

/**
 * Ask for `id` to be restored the next time Studio starts (the open database cannot be
 * replaced underneath the running app). Throws when the backup cannot be restored.
 */
export function requestRestore(dataDir: string, backupDir: string, id: string, now = Date.now()) {
  const check = checkRestorable(backupDir, id);
  if (!check.ok) throw new Error(check.error);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, RESTORE_MARKER), JSON.stringify({ backupId: id, requestedAt: now }));
}

export function cancelRestore(dataDir: string): void {
  rmSync(join(dataDir, RESTORE_MARKER), { force: true });
}

/** The backup that will be restored at the next start, if any. */
export function pendingRestore(dataDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, RESTORE_MARKER), 'utf8')) as {
      backupId?: unknown;
    };
    return typeof raw.backupId === 'string' ? raw.backupId : null;
  } catch {
    return null;
  }
}

export function lastRestoreResult(dataDir: string): RestoreResult | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, RESTORE_RESULT), 'utf8')) as RestoreResult;
  } catch {
    return null;
  }
}

/** Remove the database and its WAL / shared-memory files. */
function removeDatabaseFiles(dbFile: string): void {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`]) {
    rmSync(f, { force: true });
  }
}

/** Keep what is about to be replaced, even a database from a newer app or a damaged one. */
function safetyCopy(dbFile: string, backupDir: string, appVersion: string, now: number): string {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile);
    return backupDatabase(db, backupDir, 'pre-restore', appVersion, now).id;
  } catch {
    // damaged beyond VACUUM: keep the raw file (and its WAL) instead
    const { name } = uniqueTarget(backupDir, 'pre-restore', now, 0, appVersion);
    copyFileSync(dbFile, join(backupDir, name));
    if (existsSync(`${dbFile}-wal`)) copyFileSync(`${dbFile}-wal`, join(backupDir, `${name}-wal`));
    return name;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Called before the database is opened: if a restore was requested, keep the current data as a
 * `pre-restore` backup, then put the backup in its place. The request is consumed either way,
 * so a failing restore cannot repeat on every start; the outcome is kept for Settings.
 */
export function applyPendingRestore(
  dataDir: string,
  backupDir: string,
  appVersion: string,
  now = Date.now(),
): RestoreResult | null {
  const id = pendingRestore(dataDir);
  if (!id) {
    if (existsSync(join(dataDir, RESTORE_MARKER))) cancelRestore(dataDir); // unreadable marker
    return null;
  }
  cancelRestore(dataDir);
  const dbFile = join(dataDir, DB_FILE_NAME);
  const result: RestoreResult = {
    ok: false,
    backupId: id,
    at: now,
    safetyBackupId: null,
    error: null,
  };
  try {
    const check = checkRestorable(backupDir, id);
    if (!check.ok) throw new Error(check.error);
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(dbFile)) result.safetyBackupId = safetyCopy(dbFile, backupDir, appVersion, now);
    const partial = `${dbFile}.restore-partial`;
    copyFileSync(backupPath(backupDir, id), partial);
    removeDatabaseFiles(dbFile);
    renameSync(partial, dbFile);
    result.ok = true;
  } catch (err) {
    result.error = (err as Error).message;
  }
  writeFileSync(join(dataDir, RESTORE_RESULT), JSON.stringify(result));
  return result;
}
