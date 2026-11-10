import { parseLrc } from './lrc';
import { LrclibClient, pickBestRecord, type LrclibRecord } from './lrclib';
import {
  artistVariants,
  durationDistance,
  normName,
  sameTrack,
  titleVariants,
  type TrackSignature,
} from './match';
import { PoliteHttp, type PoliteHttpOptions } from './polite-http';

/**
 * Online lyric sources. Every source is a separate third party that the user switches on by
 * itself (Settings → 歌词); a lookup sends the playing track's title, artist, album and duration
 * to it and nothing else. All sources follow the same house rules (`PoliteHttp`): one request at
 * a time, spaced out, back-off after errors, lyric text never in errors.
 *
 *  - `lrclib`    — LRCLIB, an open lyrics database with a documented API.
 *  - `netease`   — NetEase Cloud Music (网易云音乐). Large Chinese catalogue; the web player's
 *                  own search/lyric interface, which is not a documented public API.
 *  - `kugou`     — Kugou Music (酷狗音乐) lyric search; also not a documented public API.
 *  - `lyricsovh` — lyrics.ovh, an open API for plain (unsynced) lyrics.
 */
export const ONLINE_LYRICS_PROVIDER_IDS = ['lrclib', 'netease', 'kugou', 'lyricsovh'] as const;
export type OnlineLyricsProviderId = (typeof ONLINE_LYRICS_PROVIDER_IDS)[number];

export interface OnlineLyricsQuery {
  trackName: string;
  artistName: string;
  albumName?: string | null;
  /** Track duration in seconds. */
  durationSec?: number | null;
}

/** Lyrics as a source delivered them. `instrumental`: the source says there are no vocals. */
export interface OnlineLyrics {
  /** LRC text with time tags. */
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

/** One search result offered for manual matching. */
export interface OnlineLyricsCandidate {
  provider: OnlineLyricsProviderId;
  /** Opaque reference understood by the same provider's `fetch`. */
  ref: string;
  trackName: string;
  artistName: string;
  albumName: string;
  durationSec: number | null;
  /** Null when the source does not say before the lyrics are fetched. */
  synced: boolean | null;
  instrumental: boolean;
  /** Present when the search answer already carries the text (LRCLIB). */
  lyrics: OnlineLyrics | null;
}

export interface OnlineLyricsSearch {
  /** Free text typed by the user… */
  text?: string;
  /** …or the track's own names. */
  trackName?: string;
  artistName?: string;
}

export interface OnlineLyricsProvider {
  readonly id: OnlineLyricsProviderId;
  /** Milliseconds until this source may be asked again (0 = now). */
  blockedForMs(): number;
  /** Automatic match for one track; null when the source has nothing that fits. */
  find(q: OnlineLyricsQuery): Promise<OnlineLyrics | null>;
  /** Candidates for manual matching. */
  search(q: OnlineLyricsSearch): Promise<OnlineLyricsCandidate[]>;
  /** The lyrics behind a candidate's `ref`; null when they are gone. */
  fetch(ref: string): Promise<OnlineLyrics | null>;
}

export type OnlineProviderHttpOptions = Omit<PoliteHttpOptions, 'service' | 'headers'>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const hasContent = (l: OnlineLyrics | null): l is OnlineLyrics =>
  l !== null && (l.instrumental || l.synced !== null || l.plain !== null);

/** Sort text into synced / plain by whether it carries time tags. */
export function lyricsFromText(text: string): OnlineLyrics | null {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return null;
  return parseLrc(clean).kind === 'synced'
    ? { synced: clean, plain: null, instrumental: false }
    : { synced: null, plain: clean, instrumental: false };
}

const searchText = (q: OnlineLyricsSearch, join = ' '): string =>
  (q.text ?? [q.artistName, q.trackName].filter(Boolean).join(join)).trim();

// --------------------------------------------------------------------------------------- LRCLIB

function fromLrclib(rec: LrclibRecord): OnlineLyrics {
  return { synced: rec.syncedLyrics, plain: rec.plainLyrics, instrumental: rec.instrumental };
}

export class LrclibProvider implements OnlineLyricsProvider {
  readonly id = 'lrclib';

  constructor(private readonly client: LrclibClient) {}

  blockedForMs(): number {
    return this.client.blockedForMs();
  }

  /**
   * 1) exact signature (needs album + duration); 2) one search by title + artist as tagged;
   * 3) one more search with the cleaned title / first credited artist when those differ
   * ("Song (Remastered 2009)" → "Song"). Results are picked by name + duration (±2 s).
   */
  async find(q: OnlineLyricsQuery): Promise<OnlineLyrics | null> {
    let rec = q.albumName && q.durationSec ? await this.client.get(q) : null;
    if (!rec) {
      rec = pickBestRecord(
        await this.client.search({ trackName: q.trackName, artistName: q.artistName }),
        q,
      );
    }
    if (!rec) {
      const title = titleVariants(q.trackName).at(-1) ?? q.trackName;
      const artist = artistVariants(q.artistName).at(-1) ?? q.artistName;
      if (
        normName(title) !== normName(q.trackName) ||
        normName(artist) !== normName(q.artistName)
      ) {
        const cleaned = { ...q, trackName: title, artistName: artist };
        const found = await this.client.search({ trackName: title, artistName: artist });
        rec =
          pickBestRecord(found, cleaned) ??
          pickBestRecord(
            found.map((r) => ({ ...r, trackName: titleVariants(r.trackName).at(-1) ?? '' })),
            cleaned,
          );
      }
    }
    return rec ? fromLrclib(rec) : null;
  }

  async search(q: OnlineLyricsSearch): Promise<OnlineLyricsCandidate[]> {
    const records = await this.client.search(
      q.text ? { q: q.text } : { trackName: q.trackName, artistName: q.artistName },
    );
    return records.map((rec) => ({
      provider: this.id,
      ref: String(rec.id),
      trackName: rec.trackName,
      artistName: rec.artistName,
      albumName: rec.albumName,
      durationSec: rec.duration,
      synced: rec.syncedLyrics !== null,
      instrumental: rec.instrumental,
      lyrics: fromLrclib(rec),
    }));
  }

  async fetch(ref: string): Promise<OnlineLyrics | null> {
    if (!/^\d{1,15}$/.test(ref)) return null;
    const rec = await this.client.getById(Number(ref));
    return rec ? fromLrclib(rec) : null;
  }
}

// -------------------------------------------------------------------------------------- NetEase

interface NeteaseSong extends TrackSignature {
  id: number;
  albumName: string;
}

/** One song of a NetEase search answer (old `artists/album/duration` or new `ar/al/dt` shape). */
export function toNeteaseSong(v: unknown): NeteaseSong | null {
  const o = obj(v);
  const id = num(o?.id);
  if (!o || id === null || !Number.isInteger(id) || id <= 0) return null;
  const artists = arr(o.artists ?? o.ar)
    .map((a) => str(obj(a)?.name))
    .filter(Boolean);
  const ms = num(o.duration ?? o.dt);
  return {
    id,
    trackName: str(o.name),
    artistName: artists.join(' / '),
    albumName: str(obj(o.album ?? o.al)?.name),
    durationSec: ms !== null && ms > 0 ? ms / 1000 : null,
  };
}

/**
 * Lyrics from a NetEase lyric answer. Newer songs put credits into JSON lines
 * (`{"t":0,"c":[…]}`) before the LRC text; those are dropped.
 */
export function neteaseLyrics(v: unknown): OnlineLyrics | null {
  const o = obj(v);
  if (!o) return null;
  if (o.nolyric === true) return { synced: null, plain: null, instrumental: true };
  const text = str(obj(o.lrc)?.lyric)
    .split(/\r\n|\r|\n/)
    .filter((l) => !/^\s*\{.*\}\s*$/.test(l))
    .join('\n');
  return lyricsFromText(text);
}

export class NeteaseProvider implements OnlineLyricsProvider {
  readonly id = 'netease';
  private readonly http: PoliteHttp;
  private readonly baseUrl: string;

  constructor(opts: OnlineProviderHttpOptions & { baseUrl?: string }) {
    const { baseUrl, ...rest } = opts;
    this.baseUrl = (baseUrl ?? 'https://music.163.com').replace(/\/$/, '');
    this.http = new PoliteHttp({
      errorBackoffGrowth: 2,
      maxBackoffMs: 15 * 60_000,
      ...rest,
      service: 'NetEase Cloud Music',
      headers: { Referer: 'https://music.163.com/' },
    });
  }

  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  private async songs(keywords: string): Promise<NeteaseSong[]> {
    const json = obj(
      await this.http.getJson(`${this.baseUrl}/api/search/get`, {
        s: keywords,
        type: '1',
        offset: '0',
        limit: '10',
      }),
    );
    if (!json) throw this.http.badResponse();
    // e.g. -460 for requests the service does not want: do not keep asking.
    if (num(json.code) !== 200) throw this.http.pause('unavailable');
    return arr(obj(json.result)?.songs)
      .map(toNeteaseSong)
      .filter((s): s is NeteaseSong => s !== null);
  }

  async find(q: OnlineLyricsQuery): Promise<OnlineLyrics | null> {
    const title = titleVariants(q.trackName).at(-1) ?? q.trackName;
    const artist = artistVariants(q.artistName).at(-1) ?? q.artistName;
    const fits = (await this.songs(`${title} ${artist}`))
      .filter((s) => sameTrack(s, q))
      .sort((a, b) => durationDistance(a, q) - durationDistance(b, q));
    // At most two lyric requests for one track.
    for (const song of fits.slice(0, 2)) {
      const lyrics = await this.fetch(String(song.id));
      if (hasContent(lyrics)) return lyrics;
    }
    return null;
  }

  async search(q: OnlineLyricsSearch): Promise<OnlineLyricsCandidate[]> {
    const text = searchText(q);
    if (!text) return [];
    return (await this.songs(text)).map((s) => ({
      provider: this.id,
      ref: String(s.id),
      trackName: s.trackName,
      artistName: s.artistName,
      albumName: s.albumName,
      durationSec: s.durationSec ?? null,
      synced: null,
      instrumental: false,
      lyrics: null,
    }));
  }

  async fetch(ref: string): Promise<OnlineLyrics | null> {
    if (!/^\d{1,15}$/.test(ref)) return null;
    const json = await this.http.getJson(`${this.baseUrl}/api/song/lyric`, {
      id: ref,
      lv: '1',
      kv: '1',
      tv: '-1',
    });
    if (json === null) return null;
    const o = obj(json);
    if (!o) throw this.http.badResponse();
    if (num(o.code) !== 200) throw this.http.pause('unavailable');
    return neteaseLyrics(o);
  }
}

// ---------------------------------------------------------------------------------------- Kugou

interface KugouCandidate extends TrackSignature {
  id: string;
  accessKey: string;
  score: number;
}

export function toKugouCandidate(v: unknown): KugouCandidate | null {
  const o = obj(v);
  const id = str(o?.id) || (num(o?.id) !== null ? String(o?.id) : '');
  const accessKey = str(o?.accesskey);
  if (!o || !/^\d{1,20}$/.test(id) || !/^[A-Za-z0-9]{1,64}$/.test(accessKey)) return null;
  const ms = num(o.duration);
  return {
    id,
    accessKey,
    trackName: str(o.song),
    artistName: str(o.singer),
    durationSec: ms !== null && ms > 0 ? ms / 1000 : null,
    score: num(o.score) ?? 0,
  };
}

/** Decode base64 → UTF-8 text without Node-only APIs. */
export function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

export class KugouProvider implements OnlineLyricsProvider {
  readonly id = 'kugou';
  private readonly http: PoliteHttp;
  private readonly baseUrl: string;

  constructor(opts: OnlineProviderHttpOptions & { baseUrl?: string }) {
    const { baseUrl, ...rest } = opts;
    this.baseUrl = (baseUrl ?? 'https://lyrics.kugou.com').replace(/\/$/, '');
    this.http = new PoliteHttp({
      errorBackoffGrowth: 2,
      maxBackoffMs: 15 * 60_000,
      ...rest,
      service: 'Kugou',
    });
  }

  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  private async candidates(keyword: string, durationSec?: number | null) {
    const json = obj(
      await this.http.getJson(`${this.baseUrl}/search`, {
        ver: '1',
        man: 'yes',
        client: 'pc',
        keyword,
        duration: durationSec ? String(Math.round(durationSec * 1000)) : '',
        hash: '',
      }),
    );
    if (!json) throw this.http.badResponse();
    if (num(json.status) !== 200) throw this.http.pause('unavailable');
    return arr(json.candidates)
      .map(toKugouCandidate)
      .filter((c): c is KugouCandidate => c !== null);
  }

  /** Kugou's lyric search wants "artist - title". */
  async find(q: OnlineLyricsQuery): Promise<OnlineLyrics | null> {
    const title = titleVariants(q.trackName).at(-1) ?? q.trackName;
    const artist = artistVariants(q.artistName).at(-1) ?? q.artistName;
    const fits = (await this.candidates(`${artist} - ${title}`, q.durationSec))
      .filter((c) => sameTrack(c, q))
      .sort((a, b) => durationDistance(a, q) - durationDistance(b, q) || b.score - a.score);
    const best = fits[0];
    return best ? this.fetch(`${best.id}:${best.accessKey}`) : null;
  }

  async search(q: OnlineLyricsSearch): Promise<OnlineLyricsCandidate[]> {
    const text = searchText(q, ' - ');
    if (!text) return [];
    return (await this.candidates(text)).map((c) => ({
      provider: this.id,
      ref: `${c.id}:${c.accessKey}`,
      trackName: c.trackName,
      artistName: c.artistName,
      albumName: '',
      durationSec: c.durationSec ?? null,
      synced: true,
      instrumental: false,
      lyrics: null,
    }));
  }

  async fetch(ref: string): Promise<OnlineLyrics | null> {
    const m = /^(\d{1,20}):([A-Za-z0-9]{1,64})$/.exec(ref);
    if (!m) return null;
    const json = await this.http.getJson(`${this.baseUrl}/download`, {
      ver: '1',
      client: 'pc',
      id: m[1]!,
      accesskey: m[2]!,
      fmt: 'lrc',
      charset: 'utf8',
    });
    if (json === null) return null;
    const o = obj(json);
    if (!o) throw this.http.badResponse();
    if (num(o.status) !== 200) return null; // this candidate is gone
    const text = decodeBase64Utf8(str(o.content));
    return text === null ? null : lyricsFromText(text);
  }
}

// ----------------------------------------------------------------------------------- lyrics.ovh

/** lyrics.ovh sometimes prefixes the text with a French credit line; drop it. */
export function lyricsOvhText(v: unknown): OnlineLyrics | null {
  const text = str(obj(v)?.lyrics).replace(/^Paroles de la chanson .*\r?\n/i, '');
  const clean = text.replace(/\r\n|\r/g, '\n').trim();
  // The source has no time codes; if some text carries LRC tags anyway, keep it as it is.
  return clean ? lyricsFromText(clean) : null;
}

export class LyricsOvhProvider implements OnlineLyricsProvider {
  readonly id = 'lyricsovh';
  private readonly http: PoliteHttp;
  private readonly baseUrl: string;

  constructor(opts: OnlineProviderHttpOptions & { baseUrl?: string }) {
    const { baseUrl, ...rest } = opts;
    this.baseUrl = (baseUrl ?? 'https://api.lyrics.ovh').replace(/\/$/, '');
    this.http = new PoliteHttp({
      errorBackoffGrowth: 2,
      maxBackoffMs: 15 * 60_000,
      ...rest,
      service: 'lyrics.ovh',
    });
  }

  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  private async get(artist: string, title: string): Promise<OnlineLyrics | null> {
    // The path separator cannot be part of a name here.
    if (/[/\\]/.test(artist + title)) return null;
    const json = await this.http.getJson(
      `${this.baseUrl}/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
    );
    return json === null ? null : lyricsOvhText(json);
  }

  /** Lookup by exact names: as tagged, then cleaned title + first credited artist. */
  async find(q: OnlineLyricsQuery): Promise<OnlineLyrics | null> {
    const found = await this.get(q.artistName, q.trackName);
    if (found) return found;
    const title = titleVariants(q.trackName).at(-1) ?? q.trackName;
    const artist = artistVariants(q.artistName).at(-1) ?? q.artistName;
    if (normName(title) === normName(q.trackName) && normName(artist) === normName(q.artistName)) {
      return null;
    }
    return this.get(artist, title);
  }

  async search(q: OnlineLyricsSearch): Promise<OnlineLyricsCandidate[]> {
    const text = searchText(q);
    if (!text) return [];
    const json = obj(
      await this.http.getJson(`${this.baseUrl}/suggest/${encodeURIComponent(text)}`),
    );
    if (!json) return [];
    const out: OnlineLyricsCandidate[] = [];
    for (const item of arr(json.data).slice(0, 10)) {
      const o = obj(item);
      const title = str(o?.title);
      const artist = str(obj(o?.artist)?.name);
      if (!title || !artist) continue;
      out.push({
        provider: this.id,
        ref: JSON.stringify([artist, title]),
        trackName: title,
        artistName: artist,
        albumName: str(obj(o?.album)?.title),
        durationSec: num(o?.duration),
        synced: false,
        instrumental: false,
        lyrics: null,
      });
    }
    return out;
  }

  async fetch(ref: string): Promise<OnlineLyrics | null> {
    let parts: unknown;
    try {
      parts = JSON.parse(ref);
    } catch {
      return null;
    }
    if (!Array.isArray(parts) || parts.length !== 2) return null;
    const [artist, title] = parts as unknown[];
    if (typeof artist !== 'string' || typeof title !== 'string' || !artist || !title) return null;
    return this.get(artist, title);
  }
}

// ------------------------------------------------------------------------------------- registry

export interface OnlineLyricsProvidersOptions extends OnlineProviderHttpOptions {
  /** Reuse an existing LRCLIB client (tests). */
  lrclib?: LrclibClient;
}

/** All known sources, in the order they are tried. */
export function createOnlineLyricsProviders(
  opts: OnlineLyricsProvidersOptions,
): OnlineLyricsProvider[] {
  const { lrclib, ...http } = opts;
  return [
    new LrclibProvider(lrclib ?? new LrclibClient(http)),
    new NeteaseProvider(http),
    new KugouProvider(http),
    new LyricsOvhProvider(http),
  ];
}
