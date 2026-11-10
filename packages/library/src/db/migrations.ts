import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Append-only list. Never edit a migration that has shipped; add a new one instead.
 *
 * Data-safety rules encoded in the schema:
 *  - tracks are never deleted by scans (offline != deleted): `available` flips instead;
 *  - playlist_items / queue_items reference tracks with ON DELETE RESTRICT, so a track that is
 *    part of a playlist can never disappear silently.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE library_roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'unc', 'fixture')),
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('online', 'offline', 'unknown')),
  last_scanned_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE artwork_cache (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('embedded', 'folder', 'generated')),
  file_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL DEFAULT ''
);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  album_artist_id TEXT REFERENCES artists(id) ON DELETE SET NULL,
  year INTEGER,
  release_id TEXT,
  artwork_id TEXT REFERENCES artwork_cache(id) ON DELETE SET NULL,
  album_group_key TEXT NOT NULL UNIQUE,
  root_id TEXT REFERENCES library_roots(id) ON DELETE SET NULL,
  folder TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_albums_artist ON albums(album_artist_id);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  root_id TEXT REFERENCES library_roots(id) ON DELETE SET NULL,
  source_path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  relative_dir TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  file_identity TEXT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_artist TEXT NOT NULL,
  album TEXT NOT NULL,
  album_id TEXT REFERENCES albums(id) ON DELETE SET NULL,
  genre TEXT,
  year INTEGER,
  disc_number INTEGER,
  disc_total INTEGER,
  track_number INTEGER,
  track_total INTEGER,
  duration_ms INTEGER,
  sample_rate INTEGER,
  bit_depth INTEGER,
  channels INTEGER,
  codec TEXT,
  container TEXT,
  lossless INTEGER,
  is_dsd INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
  metadata_source TEXT NOT NULL DEFAULT 'tags' CHECK (metadata_source IN ('tags', 'filename', 'fixture')),
  scan_error TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tracks_album ON tracks(album_id, disc_number, track_number);
CREATE INDEX idx_tracks_root_dir ON tracks(root_id, relative_dir);
CREATE INDEX idx_tracks_seen ON tracks(root_id, last_seen_at);

CREATE TABLE track_artists (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'artist',
  PRIMARY KEY (track_id, artist_id, role)
);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX idx_playlist_items ON playlist_items(playlist_id, position);

CREATE TABLE queue_sessions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('album', 'playlist')),
  source_kind TEXT,
  source_id TEXT,
  source_label TEXT,
  current_index INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES queue_sessions(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL
);
CREATE INDEX idx_queue_items ON queue_items(session_id, position);

CREATE TABLE lyrics_cache (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('plain', 'lrc', 'word')),
  content TEXT NOT NULL,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  selected_by_user INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE engine_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at INTEGER NOT NULL,
  adapter TEXT NOT NULL,
  payload TEXT NOT NULL,
  confidence TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'track identity index (move detection)',
    sql: `CREATE INDEX IF NOT EXISTS idx_tracks_identity ON tracks(file_identity, file_name);`,
  },
  {
    id: 3,
    name: 'paired web remote devices',
    // Tokens are never stored: only SHA-256 hashes of the device token and of the artwork-only
    // media key (see packages/core/src/remote/pairing.ts).
    sql: `
CREATE TABLE remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  media_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_address TEXT
);`,
  },
  {
    id: 4,
    name: 'duplicate album copies + online lookup cache',
    // duplicate_of: this album is a copy (e.g. a backup in another folder) of the album shown
    // instead; recomputed after scans. online_lookups caches opt-in MusicBrainz answers.
    sql: `
ALTER TABLE albums ADD COLUMN duplicate_of TEXT REFERENCES albums(id) ON DELETE SET NULL;
CREATE INDEX idx_albums_duplicate ON albums(duplicate_of);
CREATE TABLE online_lookups (
  key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  result TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);`,
  },
];

export function migrate(db: DatabaseSync): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        Date.now(),
      );
      db.exec('COMMIT');
      ran.push(m.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return ran;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}
