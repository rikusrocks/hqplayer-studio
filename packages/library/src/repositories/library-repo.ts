import { isAbsolute, win32 } from 'node:path';
import type {
  AlbumDetail,
  AlbumSort,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  FolderEntry,
  FolderListing,
  LibraryRoot,
  LibraryStats,
  Page,
  Track,
} from '@hqps/contracts';
import { likePattern, sql, transaction, type Database, type SqlValue } from '../db/database';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import {
  albumGroupKey,
  buildSearchText,
  engineUriToPath,
  hostPlatform,
  normalizeText,
  pathKey,
  searchTokens,
  splitArtists,
  stableId,
  type PathPlatform,
} from '../normalize';
import {
  TRACK_SELECT,
  rowToAlbum,
  rowToRoot,
  rowToTrack,
  type AlbumAggRow,
  type RootRow,
  type TrackRow,
} from './rows';

export interface TrackUpsert {
  rootId: string | null;
  sourcePath: string;
  pathKey: string;
  relativeDir: string;
  fileName: string;
  fileIdentity: string | null;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  albumId: string | null;
  genre: string | null;
  year: number | null;
  discNumber: number | null;
  discTotal: number | null;
  trackNumber: number | null;
  trackTotal: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  lossless: boolean | null;
  isDsd: boolean;
  bitrate: number | null;
  mtimeMs: number | null;
  sizeBytes: number | null;
  metadataSource: 'tags' | 'filename' | 'fixture';
  scanError: string | null;
  seenAt: number;
}

export interface EnsureAlbumInput {
  title: string;
  albumArtist: string;
  year: number | null;
  releaseId: string | null;
  rootId: string | null;
  folder: string;
  genre?: string | null;
  now: number;
}

export interface ListQuery {
  q?: string;
  offset?: number;
  limit?: number;
  sort?: AlbumSort;
  artistId?: string;
}

/** Playable source info for the engine — internal only, never returned to remote clients. */
export interface TrackSource {
  id: string;
  sourcePath: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  isDsd: boolean;
  available: boolean;
  /** Belongs to the fictional demo library — its files do not exist. */
  isFixture: boolean;
}

const ALBUM_AGG = `
SELECT al.id, al.title, al.album_artist, al.album_artist_id, al.year, al.artwork_id, al.folder, al.created_at,
  COUNT(t.id) AS track_count,
  COUNT(DISTINCT COALESCE(t.disc_number, 1)) AS disc_count,
  SUM(t.duration_ms) AS duration_ms,
  MAX(t.available) AS available,
  MAX(t.sample_rate) AS sample_rate,
  MAX(t.bit_depth) AS bit_depth,
  MAX(t.is_dsd) AS is_dsd,
  MAX(t.codec) AS codec,
  MAX(t.container) AS container,
  MAX(t.bitrate) AS bitrate,
  MAX(t.genre) AS genre
FROM albums al JOIN tracks t ON t.album_id = al.id`;

const ALBUM_ORDER: Record<AlbumSort, string> = {
  artist: 'al.album_artist COLLATE NOCASE, al.year, al.title COLLATE NOCASE',
  title: 'al.title COLLATE NOCASE, al.album_artist COLLATE NOCASE',
  year: 'al.year IS NULL, al.year DESC, al.title COLLATE NOCASE',
  added: 'al.created_at DESC, al.title COLLATE NOCASE',
};

function clampPage(q: ListQuery): { offset: number; limit: number } {
  return {
    offset: Math.max(0, Math.floor(q.offset ?? 0)),
    limit: Math.min(500, Math.max(1, Math.floor(q.limit ?? 100))),
  };
}

function tokenWhere(column: string, q: string | undefined): { clause: string; params: SqlValue[] } {
  const tokens = searchTokens(q);
  return {
    clause: tokens.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' AND '),
    params: tokens.map(likePattern),
  };
}

function rootNameFor(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export class LibraryRepository {
  constructor(
    private readonly db: Database,
    private readonly platform: PathPlatform = hostPlatform(),
  ) {}

  // --- roots ----------------------------------------------------------------------------------

  listRoots(): LibraryRoot[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM tracks t WHERE t.root_id = r.id) AS track_count
         FROM library_roots r ORDER BY r.created_at`,
      )
      .all() as unknown as RootRow[];
    return rows.map(rowToRoot);
  }

  getRootRow(id: string): RootRow {
    const row = this.db.prepare('SELECT * FROM library_roots WHERE id = ?').get(id) as
      RootRow | undefined;
    if (!row) throw new NotFoundError('Library root', id);
    return row;
  }

  addRoot(
    path: string,
    options: { kind?: 'local' | 'unc' | 'fixture'; name?: string; now?: number } = {},
  ): LibraryRoot {
    const trimmed = path.trim();
    const isUnc = trimmed.startsWith('\\\\');
    const absolute =
      options.kind === 'fixture' ||
      isUnc ||
      (this.platform === 'win32' ? win32.isAbsolute(trimmed) : isAbsolute(trimmed));
    if (!absolute) throw new ValidationError('Library folder must be an absolute path');
    const key = pathKey(trimmed, isUnc ? 'win32' : this.platform);
    const existing = this.db.prepare('SELECT id FROM library_roots WHERE path_key = ?').get(key) as
      { id: string } | undefined;
    if (existing)
      throw new ConflictError('This folder is already in the library', { rootId: existing.id });
    const id = stableId('root', key);
    const kind = options.kind ?? (isUnc ? 'unc' : 'local');
    this.db
      .prepare(
        `INSERT INTO library_roots (id, path, path_key, name, kind, enabled, status, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        trimmed,
        key,
        options.name ?? rootNameFor(trimmed),
        kind,
        kind === 'fixture' ? 'online' : 'unknown',
        options.now ?? Date.now(),
      );
    return this.listRoots().find((r) => r.id === id) as LibraryRoot;
  }

  setRootStatus(
    id: string,
    status: 'online' | 'offline' | 'unknown',
    error: string | null,
    scannedAt?: number,
  ): void {
    this.db
      .prepare(
        `UPDATE library_roots SET status = ?, last_error = ?, last_scanned_at = COALESCE(?, last_scanned_at) WHERE id = ?`,
      )
      .run(status, error, sql(scannedAt), id);
  }

  // --- artists / albums -----------------------------------------------------------------------

  ensureArtist(name: string): string {
    const key = normalizeText(name) || name.trim().toLowerCase() || 'unknown';
    const id = stableId('ar', key);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO artists (id, name, name_key, search_text) VALUES (?, ?, ?, ?)',
      )
      .run(id, name.trim() || 'Unknown Artist', key, buildSearchText(name));
    return id;
  }

  ensureAlbum(input: EnsureAlbumInput): string {
    const key = albumGroupKey(
      input.albumArtist,
      input.title,
      input.rootId,
      input.folder,
      input.releaseId,
    );
    const id = stableId('al', key);
    const artistId = this.ensureArtist(input.albumArtist);
    this.db
      .prepare(
        `INSERT INTO albums (id, title, album_artist, album_artist_id, year, release_id, album_group_key, root_id, folder, search_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           year = COALESCE(albums.year, excluded.year),
           search_text = excluded.search_text,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.title,
        input.albumArtist,
        artistId,
        sql(input.year),
        sql(input.releaseId),
        key,
        sql(input.rootId),
        input.folder,
        buildSearchText(input.title, input.albumArtist, input.year, input.genre),
        input.now,
        input.now,
      );
    return id;
  }

  setAlbumArtwork(albumId: string, artworkId: string): void {
    this.db.prepare('UPDATE albums SET artwork_id = ? WHERE id = ?').run(artworkId, albumId);
  }

  /** Albums under a root without artwork, with one representative track path. */
  albumsMissingArtwork(
    rootId: string,
  ): { albumId: string; sourcePath: string; folderPath: string }[] {
    const rows = this.db
      .prepare(
        `SELECT al.id AS album_id, MIN(t.source_path) AS source_path
         FROM albums al JOIN tracks t ON t.album_id = al.id
         WHERE al.root_id = ? AND al.artwork_id IS NULL AND t.available = 1
         GROUP BY al.id`,
      )
      .all(rootId) as { album_id: string; source_path: string }[];
    return rows.map((r) => ({
      albumId: r.album_id,
      sourcePath: r.source_path,
      folderPath: r.source_path.replace(/[\\/][^\\/]*$/, ''),
    }));
  }

  // --- tracks ---------------------------------------------------------------------------------

  findTrackByPathKey(
    key: string,
  ):
    | { id: string; mtime_ms: number | null; size_bytes: number | null; available: number }
    | undefined {
    return this.db
      .prepare('SELECT id, mtime_ms, size_bytes, available FROM tracks WHERE path_key = ?')
      .get(key) as
      | { id: string; mtime_ms: number | null; size_bytes: number | null; available: number }
      | undefined;
  }

  /** Insert or update by path identity. Returns the stable track id and whether it was new. */
  upsertTrack(t: TrackUpsert): { id: string; created: boolean } {
    return transaction(this.db, () => {
      const existing = this.findTrackByPathKey(t.pathKey);
      const id = existing?.id ?? stableId('t', t.pathKey);
      const searchText = buildSearchText(
        t.title,
        t.artist,
        t.album,
        t.albumArtist,
        t.genre,
        t.fileName,
      );
      this.db
        .prepare(
          `INSERT INTO tracks (
             id, root_id, source_path, path_key, relative_dir, file_name, file_identity, title, artist, album_artist, album, album_id,
             genre, year, disc_number, disc_total, track_number, track_total, duration_ms, sample_rate, bit_depth, channels,
             codec, container, lossless, is_dsd, bitrate, mtime_ms, size_bytes, available, last_seen_at, metadata_source,
             scan_error, search_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path_key) DO UPDATE SET
             root_id = excluded.root_id, source_path = excluded.source_path, relative_dir = excluded.relative_dir,
             file_name = excluded.file_name, file_identity = excluded.file_identity, title = excluded.title,
             artist = excluded.artist, album_artist = excluded.album_artist, album = excluded.album, album_id = excluded.album_id,
             genre = excluded.genre, year = excluded.year, disc_number = excluded.disc_number, disc_total = excluded.disc_total,
             track_number = excluded.track_number, track_total = excluded.track_total, duration_ms = excluded.duration_ms,
             sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth, channels = excluded.channels,
             codec = excluded.codec, container = excluded.container, lossless = excluded.lossless, is_dsd = excluded.is_dsd,
             bitrate = excluded.bitrate, mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes, available = 1,
             last_seen_at = excluded.last_seen_at, metadata_source = excluded.metadata_source, scan_error = excluded.scan_error,
             search_text = excluded.search_text, updated_at = excluded.updated_at`,
        )
        .run(
          id,
          sql(t.rootId),
          t.sourcePath,
          t.pathKey,
          t.relativeDir,
          t.fileName,
          sql(t.fileIdentity),
          t.title,
          t.artist,
          t.albumArtist,
          t.album,
          sql(t.albumId),
          sql(t.genre),
          sql(t.year),
          sql(t.discNumber),
          sql(t.discTotal),
          sql(t.trackNumber),
          sql(t.trackTotal),
          sql(t.durationMs),
          sql(t.sampleRate),
          sql(t.bitDepth),
          sql(t.channels),
          sql(t.codec),
          sql(t.container),
          sql(t.lossless),
          sql(t.isDsd),
          sql(t.bitrate),
          sql(t.mtimeMs),
          sql(t.sizeBytes),
          t.seenAt,
          t.metadataSource,
          sql(t.scanError),
          searchText,
          t.seenAt,
          t.seenAt,
        );
      this.db.prepare('DELETE FROM track_artists WHERE track_id = ?').run(id);
      const link = this.db.prepare(
        'INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, ?)',
      );
      for (const name of splitArtists(t.artist)) link.run(id, this.ensureArtist(name), 'artist');
      return { id, created: !existing };
    });
  }

  /** Unchanged file seen again during a scan: just refresh availability. */
  touchTrack(id: string, seenAt: number): void {
    this.db
      .prepare('UPDATE tracks SET available = 1, last_seen_at = ? WHERE id = ?')
      .run(seenAt, id);
  }

  /** After a *completed* scan: files not seen become unavailable (never deleted). */
  markUnseenUnavailable(rootId: string, scanStartedAt: number): number {
    const res = this.db
      .prepare(
        `UPDATE tracks SET available = 0, updated_at = ? WHERE root_id = ? AND available = 1 AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .run(Date.now(), rootId, scanStartedAt);
    return Number(res.changes);
  }

  setRootTracksAvailable(rootId: string, available: boolean): number {
    const res = this.db
      .prepare('UPDATE tracks SET available = ? WHERE root_id = ? AND available != ?')
      .run(available ? 1 : 0, rootId, available ? 1 : 0);
    return Number(res.changes);
  }

  getTrack(id: string): Track {
    const row = this.db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as TrackRow | undefined;
    if (!row) throw new NotFoundError('Track', id);
    return rowToTrack(row);
  }

  /** Tracks by id, in the requested order. Throws if any id is unknown. */
  getTracks(ids: readonly string[]): Track[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const map = new Map<string, Track>();
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = this.db
        .prepare(`${TRACK_SELECT} WHERE t.id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as unknown as TrackRow[];
      for (const r of rows) map.set(r.id, rowToTrack(r));
    }
    const missing = unique.filter((id) => !map.has(id));
    if (missing.length) throw new NotFoundError('Track', missing.join(', '), { missing });
    return ids.map((id) => map.get(id) as Track);
  }

  getTrackSources(ids: readonly string[]): TrackSource[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const rows = this.db
      .prepare(
        `SELECT t.id, t.source_path, t.title, t.artist, t.album, t.duration_ms, t.sample_rate, t.bit_depth, t.channels, t.is_dsd, t.available,
                (r.kind = 'fixture' OR t.metadata_source = 'fixture') AS is_fixture
         FROM tracks t LEFT JOIN library_roots r ON r.id = t.root_id
         WHERE t.id IN (${unique.map(() => '?').join(',')})`,
      )
      .all(...unique) as {
      id: string;
      source_path: string;
      title: string;
      artist: string;
      album: string;
      duration_ms: number | null;
      sample_rate: number | null;
      bit_depth: number | null;
      channels: number | null;
      is_dsd: number;
      available: number;
      is_fixture: number | null;
    }[];
    const map = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const r = map.get(id);
      if (!r) throw new NotFoundError('Track', id);
      return {
        id: r.id,
        sourcePath: r.source_path,
        title: r.title,
        artist: r.artist,
        album: r.album,
        durationMs: r.duration_ms,
        sampleRate: r.sample_rate,
        bitDepth: r.bit_depth,
        channels: r.channels,
        isDsd: r.is_dsd === 1,
        available: r.available === 1,
        isFixture: r.is_fixture === 1,
      };
    });
  }

  /** Match an engine-reported URI/path back to a library track. */
  findTrackIdBySource(uriOrPath: string): string | null {
    const p = engineUriToPath(uriOrPath);
    if (!p) return null;
    const looksWindows = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
    const key = pathKey(p, looksWindows ? 'win32' : this.platform);
    const row = this.db.prepare('SELECT id FROM tracks WHERE path_key = ?').get(key) as
      { id: string } | undefined;
    return row?.id ?? null;
  }

  listTracks(q: ListQuery = {}): Page<Track> {
    const { offset, limit } = clampPage(q);
    const w = tokenWhere('t.search_text', q.q);
    const conds = [w.clause];
    const params: SqlValue[] = [...w.params];
    if (q.artistId) {
      // album-artist albums + tracks credited to the artist (e.g. on compilations)
      conds.push(
        '(t.album_id IN (SELECT id FROM albums WHERE album_artist_id = ?) OR t.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?))',
      );
      params.push(q.artistId, q.artistId);
    }
    const where = conds.filter(Boolean).length
      ? `WHERE ${conds.filter(Boolean).join(' AND ')}`
      : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM tracks t ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `${TRACK_SELECT} ${where}
         ORDER BY t.album_artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_number, t.track_number, t.file_name
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as TrackRow[];
    return { items: rows.map(rowToTrack), total, offset, limit };
  }

  // --- albums & artists queries --------------------------------------------------------------

  listAlbums(q: ListQuery = {}): Page<AlbumSummary> {
    const { offset, limit } = clampPage(q);
    const w = tokenWhere('al.search_text', q.q);
    const conds = [w.clause, q.artistId ? 'al.album_artist_id = ?' : ''].filter(Boolean);
    const params: SqlValue[] = [...w.params, ...(q.artistId ? [q.artistId] : [])];
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM albums al ${where ? `${where} AND` : 'WHERE'} EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)`,
        )
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `${ALBUM_AGG} ${where} GROUP BY al.id ORDER BY ${ALBUM_ORDER[q.sort ?? 'artist']} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as AlbumAggRow[];
    return { items: rows.map(rowToAlbum), total, offset, limit };
  }

  getAlbum(id: string): AlbumDetail {
    const row = this.db.prepare(`${ALBUM_AGG} WHERE al.id = ? GROUP BY al.id`).get(id) as
      AlbumAggRow | undefined;
    if (!row) throw new NotFoundError('Album', id);
    const tracks = this.db
      .prepare(
        `${TRACK_SELECT} WHERE t.album_id = ?
         ORDER BY COALESCE(t.disc_number, 1), t.track_number IS NULL, t.track_number, t.file_name`,
      )
      .all(id) as unknown as TrackRow[];
    return { ...rowToAlbum(row), folder: row.folder, tracks: tracks.map(rowToTrack) };
  }

  /** Track ids of an album in playback order (disc, track). */
  albumTrackIds(id: string): string[] {
    return this.getAlbum(id).tracks.map((t) => t.id);
  }

  listArtists(q: ListQuery = {}): Page<ArtistSummary> {
    const { offset, limit } = clampPage(q);
    const w = tokenWhere('ar.search_text', q.q);
    const where = w.clause ? `WHERE ${w.clause}` : '';
    const base = `FROM artists ar JOIN albums al ON al.album_artist_id = ar.id JOIN tracks t ON t.album_id = al.id ${where}`;
    const total = (
      this.db.prepare(`SELECT COUNT(DISTINCT ar.id) AS n ${base}`).get(...w.params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT ar.id, ar.name, COUNT(DISTINCT al.id) AS album_count, COUNT(t.id) AS track_count, MAX(al.artwork_id) AS artwork_id
         ${base} GROUP BY ar.id ORDER BY ar.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      )
      .all(...w.params, limit, offset) as {
      id: string;
      name: string;
      album_count: number;
      track_count: number;
      artwork_id: string | null;
    }[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        albumCount: r.album_count,
        trackCount: r.track_count,
        artworkId: r.artwork_id,
      })),
      total,
      offset,
      limit,
    };
  }

  getArtist(id: string): ArtistDetail {
    const r = this.db
      .prepare(
        `SELECT ar.id, ar.name, COUNT(DISTINCT al.id) AS album_count, COUNT(t.id) AS track_count, MAX(al.artwork_id) AS artwork_id
         FROM artists ar LEFT JOIN albums al ON al.album_artist_id = ar.id LEFT JOIN tracks t ON t.album_id = al.id
         WHERE ar.id = ? GROUP BY ar.id`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          album_count: number;
          track_count: number;
          artwork_id: string | null;
        }
      | undefined;
    if (!r) throw new NotFoundError('Artist', id);
    return {
      id: r.id,
      name: r.name,
      albumCount: r.album_count,
      trackCount: r.track_count,
      artworkId: r.artwork_id,
      albums: this.listAlbums({ artistId: id, sort: 'year', limit: 500 }).items,
    };
  }

  // --- folders --------------------------------------------------------------------------------

  listFolders(rootId: string | undefined, path = ''): FolderListing {
    if (!rootId) {
      const roots = this.listRoots();
      return {
        rootId: '',
        rootName: '',
        path: '',
        folders: roots.map((r) => ({
          rootId: r.id,
          path: '',
          name: r.name,
          trackCount: r.trackCount,
        })),
        tracks: [],
      };
    }
    const root = this.getRootRow(rootId);
    const clean = path
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');
    const dirs = this.db
      .prepare(
        `SELECT relative_dir AS dir, COUNT(*) AS n FROM tracks
         WHERE root_id = ? AND (relative_dir = ? OR relative_dir LIKE ? ESCAPE '\\') GROUP BY relative_dir`,
      )
      .all(rootId, clean, clean ? `${clean.replace(/[\\%_]/g, (c) => `\\${c}`)}/%` : '%') as {
      dir: string;
      n: number;
    }[];
    const children = new Map<string, FolderEntry>();
    for (const { dir, n } of dirs) {
      if (dir === clean) continue;
      const rest = clean ? dir.slice(clean.length + 1) : dir;
      const name = rest.split('/')[0] as string;
      const childPath = clean ? `${clean}/${name}` : name;
      const entry = children.get(childPath) ?? { rootId, path: childPath, name, trackCount: 0 };
      entry.trackCount += n;
      children.set(childPath, entry);
    }
    const tracks = this.db
      .prepare(
        `${TRACK_SELECT} WHERE t.root_id = ? AND t.relative_dir = ? ORDER BY t.disc_number, t.track_number, t.file_name`,
      )
      .all(rootId, clean) as unknown as TrackRow[];
    return {
      rootId,
      rootName: root.name,
      path: clean,
      folders: [...children.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tracks: tracks.map(rowToTrack),
    };
  }

  // --- stats ----------------------------------------------------------------------------------

  stats(): LibraryStats {
    const r = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM tracks) AS track_count,
           (SELECT COUNT(*) FROM albums al WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS album_count,
           (SELECT COUNT(DISTINCT al.album_artist_id) FROM albums al WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)) AS artist_count,
           (SELECT COUNT(*) FROM library_roots) AS root_count,
           (SELECT COUNT(*) FROM tracks WHERE available = 0) AS unavailable,
           (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks) AS total_ms`,
      )
      .get() as {
      track_count: number;
      album_count: number;
      artist_count: number;
      root_count: number;
      unavailable: number;
      total_ms: number;
    };
    return {
      trackCount: r.track_count,
      albumCount: r.album_count,
      artistCount: r.artist_count,
      rootCount: r.root_count,
      unavailableTrackCount: r.unavailable,
      totalDurationMs: r.total_ms,
    };
  }

  // --- artwork rows ---------------------------------------------------------------------------

  insertArtwork(row: {
    id: string;
    mime: string;
    byteSize: number;
    source: 'embedded' | 'folder' | 'generated';
    fileName: string;
  }): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO artwork_cache (id, mime, byte_size, source, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.mime, row.byteSize, row.source, row.fileName, Date.now());
  }

  getArtwork(id: string): { id: string; mime: string; file_name: string } | undefined {
    return this.db.prepare('SELECT id, mime, file_name FROM artwork_cache WHERE id = ?').get(id) as
      { id: string; mime: string; file_name: string } | undefined;
  }
}
