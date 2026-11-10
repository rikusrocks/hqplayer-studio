import type { Database } from '../db/database';

/**
 * Stored lyrics association per track (`lyrics_cache`, one row per track):
 * `local` / `embedded` / `lrclib` / `demo` hold the lyric text; `none` records that LRCLIB had
 * nothing (so it is not asked again for a while). The row also carries the user's per-track
 * offset and whether the user picked the lyrics by hand.
 *
 * Lyric text lives only here — never in logs, diagnostics or error messages.
 */
export type LyricsCacheSource = 'local' | 'embedded' | 'lrclib' | 'demo' | 'none';
export type LyricsCacheType = 'plain' | 'lrc' | 'word';

export interface LyricsCacheRow {
  trackId: string;
  source: LyricsCacheSource;
  type: LyricsCacheType;
  content: string;
  offsetMs: number;
  selectedByUser: boolean;
  lastCheckedAt: number;
}

interface DbRow {
  track_id: string;
  source: string;
  type: LyricsCacheType;
  content: string;
  offset_ms: number;
  selected_by_user: number;
  last_checked_at: number;
}

const SOURCES = new Set<LyricsCacheSource>(['local', 'embedded', 'lrclib', 'demo', 'none']);

const toRow = (r: DbRow): LyricsCacheRow => ({
  trackId: r.track_id,
  source: SOURCES.has(r.source as LyricsCacheSource) ? (r.source as LyricsCacheSource) : 'none',
  type: r.type,
  content: r.content,
  offsetMs: r.offset_ms,
  selectedByUser: r.selected_by_user === 1,
  lastCheckedAt: r.last_checked_at,
});

export class LyricsRepository {
  constructor(private readonly db: Database) {}

  get(trackId: string): LyricsCacheRow | null {
    const r = this.db.prepare('SELECT * FROM lyrics_cache WHERE track_id = ?').get(trackId) as
      DbRow | undefined;
    return r ? toRow(r) : null;
  }

  /**
   * Insert or replace the association. The user's offset is kept unless `offsetMs` is given;
   * `selectedByUser` defaults to false (automatic match).
   */
  save(
    row: Omit<LyricsCacheRow, 'offsetMs' | 'selectedByUser' | 'lastCheckedAt'> & {
      offsetMs?: number;
      selectedByUser?: boolean;
      lastCheckedAt?: number;
    },
  ): LyricsCacheRow {
    const prev = this.get(row.trackId);
    const next: LyricsCacheRow = {
      trackId: row.trackId,
      source: row.source,
      type: row.type,
      content: row.content,
      offsetMs: row.offsetMs ?? prev?.offsetMs ?? 0,
      selectedByUser: row.selectedByUser ?? false,
      lastCheckedAt: row.lastCheckedAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO lyrics_cache (track_id, source, type, content, offset_ms, selected_by_user, last_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET source = excluded.source, type = excluded.type,
           content = excluded.content, offset_ms = excluded.offset_ms,
           selected_by_user = excluded.selected_by_user, last_checked_at = excluded.last_checked_at`,
      )
      .run(
        next.trackId,
        next.source,
        next.type,
        next.content,
        next.offsetMs,
        next.selectedByUser ? 1 : 0,
        next.lastCheckedAt,
      );
    return next;
  }

  /** Returns false when the track has no stored lyrics. */
  setOffset(trackId: string, offsetMs: number): boolean {
    const res = this.db
      .prepare("UPDATE lyrics_cache SET offset_ms = ? WHERE track_id = ? AND source != 'none'")
      .run(Math.round(offsetMs), trackId);
    return Number(res.changes) > 0;
  }

  delete(trackId: string): void {
    this.db.prepare('DELETE FROM lyrics_cache WHERE track_id = ?').run(trackId);
  }

  /** Forget everything that came from LRCLIB automatically (hand-picked lyrics stay). */
  clearOnline(): number {
    const res = this.db
      .prepare(
        "DELETE FROM lyrics_cache WHERE source IN ('lrclib', 'none') AND selected_by_user = 0",
      )
      .run();
    return Number(res.changes);
  }

  counts(): Record<LyricsCacheSource, number> {
    const out: Record<LyricsCacheSource, number> = {
      local: 0,
      embedded: 0,
      lrclib: 0,
      demo: 0,
      none: 0,
    };
    const rows = this.db
      .prepare('SELECT source, COUNT(*) AS n FROM lyrics_cache GROUP BY source')
      .all() as { source: string; n: number }[];
    for (const r of rows) {
      if (SOURCES.has(r.source as LyricsCacheSource)) out[r.source as LyricsCacheSource] = r.n;
    }
    return out;
  }
}
