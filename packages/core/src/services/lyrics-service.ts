import {
  type LyricsCandidate,
  type LyricsSettings,
  type LyricsSource,
  type OnlineLyricsProviderId,
  type TrackLyrics,
} from '@hqps/contracts';
import {
  demoLyricsLrc,
  readEmbeddedLyrics,
  readSidecarLyrics,
  type EmbeddedLyrics,
  ONLINE_LYRICS_SOURCES,
  type LibraryContext,
  type LyricsCacheRow,
  type SidecarHints,
} from '@hqps/library';
import {
  createOnlineLyricsProviders,
  OnlineUnavailableError,
  parseLrc,
  toLrcText,
  type LrclibClient,
  type OnlineLyrics,
  type OnlineLyricsCandidate,
  type OnlineLyricsProvider,
  type OnlineLyricsQuery,
} from '@hqps/lyrics';
import type { EventHub } from '../event-hub';
import { HttpError } from '../http/errors';
import { LYRICS_ONLINE_SETTING, LYRICS_PROVIDERS_SETTING } from '../settings-keys';

export interface LyricsServiceOptions {
  appVersion: string;
  /** Injected LRCLIB client (tests). Default: real client with Studio's User-Agent. */
  lrclib?: LrclibClient;
  /** All online sources in the order they are tried (tests). Default: the built-in ones. */
  providers?: OnlineLyricsProvider[];
  readSidecar?: (audioPath: string, hints?: SidecarHints) => Promise<string | null>;
  readEmbedded?: (audioPath: string) => Promise<EmbeddedLyrics | null>;
  /** How long the sources' "no lyrics" answer is trusted before asking again. Default 7 days. */
  notFoundTtlMs?: number;
  now?: () => number;
}

const UNKNOWN_ARTIST = 'unknown artist';
/** Sources used when the user has not chosen any: LRCLIB only, as before more were added. */
const DEFAULT_PROVIDERS: OnlineLyricsProviderId[] = ['lrclib'];

/** "HQPlayerStudio/0.3.0 (unofficial HQPlayer Desktop client)" — no homepage, no account name. */
export function studioUserAgent(appVersion: string): string {
  const v = /^[\w.+-]{1,32}$/.test(appVersion) ? appVersion : 'dev';
  return `HQPlayerStudio/${v} (unofficial HQPlayer Desktop client)`;
}
export const lrclibUserAgent = studioUserAgent;

/**
 * Lyrics for library tracks (handoff §8.4). Order: hand-picked lyrics > a lyrics file next to the
 * audio file > lyrics in the file's tags > stored online result > the enabled online sources,
 * one after the other (LRCLIB, NetEase, Kugou, lyrics.ovh).
 *
 * Online lookups are opt-in (Settings → 歌词, default off; every source has its own switch), only
 * ever for the track that is playing right now (`isCurrent`), one at a time per source with
 * back-off — never for a whole album, a scan or any other bulk job. Lyric text is never logged or
 * put into errors/diagnostics.
 */
export class LyricsService {
  private readonly providers: OnlineLyricsProvider[];
  private readonly readSidecar: (p: string, hints?: SidecarHints) => Promise<string | null>;
  private readonly readEmbedded: (p: string) => Promise<EmbeddedLyrics | null>;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<TrackLyrics>>();
  /** Tracks whose tags were already read and had no lyrics (this session). */
  private readonly noEmbedded = new Set<string>();
  /**
   * Sources that already answered "nothing" for a track while another one was unreachable (this
   * session): the retry after the pause asks only the source that could not answer.
   */
  private readonly answered = new Map<string, Set<OnlineLyricsProviderId>>();

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    private readonly isCurrent: (trackId: string) => boolean,
    private readonly opts: LyricsServiceOptions,
  ) {
    this.providers =
      opts.providers ??
      createOnlineLyricsProviders({
        userAgent: studioUserAgent(opts.appVersion),
        lrclib: opts.lrclib,
      });
    this.readSidecar = opts.readSidecar ?? readSidecarLyrics;
    this.readEmbedded = opts.readEmbedded ?? readEmbeddedLyrics;
    this.now = opts.now ?? Date.now;
  }

  onlineEnabled(): boolean {
    return this.ctx.settings.get<boolean>(LYRICS_ONLINE_SETTING, false) === true;
  }

  /** The sources the user switched on, in the order they are tried. */
  private enabledProviders(): OnlineLyricsProvider[] {
    const saved = this.ctx.settings.get<unknown>(LYRICS_PROVIDERS_SETTING, null);
    const ids = new Set<unknown>(Array.isArray(saved) ? saved : DEFAULT_PROVIDERS);
    return this.providers.filter((p) => ids.has(p.id));
  }

  settings(): LyricsSettings {
    const c = this.ctx.lyrics.counts();
    const enabled = this.enabledProviders();
    const pauses = enabled.map((p) => Math.round(p.blockedForMs()));
    return {
      online: this.onlineEnabled(),
      providers: this.providers.map((p) => ({
        id: p.id,
        enabled: enabled.includes(p),
        pausedForMs: Math.round(p.blockedForMs()),
      })),
      cached: {
        local: c.local,
        embedded: c.embedded,
        lrclib: c.lrclib,
        netease: c.netease,
        kugou: c.kugou,
        lyricsovh: c.lyricsovh,
        demo: c.demo,
        notFound: c.none,
      },
      onlinePausedForMs: pauses.length > 0 ? Math.min(...pauses) : 0,
    };
  }

  /** Switch online lyrics on/off and/or choose the sources. */
  update(change: { online?: boolean; providers?: OnlineLyricsProviderId[] }): LyricsSettings {
    if (change.online !== undefined) this.ctx.settings.set(LYRICS_ONLINE_SETTING, change.online);
    if (change.providers !== undefined) {
      const wanted = new Set(change.providers);
      this.ctx.settings.set(
        LYRICS_PROVIDERS_SETTING,
        this.providers.map((p) => p.id).filter((id) => wanted.has(id)),
      );
      // A newly enabled source may know what the others did not: forget session-only misses.
      this.answered.clear();
    }
    this.hub.publish({ type: 'lyrics.changed', trackId: null });
    return this.settings();
  }

  setOnline(online: boolean): LyricsSettings {
    return this.update({ online });
  }

  /** Forget online results that were matched automatically (hand-picked lyrics stay). */
  clearOnlineCache(): LyricsSettings {
    this.ctx.lyrics.clearOnline();
    this.answered.clear();
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

  /**
   * Candidates from every enabled source for manual matching (desktop; needs online lyrics
   * turned on). A source that cannot answer right now is skipped; only when none can answer is
   * the search reported as unavailable.
   */
  async search(trackId: string, q?: string): Promise<LyricsCandidate[]> {
    const src = this.source(trackId);
    const providers = this.requireOnline();
    const text = q?.trim();
    const query = text
      ? { text }
      : { trackName: src.title.trim(), artistName: this.artistFor(src) ?? '' };
    const answers = await Promise.allSettled(providers.map((p) => p.search(query)));
    const out: LyricsCandidate[] = [];
    let unavailable: OnlineUnavailableError | null = null;
    let answered = 0;
    for (const a of answers) {
      if (a.status === 'fulfilled') {
        answered += 1;
        out.push(...a.value.slice(0, MAX_CANDIDATES_PER_SOURCE).map(toCandidate));
      } else if (a.reason instanceof OnlineUnavailableError) {
        if (!unavailable || a.reason.retryAfterMs < unavailable.retryAfterMs) {
          unavailable = a.reason;
        }
      } else {
        throw a.reason;
      }
    }
    if (answered === 0 && unavailable) throw upstreamUnavailable(unavailable);
    return out;
  }

  /** Use one search result for this track from now on (manual choice wins over everything). */
  async select(
    trackId: string,
    provider: OnlineLyricsProviderId,
    ref: string,
  ): Promise<TrackLyrics> {
    this.source(trackId);
    const source = this.requireOnline().find((p) => p.id === provider);
    if (!source) {
      throw new HttpError(409, 'conflict', 'This lyrics source is turned off', {
        reason: 'provider_disabled',
      });
    }
    let lyrics: OnlineLyrics | null;
    try {
      lyrics = await source.fetch(ref);
    } catch (err) {
      throw err instanceof OnlineUnavailableError ? upstreamUnavailable(err) : err;
    }
    if (!lyrics) throw new HttpError(404, 'not_found', 'The source has no such lyrics');
    const row = this.ctx.lyrics.save({
      trackId,
      source: provider,
      ...lyricsContent(lyrics),
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
    this.answered.delete(trackId);
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

  /** The enabled sources; 409 when online lyrics (or every source) are switched off. */
  private requireOnline(): OnlineLyricsProvider[] {
    const providers = this.onlineEnabled() ? this.enabledProviders() : [];
    if (providers.length === 0) {
      throw new HttpError(409, 'conflict', 'Online lyrics are turned off', {
        reason: 'online_disabled',
      });
    }
    return providers;
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

    // 1) a lyrics file next to the audio file (always re-read: the user may edit it). Skipped
    //    while the folder is offline — an unreachable NAS path can stall for a long time.
    const sidecar = src.available
      ? await this.readSidecar(src.sourcePath, { title: src.title, artist: src.artist })
      : null;
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

    // 3) earlier online result.
    if (row && isOnlineSource(row.source)) return this.fromRow(trackId, row);

    // 4) the enabled online sources — opt-in, playing track only.
    const enabled = this.onlineEnabled();
    const providers = enabled ? this.enabledProviders() : [];
    const artist = this.artistFor(src);
    const eligible =
      providers.length > 0 && this.isCurrent(trackId) && Boolean(src.title.trim() && artist);
    const ttl = this.opts.notFoundTtlMs ?? 7 * 24 * 3_600_000;
    if (row?.source === 'none' && !force && this.now() - row.lastCheckedAt < ttl) {
      return this.notFound(trackId, row, enabled, eligible);
    }
    if (!eligible) return this.notFound(trackId, row, enabled, eligible);

    const q: OnlineLyricsQuery = {
      trackName: src.title.trim(),
      artistName: artist!,
      albumName: src.album.trim() || null,
      durationSec: src.durationMs ? src.durationMs / 1000 : null,
    };
    if (force) this.answered.delete(trackId);
    const answered = this.answered.get(trackId) ?? new Set<OnlineLyricsProviderId>();
    // Plain lyrics are kept in hand while the remaining sources are asked for synced ones.
    let plain: { provider: OnlineLyricsProviderId; lyrics: OnlineLyrics } | null = null;
    let retryAfterMs: number | null = null;
    for (const provider of providers) {
      if (answered.has(provider.id)) continue;
      let found: OnlineLyrics | null;
      try {
        found = await provider.find(q);
      } catch (err) {
        if (!(err instanceof OnlineUnavailableError)) throw err;
        const wait = Math.max(
          err.retryAfterMs || provider.blockedForMs(),
          err.reason === 'bad_response' ? 60_000 : 1000,
        );
        retryAfterMs = retryAfterMs === null ? wait : Math.min(retryAfterMs, wait);
        continue;
      }
      answered.add(provider.id);
      if (!found) continue;
      if (found.synced || found.instrumental) {
        this.answered.delete(trackId);
        row = this.ctx.lyrics.save({ trackId, source: provider.id, ...lyricsContent(found) });
        return this.fromRow(trackId, row);
      }
      if (found.plain && !plain) plain = { provider: provider.id, lyrics: found };
    }
    if (plain) {
      this.answered.delete(trackId);
      row = this.ctx.lyrics.save({
        trackId,
        source: plain.provider,
        ...lyricsContent(plain.lyrics),
      });
      return this.fromRow(trackId, row);
    }
    if (retryAfterMs !== null) {
      // Some source could not answer: remember who already did and try the rest after the pause.
      if (this.answered.size > 500) this.answered.clear();
      this.answered.set(trackId, answered);
      return {
        ...this.empty(trackId, row, enabled, eligible),
        state: 'unavailable',
        online: { enabled, eligible, checkedAt: row?.lastCheckedAt ?? null, retryAfterMs },
      };
    }
    this.answered.delete(trackId);
    row = this.ctx.lyrics.save({ trackId, source: 'none', type: 'plain', content: '' });
    return this.notFound(trackId, row, enabled, eligible);
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
        checkedAt:
          row && (row.source === 'none' || isOnlineSource(row.source)) ? row.lastCheckedAt : null,
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
    const eligible = enabled && this.enabledProviders().length > 0 && this.isCurrent(trackId);
    if (!row || row.source === 'none') return this.notFound(trackId, row, enabled, eligible);
    const base = this.empty(trackId, row, enabled, eligible);
    const source = row.source as LyricsSource;
    if (row.content.trim() === '') {
      // Online sources mark instrumentals with no lyrics at all.
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

const MAX_CANDIDATES_PER_SOURCE = 12;

const ONLINE_SOURCES: ReadonlySet<string> = new Set(ONLINE_LYRICS_SOURCES);
const isOnlineSource = (source: string): source is OnlineLyricsProviderId =>
  ONLINE_SOURCES.has(source);

function upstreamUnavailable(err: OnlineUnavailableError): HttpError {
  return new HttpError(503, 'upstream_unavailable', 'Online lyrics are not available right now', {
    reason: err.reason,
    retryAfterMs: err.retryAfterMs,
  });
}

function lyricsContent(l: OnlineLyrics): { type: 'lrc' | 'plain'; content: string } {
  if (l.synced) return { type: 'lrc', content: l.synced };
  if (l.plain) return { type: 'plain', content: l.plain };
  return { type: 'plain', content: '' }; // instrumental
}

function toCandidate(c: OnlineLyricsCandidate): LyricsCandidate {
  const text = c.lyrics?.synced ?? c.lyrics?.plain ?? '';
  return {
    provider: c.provider,
    ref: c.ref,
    trackName: c.trackName,
    artistName: c.artistName,
    albumName: c.albumName,
    durationMs: c.durationSec !== null ? Math.round(c.durationSec * 1000) : null,
    synced: c.synced,
    instrumental: c.instrumental,
    preview: plainLines(text)
      .filter((l) => l.trim())
      .slice(0, 3),
  };
}
