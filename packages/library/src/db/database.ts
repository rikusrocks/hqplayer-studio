import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations';

export type Database = DatabaseSync;
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface OpenDatabaseOptions {
  /** Skip running migrations (tests that exercise migrate() directly). */
  skipMigrations?: boolean;
}

/**
 * Open (and migrate) the Studio database. Uses Node's built-in `node:sqlite` — available in
 * Node ≥ 22.13 and in Electron 45 (verified 2026-11-10: Electron 45.2.3 ships SQLite 3.53 with
 * FTS5) — so there is no native addon to rebuild for Electron/Windows.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (!options.skipMigrations) migrate(db);
  cacheStatements(db);
  return db;
}

/**
 * Repositories call `db.prepare(sql)` inline; compiling the same SQL on every call cost ~40 % of
 * a library scan. Keep the most recent statements (node:sqlite statements reset on every run, and
 * nothing here holds an `.iterate()` cursor open, so reuse is safe).
 */
function cacheStatements(db: Database, max = 256): void {
  const compile = db.prepare.bind(db);
  const cache = new Map<string, ReturnType<Database['prepare']>>();
  db.prepare = ((source: string) => {
    let stmt = cache.get(source);
    if (stmt) {
      cache.delete(source); // refresh LRU position
    } else {
      stmt = compile(source);
      if (cache.size >= max) cache.delete(cache.keys().next().value as string);
    }
    cache.set(source, stmt);
    return stmt;
  }) as Database['prepare'];
}

const depth = new WeakMap<Database, number>();

/**
 * Run `fn` atomically. Nested calls use SAVEPOINTs so repositories can compose.
 * `fn` must be synchronous (node:sqlite is synchronous).
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const sp = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

/** Convert JS values to something node:sqlite accepts (no booleans / undefined). */
export function sql(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
