import type { PlaylistDetail, PlaylistItem, PlaylistSummary } from '@hqps/contracts';
import { transaction, type Database } from '../db/database';
import { NotFoundError, ValidationError } from '../errors';
import { newId } from '../normalize';
import type { LibraryRepository } from './library-repo';
import { rowToTrack, type TrackRow } from './rows';

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  item_count: number;
  duration_ms: number | null;
}

/**
 * Saved playlists: persistent, user-edited, stable order, duplicates allowed (each entry has its
 * own item id). Nothing here ever touches the Now Playing queue.
 */
export class PlaylistRepository {
  constructor(
    private readonly db: Database,
    private readonly library: LibraryRepository,
  ) {}

  list(): PlaylistSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, COUNT(i.id) AS item_count, SUM(t.duration_ms) AS duration_ms
         FROM playlists p
         LEFT JOIN playlist_items i ON i.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = i.track_id
         GROUP BY p.id ORDER BY p.updated_at DESC`,
      )
      .all() as unknown as PlaylistRow[];
    return rows.map((r) => this.toSummary(r));
  }

  get(id: string): PlaylistDetail {
    const row = this.summaryRow(id);
    const items = this.db
      .prepare(
        `SELECT i.id AS item_id, i.position, i.added_at, t.*, al.artwork_id AS artwork_id
         FROM playlist_items i JOIN tracks t ON t.id = i.track_id LEFT JOIN albums al ON al.id = t.album_id
         WHERE i.playlist_id = ? ORDER BY i.position`,
      )
      .all(id) as unknown as (TrackRow & { item_id: string; position: number; added_at: number })[];
    const mapped: PlaylistItem[] = items.map((r) => ({
      itemId: r.item_id,
      position: r.position,
      addedAt: r.added_at,
      track: rowToTrack(r),
    }));
    return { ...this.toSummary(row), items: mapped };
  }

  create(
    input: { name: string; description?: string | null; trackIds?: string[] },
    now = Date.now(),
  ): PlaylistDetail {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Playlist name is required');
    const id = newId('pl');
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, name, input.description ?? null, now, now);
      if (input.trackIds?.length) this.insertItems(id, input.trackIds, undefined, now);
    });
    return this.get(id);
  }

  update(
    id: string,
    patch: { name?: string; description?: string | null },
    now = Date.now(),
  ): PlaylistDetail {
    this.summaryRow(id);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ValidationError('Playlist name is required');
      this.db
        .prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, now, id);
    }
    if (patch.description !== undefined) {
      this.db
        .prepare('UPDATE playlists SET description = ?, updated_at = ? WHERE id = ?')
        .run(patch.description, now, id);
    }
    return this.get(id);
  }

  delete(id: string): void {
    const res = this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    if (Number(res.changes) === 0) throw new NotFoundError('Playlist', id);
  }

  duplicate(id: string, name?: string, now = Date.now()): PlaylistDetail {
    const src = this.get(id);
    return this.create(
      {
        name: name?.trim() || `${src.name} (copy)`,
        description: src.description,
        trackIds: src.items.map((i) => i.track.id),
      },
      now,
    );
  }

  addItems(id: string, trackIds: string[], position?: number, now = Date.now()): PlaylistDetail {
    this.summaryRow(id);
    transaction(this.db, () => this.insertItems(id, trackIds, position, now));
    return this.get(id);
  }

  removeItems(id: string, itemIds: string[], now = Date.now()): PlaylistDetail {
    this.summaryRow(id);
    transaction(this.db, () => {
      const del = this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?');
      let removed = 0;
      for (const itemId of itemIds) removed += Number(del.run(id, itemId).changes);
      if (removed !== new Set(itemIds).size) {
        throw new NotFoundError('Playlist item', itemIds.join(', '));
      }
      this.renumber(id);
      this.touch(id, now);
    });
    return this.get(id);
  }

  /** `itemIds` must be a permutation of the playlist's current items. */
  reorder(id: string, itemIds: string[], now = Date.now()): PlaylistDetail {
    this.summaryRow(id);
    transaction(this.db, () => {
      const current = (
        this.db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      const same =
        current.length === itemIds.length &&
        new Set(itemIds).size === itemIds.length &&
        itemIds.every((x) => current.includes(x));
      if (!same) {
        throw new ValidationError('Reorder must contain exactly the current playlist items', {
          expected: current.length,
          received: itemIds.length,
        });
      }
      const upd = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
      itemIds.forEach((itemId, i) => upd.run(i, itemId));
      this.touch(id, now);
    });
    return this.get(id);
  }

  // --- internals ------------------------------------------------------------------------------

  private insertItems(
    id: string,
    trackIds: string[],
    position: number | undefined,
    now: number,
  ): void {
    this.library.getTracks(trackIds); // throws NotFound for unknown ids
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(id) as {
        n: number;
      }
    ).n;
    const at = position === undefined ? count : Math.max(0, Math.min(position, count));
    this.db
      .prepare(
        'UPDATE playlist_items SET position = position + ? WHERE playlist_id = ? AND position >= ?',
      )
      .run(trackIds.length, id, at);
    const ins = this.db.prepare(
      'INSERT INTO playlist_items (id, playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?, ?)',
    );
    trackIds.forEach((trackId, i) => ins.run(newId('pli'), id, trackId, at + i, now));
    this.touch(id, now);
  }

  private renumber(id: string): void {
    const ids = (
      this.db
        .prepare('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position')
        .all(id) as { id: string }[]
    ).map((r) => r.id);
    const upd = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
    ids.forEach((itemId, i) => upd.run(i, itemId));
  }

  private touch(id: string, now: number): void {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, id);
  }

  private summaryRow(id: string): PlaylistRow {
    const row = this.db
      .prepare(
        `SELECT p.*, COUNT(i.id) AS item_count, SUM(t.duration_ms) AS duration_ms
         FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id LEFT JOIN tracks t ON t.id = i.track_id
         WHERE p.id = ? GROUP BY p.id`,
      )
      .get(id) as PlaylistRow | undefined;
    if (!row) throw new NotFoundError('Playlist', id);
    return row;
  }

  private toSummary(r: PlaylistRow): PlaylistSummary {
    const art = this.db
      .prepare(
        `SELECT al.artwork_id AS id, MIN(i.position) AS first FROM playlist_items i
         JOIN tracks t ON t.id = i.track_id JOIN albums al ON al.id = t.album_id
         WHERE i.playlist_id = ? AND al.artwork_id IS NOT NULL
         GROUP BY al.artwork_id ORDER BY first LIMIT 4`,
      )
      .all(r.id) as { id: string }[];
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      itemCount: r.item_count,
      durationMs: r.duration_ms ?? 0,
      artworkIds: art.map((a) => a.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
