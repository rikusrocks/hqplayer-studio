import {
  OnlineUnavailableError,
  PoliteHttp,
  parseRetryAfter,
  type OnlineFailure,
} from './polite-http';
import { normName } from './match';

/**
 * Minimal LRCLIB client (https://lrclib.net). Used only when the user turned online lyrics on
 * (Settings → 歌词, off by default): every request sends the track's title, artist, album and
 * duration to a third-party service. Rate limiting, back-off and the User-Agent are the shared
 * house rules in `PoliteHttp`.
 *
 * The caller decides *when* to ask (only for the track that is playing, never during scans).
 * No Node-only APIs: `fetch` is injected or global.
 */

export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  /** Seconds. */
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface LrclibQuery {
  trackName: string;
  artistName: string;
  albumName?: string | null;
  /** Track duration in seconds (LRCLIB matches within about ±2 s). */
  durationSec?: number | null;
}

export type LrclibFailure = OnlineFailure;

/** LRCLIB could not answer right now. `retryAfterMs`: when the client will send again. */
export class LrclibUnavailableError extends OnlineUnavailableError {
  constructor(reason: LrclibFailure, retryAfterMs: number, message: string) {
    super(reason, retryAfterMs, message);
    this.name = 'LrclibUnavailableError';
  }
}

export interface LrclibClientOptions {
  /** e.g. "HQPlayerStudio/0.3.0 (unofficial HQPlayer Desktop client)". */
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Abort a request after this long. Default 15 s (LRCLIB may consult external sources). */
  timeoutMs?: number;
  /** Minimum gap between the start of two requests. Default 1 s. */
  minIntervalMs?: number;
  /** Back-off after a 429 without Retry-After. Default 60 s. */
  defaultRetryAfterMs?: number;
  /** Back-off after a network error / 5xx. Default 30 s. */
  errorBackoffMs?: number;
  /** Upper bound for any back-off (a hostile Retry-After cannot park us for days). Default 1 h. */
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const LRCLIB_BASE_URL = 'https://lrclib.net';

export { parseRetryAfter };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Validate one record from LRCLIB; null if it does not look like one. */
export function toLrclibRecord(v: unknown): LrclibRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isFinite(o.id)) return null;
  return {
    id: o.id,
    trackName: str(o.trackName),
    artistName: str(o.artistName),
    albumName: str(o.albumName),
    duration: typeof o.duration === 'number' && Number.isFinite(o.duration) ? o.duration : null,
    instrumental: o.instrumental === true,
    plainLyrics: strOrNull(o.plainLyrics),
    syncedLyrics: strOrNull(o.syncedLyrics),
  };
}

export class LrclibClient {
  private readonly baseUrl: string;
  private readonly http: PoliteHttp;

  constructor(opts: LrclibClientOptions) {
    const { baseUrl, ...rest } = opts;
    this.baseUrl = (baseUrl ?? LRCLIB_BASE_URL).replace(/\/$/, '');
    this.http = new PoliteHttp({
      service: 'LRCLIB',
      ...rest,
      makeError: (reason, retryAfterMs, message) =>
        new LrclibUnavailableError(reason, retryAfterMs, message),
    });
  }

  /** Requests actually sent (tests / diagnostics). */
  get requestCount(): number {
    return this.http.requestCount;
  }

  /** Milliseconds until the client sends again (0 = not backing off). */
  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  /** Exact lookup by signature. Null when LRCLIB has no lyrics for it (404). */
  async get(q: LrclibQuery): Promise<LrclibRecord | null> {
    const params: Record<string, string> = {
      track_name: q.trackName,
      artist_name: q.artistName,
    };
    if (q.albumName) params.album_name = q.albumName;
    if (q.durationSec) params.duration = String(Math.round(q.durationSec));
    return this.record(await this.http.getJson(`${this.baseUrl}/api/get`, params));
  }

  async getById(id: number): Promise<LrclibRecord | null> {
    return this.record(
      await this.http.getJson(`${this.baseUrl}/api/get/${encodeURIComponent(String(id))}`),
    );
  }

  /** Free-text / field search (LRCLIB returns at most ~20 records). */
  async search(q: {
    q?: string;
    trackName?: string;
    artistName?: string;
    albumName?: string;
  }): Promise<LrclibRecord[]> {
    const params: Record<string, string> = {};
    if (q.q) params.q = q.q;
    if (q.trackName) params.track_name = q.trackName;
    if (q.artistName) params.artist_name = q.artistName;
    if (q.albumName) params.album_name = q.albumName;
    const json = await this.http.getJson(`${this.baseUrl}/api/search`, params);
    if (json === null) return [];
    if (!Array.isArray(json)) throw this.http.badResponse();
    return json.map(toLrclibRecord).filter((r): r is LrclibRecord => r !== null);
  }

  private record(json: unknown): LrclibRecord | null {
    if (json === null) return null;
    const rec = toLrclibRecord(json);
    if (!rec) throw this.http.badResponse();
    return rec;
  }
}

const norm = normName;

/**
 * Pick the record that matches a track best: names must match after normalisation, the duration
 * (when both are known) within ±2 s; synced lyrics win over plain ones. Null when nothing fits.
 */
export function pickBestRecord(
  records: readonly LrclibRecord[],
  q: LrclibQuery,
): LrclibRecord | null {
  const title = norm(q.trackName);
  const artist = norm(q.artistName);
  const fits = records.filter((r) => {
    if (norm(r.trackName) !== title) return false;
    const a = norm(r.artistName);
    if (artist && a && !a.includes(artist) && !artist.includes(a)) return false;
    if (q.durationSec && r.duration !== null && Math.abs(r.duration - q.durationSec) > 2) {
      return false;
    }
    return r.instrumental || r.syncedLyrics !== null || r.plainLyrics !== null;
  });
  const score = (r: LrclibRecord) =>
    (r.syncedLyrics ? 4 : r.plainLyrics ? 2 : 0) +
    (q.albumName && norm(r.albumName) === norm(q.albumName) ? 1 : 0);
  return [...fits].sort((a, b) => score(b) - score(a))[0] ?? null;
}
