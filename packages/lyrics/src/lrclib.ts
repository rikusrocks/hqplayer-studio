/**
 * Minimal LRCLIB client (https://lrclib.net). Used only when the user turned online lyrics on
 * (Settings → 歌词, off by default): every request sends the track's title, artist, album and
 * duration to a third-party service.
 *
 * House rules, from the handoff (§8.4) and LRCLIB's guidance:
 *  - identify the app with a User-Agent (name + version; no homepage link, which would carry the
 *    maintainer's account name);
 *  - one request at a time and at least `minIntervalMs` between requests — never a burst;
 *  - honour 429 + Retry-After; after errors back off instead of retrying immediately;
 *  - never log or return response bodies in errors (they contain lyrics).
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

export type LrclibFailure = 'rate_limited' | 'unavailable' | 'bad_response';

/** LRCLIB could not answer right now. `retryAfterMs`: when the client will send again. */
export class LrclibUnavailableError extends Error {
  constructor(
    readonly reason: LrclibFailure,
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
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

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

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
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private blockedReason: LrclibFailure = 'unavailable';
  /** Requests actually sent (tests / diagnostics). */
  requestCount = 0;

  constructor(private readonly opts: LrclibClientOptions) {
    this.baseUrl = (opts.baseUrl ?? LRCLIB_BASE_URL).replace(/\/$/, '');
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Milliseconds until the client sends again (0 = not backing off). */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Exact lookup by signature. Null when LRCLIB has no lyrics for it (404). */
  get(q: LrclibQuery): Promise<LrclibRecord | null> {
    const params: Record<string, string> = {
      track_name: q.trackName,
      artist_name: q.artistName,
    };
    if (q.albumName) params.album_name = q.albumName;
    if (q.durationSec) params.duration = String(Math.round(q.durationSec));
    return this.enqueue(async () => {
      const json = await this.request('/api/get', params);
      if (json === null) return null;
      const rec = toLrclibRecord(json);
      if (!rec) throw this.badResponse();
      return rec;
    });
  }

  getById(id: number): Promise<LrclibRecord | null> {
    return this.enqueue(async () => {
      const json = await this.request(`/api/get/${encodeURIComponent(String(id))}`, {});
      if (json === null) return null;
      const rec = toLrclibRecord(json);
      if (!rec) throw this.badResponse();
      return rec;
    });
  }

  /** Free-text / field search (LRCLIB returns at most ~20 records). */
  search(q: { q?: string; trackName?: string; artistName?: string; albumName?: string }) {
    const params: Record<string, string> = {};
    if (q.q) params.q = q.q;
    if (q.trackName) params.track_name = q.trackName;
    if (q.artistName) params.artist_name = q.artistName;
    if (q.albumName) params.album_name = q.albumName;
    return this.enqueue(async (): Promise<LrclibRecord[]> => {
      const json = await this.request('/api/search', params);
      if (json === null) return [];
      if (!Array.isArray(json)) throw this.badResponse();
      return json.map(toLrclibRecord).filter((r): r is LrclibRecord => r !== null);
    });
  }

  private badResponse(): LrclibUnavailableError {
    return new LrclibUnavailableError('bad_response', 0, 'LRCLIB returned an unexpected response');
  }

  /** One request at a time, spaced out; back-off windows fail fast without traffic. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const blocked = this.blockedForMs();
      if (blocked > 0) {
        throw new LrclibUnavailableError(
          this.blockedReason,
          blocked,
          `LRCLIB paused for ${Math.ceil(blocked / 1000)} s`,
        );
      }
      const wait = this.lastStart + (this.opts.minIntervalMs ?? 1000) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return fn();
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private backOff(reason: LrclibFailure, ms: number): LrclibUnavailableError {
    const capped = Math.min(Math.max(ms, 1000), this.opts.maxBackoffMs ?? 3_600_000);
    this.blockedUntil = this.now() + capped;
    this.blockedReason = reason;
    return new LrclibUnavailableError(
      reason,
      capped,
      reason === 'rate_limited'
        ? 'LRCLIB asked us to slow down (429)'
        : 'LRCLIB is not reachable right now',
    );
  }

  /** GET → parsed JSON, or null for 404. Throws LrclibUnavailableError otherwise. */
  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      this.requestCount += 1;
      res = await this.doFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw this.backOff('unavailable', this.opts.errorBackoffMs ?? 30_000);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const after = parseRetryAfter(res.headers.get('retry-after'), this.now());
      throw this.backOff('rate_limited', after ?? this.opts.defaultRetryAfterMs ?? 60_000);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // 503 may carry Retry-After as well.
      const after = parseRetryAfter(res.headers.get('retry-after'), this.now());
      throw this.backOff('unavailable', after ?? this.opts.errorBackoffMs ?? 30_000);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw this.badResponse();
    }
  }
}

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

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
