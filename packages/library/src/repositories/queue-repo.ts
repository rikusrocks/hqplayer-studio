import type { QueueMode, QueueSource } from '@hqps/contracts';
import { transaction, type Database } from '../db/database';

export interface QueueSnapshot {
  sessionId: string;
  version: number;
  mode: QueueMode;
  source: QueueSource | null;
  currentIndex: number | null;
  items: { itemId: string; trackId: string }[];
  updatedAt: number;
}

/**
 * Persists the most recent planned Now Playing queue so it survives restarts.
 * Restoring a snapshot never starts playback — that is the caller's (and user's) decision.
 */
export class QueueRepository {
  constructor(private readonly db: Database) {}

  load(): QueueSnapshot | null {
    const s = this.db
      .prepare('SELECT * FROM queue_sessions WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1')
      .get() as
      | {
          id: string;
          version: number;
          mode: QueueMode;
          source_kind: QueueSource['kind'] | null;
          source_id: string | null;
          source_label: string | null;
          current_index: number | null;
          updated_at: number;
        }
      | undefined;
    if (!s) return null;
    const items = this.db
      .prepare(
        'SELECT id AS itemId, track_id AS trackId FROM queue_items WHERE session_id = ? ORDER BY position',
      )
      .all(s.id) as { itemId: string; trackId: string }[];
    return {
      sessionId: s.id,
      version: s.version,
      mode: s.mode,
      source: s.source_kind
        ? { kind: s.source_kind, id: s.source_id, label: s.source_label ?? '' }
        : null,
      currentIndex: s.current_index,
      items: items.map((i) => ({ itemId: i.itemId, trackId: i.trackId })),
      updatedAt: s.updated_at,
    };
  }

  save(q: QueueSnapshot): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE queue_sessions SET is_active = 0 WHERE id != ?').run(q.sessionId);
      this.db
        .prepare(
          `INSERT INTO queue_sessions (id, version, mode, source_kind, source_id, source_label, current_index, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET version = excluded.version, mode = excluded.mode, source_kind = excluded.source_kind,
             source_id = excluded.source_id, source_label = excluded.source_label, current_index = excluded.current_index,
             is_active = 1, updated_at = excluded.updated_at`,
        )
        .run(
          q.sessionId,
          q.version,
          q.mode,
          q.source?.kind ?? null,
          q.source?.id ?? null,
          q.source?.label ?? null,
          q.currentIndex,
          q.updatedAt,
          q.updatedAt,
        );
      this.db.prepare('DELETE FROM queue_items WHERE session_id = ?').run(q.sessionId);
      const ins = this.db.prepare(
        'INSERT INTO queue_items (id, session_id, track_id, position) VALUES (?, ?, ?, ?)',
      );
      q.items.forEach((item, i) => ins.run(item.itemId, q.sessionId, item.trackId, i));
      // keep only the latest few inactive sessions
      this.db
        .prepare(
          `DELETE FROM queue_sessions WHERE is_active = 0 AND id NOT IN
             (SELECT id FROM queue_sessions WHERE is_active = 0 ORDER BY updated_at DESC LIMIT 5)`,
        )
        .run();
    });
  }
}
