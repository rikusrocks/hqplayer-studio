import {
  type LyricsCandidate,
  type LyricsSettings,
  type LyricsSource,
  type TrackLyrics,
} from '@hqps/contracts';
import {
  demoLyricsLrc,
  readEmbeddedLyrics,
  readSidecarLyrics,
  type EmbeddedLyrics,
  type LibraryContext,
  type LyricsCacheRow,
} from '@hqps/library';
import {
  LrclibClient,
  LrclibUnavailableError,
  parseLrc,
  pickBestRecord,
  toLrcText,
  type LrclibQuery,
  type LrclibRecord,
} from '@hqps/lyrics';
import type { EventHub } from '../event-hub';
import { HttpError } from '../http/errors';
import { LYRICS_ONLINE_SETTING } from '../settings-keys';

export interface LyricsServiceOptions {
  appVersion: string;
  /** Injected LRCLIB client (tests). Default: real client with Studio's User-Agent. */
  lrclib?: LrclibClient;
  readSidecar?: (audioPath: string) => Promise<string | null>;
  readEmbedded?: (audioPath: string) => Promise<EmbeddedLyrics | null>;
  /** How long LRCLIB's "no lyrics" answer is trusted before asking again. Default 7 days. */
  notFoundTtlMs?: number;
  now?: () => number;
}

const UNKNOWN_ARTIST = 'unknown artist';

/** "HQPlayerStudio/0.3.0 (unofficial HQPlayer Desktop client)" — no homepage, no account name. */
export function lrclibUserAgent(appVersion: string): string {
  const v = /^[\w.+-]{1,32}$/.test(appVersion) ? appVersion : 'dev';
  return `HQPlayerStudio/${v} (unofficial HQPlayer Desktop client)`;
}

/**
 * Lyrics for library tracks (handoff §8.4). Order: hand-picked lyrics > `.lrc` next to the file >
 * lyrics in the file's tags > stored LRCLIB result > LRCLIB online.
 *
 * Online lookups are opt-in (Settings → 歌词, default off), only ever for the track that is
 * playing right now (`isCurrent`), one at a time with back-off — never for a whole album, a scan
 * or any other bulk job. Lyric text is never logged or put into errors/diagnostics.
 */
export class LyricsService {
  private readonly lrclib: LrclibClient;
  private readonly readSidecar: (p: string) => Promise<string | null>;
  private readonly readEmbedded: (p: string) => Promise<EmbeddedLyrics | null>;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<TrackLyrics>>();
  /** Tracks whose tags were already read and had no lyrics (this session). */
  private readonly noEmbedded = new Set<string>();

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    private readonly isCurrent: (trackId: string) => boolean,
    private readonly opts: LyricsServiceOptions,
  ) {
    this.lrclib = opts.lrclib ?? new LrclibClient({ userAgent: lrclibUserAgent(opts.appVersion) });
    this.readSidecar = opts.readSidecar ?? readSidecarLyrics;
    this.readEmbedded = opts.readEmbedded ?? readEmbeddedLyrics;
    this.now = opts.now ?? Date.now;
  }

  onlineEnabled(): boolean {
    return this.ctx.settings.get<boolean>(LYRICS_ONLINE_SETTING, false) === true;
  }

  settings(): LyricsSettings {
    const c = this.ctx.lyrics.counts();
    return {
      online: this.onlineEnabled(),
      cached: {
        local: c.local,
        embedded: c.embedded,
        lrclib: c.lrclib,
        demo: c.demo,
        notFound: c.none,
      },
      onlinePausedForMs: Math.round(this.lrclib.blockedForMs()),
    };
  }

  setOnline(online: boolean): LyricsSettings {
    this.ctx.settings.set(LYRICS_ONLINE_SETTING, online);
    this.hub.publish({ type: 'lyrics.changed', trackId: null });
    return this.settings();
  }

  /** Forget LRCLIB results that were matched automatically (hand-picked lyrics stay). */
  clearOnlineCache(): LyricsSettings {
    this.ctx.lyrics.clearOnline();
    this.hub.publish({ type: 'lyrics.changed', trackId: null });
    return this.settings();
  }

  /** Lyrics of a track; concurrent requests for the same track share one lookup. */
  get(trackId: string, opts: { force?: boolean } = {}): Promise<TrackLyrics> {
    const key = `${trackId}\u0000${opts.force ? 1 : 0}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.resolve(trackId, opts.force === true).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  setOffset(trackId: string, offsetMs: number): TrackLyrics {
    this.source(trackId); // 404 for unknown tracks
    if (!this.ctx.lyrics.setOffset(trackId, offsetMs)) {
      throw new HttpError(409, 'conflict', 'This track has no lyrics to calibrate', {
        reason: 'no_lyrics',
      });
    }
    this.hub.publish({ type: 'lyrics.changed', trackId });
    return this.fromRow(trackId, this.ctx.lyrics.get(trackId));
  }

  /** LRCLIB candidates for manual matching (desktop; needs online lyrics turned on). */
  async search(trackId: string, q?: string): Promise<LyricsCandidate[]> {
    const src = this.source(trackId);
    this.requireOnline();
    const query = q?.trim();
    const records = await this.callLrclib(() =>
      this.lrclib.search(
        query ? { q: query } : { trackName: src.title, artistName: this.artistFor(src) ?? '' },
      ),
    );
    return records.slice(0, 20).map(toCandidate);
  }

  /** Use one LRCLIB record for this track from now on (manual choice wins over everything). */
  async select(trackId: string, lrclibId: number): Promise<TrackLyrics> {
    this.source(trackId);
    this.requireOnline();
    const rec = await this.callLrclib(() => this.lrclib.getById(lrclibId));
    if (!rec) throw new HttpError(404, 'not_found', 'LRCLIB has no such lyrics');
    const row = this.ctx.lyrics.save({
      trackId,
      source: 'lrclib',
      ...recordContent(rec),
      selectedByUser: true,
      lastCheckedAt: this.now(),
    });
    this.hub.publish({ type: 'lyrics.changed', trackId });
    return this.fromRow(trackId, row);
  }

  /** Drop the stored match (manual choice, "not found", stale cache) and look again. */
  async reset(trackId: string): Promise<TrackLyrics> {
    this.source(trackId);
    const prev = this.ctx.lyrics.get(trackId);
    this.ctx.lyrics.delete(trackId);
    this.noEmbedded.delete(trackId);
    const res = await this.get(trackId, { force: true });
    if (prev && prev.offsetMs !== 0 && res.state === 'found') {
      this.ctx.lyrics.setOffset(trackId, prev.offsetMs);
    }
    this.hub.publish({ type: 'lyrics.changed', trackId });
    return prev && res.state === 'found' ? { ...res, offsetMs: prev.offsetMs } : res;
  }

  // ------------------------------------------------------------------------------------------

  private source(trackId: string) {
    const [src] = this.ctx.library.getTrackSources([trackId]); // throws NotFoundError → 404
    return src!;
  }

  private requireOnline(): void {
    if (!this.onlineEnabled()) {
      throw new HttpError(409, 'conflict', 'Online lyrics are turned off', {
        reason: 'online_disabled',
      });
    }
  }

  private async callLrclib<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LrclibUnavailableError) {
        throw new HttpError(503, 'upstream_unavailable', 'LRCLIB is not available right now', {
          reason: err.reason,
          retryAfterMs: err.retryAfterMs,
        });
      }
      throw err;
    }
  }

  private artistFor(src: { artist: string }): string | null {
    const a = src.artist.trim();
    return a && a.toLowerCase() !== UNKNOWN_ARTIST ? a : null;
  }

  private async resolve(trackId: string, force: boolean): Promise<TrackLyrics> {
    const src = this.source(trackId);
    let row = this.ctx.lyrics.get(trackId);
    if (row?.selectedByUser) return this.fromRow(trackId, row);

    // Fictional demo library: invented, clearly marked demo lyrics (never sent anywhere).
    if (src.isFixture) {
      if (row?.source !== 'demo') {
        row = this.ctx.lyrics.save({
          trackId,
          source: 'demo',
          type: 'lrc',
          content: demoLyricsLrc(src.title, src.durationMs),
        });
      }
      return this.fromRow(trackId, row);
    }

    // 1) `<same name>.lrc` next to the audio file (always re-read: the user may edit it). Skipped
    //    while the folder is offline — an unreachable NAS path can stall for a long time.
    const sidecar = src.available ? await this.readSidecar(src.sourcePath) : null;
    if (sidecar !== null) {
      if (row?.source !== 'local' || row.content !== sidecar) {
        row = this.ctx.lyrics.save({
          trackId,
          source: 'local',
          type: parseLrc(sidecar).kind === 'synced' ? 'lrc' : 'plain',
          content: sidecar,
        });
      }
      return this.fromRow(trackId, row);
    }
    if (row?.source === 'local' && src.available) {
      this.ctx.lyrics.delete(trackId); // the .lrc file is gone
      row = null;
    }

    // 2) lyrics in the file's tags (read once; cached). A stored local copy is used while offline.
    if (row?.source === 'embedded' || row?.source === 'local') return this.fromRow(trackId, row);
    if (!this.noEmbedded.has(trackId) && src.available) {
      const emb = await this.readEmbedded(src.sourcePath);
      const text = emb ? (emb.synced.length ? toLrcText(emb.synced) : emb.text) : null;
      if (text?.trim()) {
        row = this.ctx.lyrics.save({
          trackId,
          source: 'embedded',
          type: parseLrc(text).kind === 'synced' ? 'lrc' : 'plain',
          content: text,
        });
        return this.fromRow(trackId, row);
      }
      this.noEmbedded.add(trackId);
    }

    // 3) earlier LRCLIB result.
    if (row?.source === 'lrclib') return this.fromRow(trackId, row);

    // 4) LRCLIB — opt-in, playing track only.
    const enabled = this.onlineEnabled();
    const artist = this.artistFor(src);
    const eligible = enabled && this.isCurrent(trackId) && Boolean(src.title.trim() && artist);
    const ttl = this.opts.notFoundTtlMs ?? 7 * 24 * 3_600_000;
    if (row?.source === 'none' && !force && this.now() - row.lastCheckedAt < ttl) {
      return this.notFound(trackId, row, enabled, eligible);
    }
    if (!eligible) return this.notFound(trackId, row, enabled, eligible);

    const q: LrclibQuery = {
      trackName: src.title.trim(),
      artistName: artist!,
      albumName: src.album.trim() || null,
      durationSec: src.durationMs ? src.durationMs / 1000 : null,
    };
    let rec: LrclibRecord | null;
    try {
      rec = q.albumName && q.durationSec ? await this.lrclib.get(q) : null;
      if (!rec) {
        // Album names differ between releases ("Remastered", translations…): one search, then
        // pick by name + duration (±2 s). Still a single track, not a bulk lookup.
        rec = pickBestRecord(
          await this.lrclib.search({ trackName: q.trackName, artistName: q.artistName }),
          q,
        );
      }
    } catch (err) {
      if (!(err instanceof LrclibUnavailableError)) throw err;
      return {
        ...this.empty(trackId, row, enabled, eligible),
        state: 'unavailable',
        online: {
          enabled,
          eligible,
          checkedAt: row?.lastCheckedAt ?? null,
          retryAfterMs: Math.max(1000, err.retryAfterMs || this.lrclib.blockedForMs()),
        },
      };
    }
    row = rec
      ? this.ctx.lyrics.save({ trackId, source: 'lrclib', ...recordContent(rec) })
      : this.ctx.lyrics.save({ trackId, source: 'none', type: 'plain', content: '' });
    return rec ? this.fromRow(trackId, row) : this.notFound(trackId, row, enabled, eligible);
  }

  private empty(
    trackId: string,
    row: LyricsCacheRow | null,
    enabled: boolean,
    eligible: boolean,
  ): TrackLyrics {
    return {
      trackId,
      state: 'not_found',
      source: null,
      kind: null,
      lines: [],
      plain: [],
      instrumental: false,
      offsetMs: 0,
      selectedByUser: false,
      online: {
        enabled,
        eligible,
        checkedAt: row?.source === 'none' || row?.source === 'lrclib' ? row.lastCheckedAt : null,
        retryAfterMs: null,
      },
    };
  }

  private notFound(
    trackId: string,
    row: LyricsCacheRow | null,
    enabled: boolean,
    eligible: boolean,
  ): TrackLyrics {
    return this.empty(trackId, row, enabled, eligible);
  }

  private fromRow(trackId: string, row: LyricsCacheRow | null): TrackLyrics {
    const enabled = this.onlineEnabled();
    const eligible = enabled && this.isCurrent(trackId);
    if (!row || row.source === 'none') return this.notFound(trackId, row, enabled, eligible);
    const base = this.empty(trackId, row, enabled, eligible);
    const source = row.source as LyricsSource;
    if (row.content.trim() === '') {
      // LRCLIB marks instrumentals with no lyrics at all.
      return { ...base, state: 'found', source, instrumental: true, offsetMs: row.offsetMs };
    }
    const parsed = parseLrc(row.content);
    const synced = row.type !== 'plain' && parsed.kind === 'synced';
    return {
      ...base,
      state: 'found',
      source,
      kind: synced ? 'synced' : 'plain',
      lines: synced
        ? parsed.lines.map((l) => ({ timeMs: Math.round(l.timeMs), text: l.text }))
        : [],
      plain: synced ? [] : plainLines(row.content),
      offsetMs: row.offsetMs,
      selectedByUser: row.selectedByUser,
    };
  }
}

/** Plain lines of any lyrics text (time tags stripped, metadata tags dropped). */
function plainLines(content: string): string[] {
  const p = parseLrc(content);
  if (p.kind === 'synced') return p.lines.map((l) => l.text);
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => !/^\[(ti|ar|al|offset|by|length|re|ve):[^\]]*\]$/i.test(l));
}

function recordContent(rec: LrclibRecord): { type: 'lrc' | 'plain'; content: string } {
  if (rec.syncedLyrics) return { type: 'lrc', content: rec.syncedLyrics };
  if (rec.plainLyrics) return { type: 'plain', content: rec.plainLyrics };
  return { type: 'plain', content: '' }; // instrumental
}

function toCandidate(rec: LrclibRecord): LyricsCandidate {
  const text = rec.syncedLyrics ?? rec.plainLyrics ?? '';
  return {
    lrclibId: rec.id,
    trackName: rec.trackName,
    artistName: rec.artistName,
    albumName: rec.albumName,
    durationMs: rec.duration !== null ? Math.round(rec.duration * 1000) : null,
    synced: rec.syncedLyrics !== null,
    instrumental: rec.instrumental,
    preview: plainLines(text)
      .filter((l) => l.trim())
      .slice(0, 3),
  };
}
