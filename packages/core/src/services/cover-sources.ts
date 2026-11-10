import type { CoverCandidate, CoverProviderId } from '@hqps/contracts';
import {
  cleanTitle,
  firstArtist,
  normName,
  OnlineUnavailableError,
  PoliteHttp,
  type PoliteHttpOptions,
} from '@hqps/lyrics';
import type { MusicBrainzClient } from './online-albums';

/**
 * Online cover sources (opt-in, Settings → 音乐库 → 封面). A lookup sends an album's title and
 * album artist to the source — never file paths — and the chosen image is then downloaded from
 * that source's own image host. All three have documented public APIs:
 *
 *  - `itunes`      — Apple's iTunes Search API; images on *.mzstatic.com.
 *  - `deezer`      — the Deezer API; images on *.dzcdn.net.
 *  - `musicbrainz` — MusicBrainz release search + the Cover Art Archive (images on archive.org).
 *
 * Image URLs are never taken from a client as they are: a candidate's `ref` is validated and the
 * URL rebuilt from it, and every download (redirects included) must stay on the source's hosts.
 */
export interface CoverSource {
  readonly id: CoverProviderId;
  /** Milliseconds until this source may be asked again (0 = now). */
  blockedForMs(): number;
  search(q: CoverSearch): Promise<CoverCandidate[]>;
  /** Image URLs behind a candidate's `ref`, best first; null when the ref is not this source's. */
  imageUrls(ref: string, size: 'thumb' | 'full'): string[] | null;
  /** May an image (or a redirect on the way to it) be fetched from this host? */
  allowsImageHost(hostname: string): boolean;
}

export type CoverSearch = { text: string } | { album: string; artist: string | null };

type HttpOptions = Omit<PoliteHttpOptions, 'service' | 'headers'>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const searchText = (q: CoverSearch): string =>
  'text' in q ? q.text.trim() : [q.artist, q.album].filter(Boolean).join(' ').trim();

const hostIs = (hostname: string, ...domains: string[]): boolean =>
  domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));

// --------------------------------------------------------------------------------------- iTunes

const ITUNES_ART =
  /^(https:\/\/[a-z0-9-]+\.mzstatic\.com\/[^?#\s]+\/)\d{2,4}x\d{2,4}bb\.(jpg|png)$/;

export class ItunesCoverSource implements CoverSource {
  readonly id = 'itunes';
  private readonly http: PoliteHttp;

  constructor(opts: HttpOptions) {
    // Apple asks for roughly 20 requests a minute at most.
    this.http = new PoliteHttp({
      minIntervalMs: 3000,
      errorBackoffGrowth: 2,
      maxBackoffMs: 15 * 60_000,
      ...opts,
      service: 'iTunes Search',
    });
  }

  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  async search(q: CoverSearch): Promise<CoverCandidate[]> {
    const term = searchText(q);
    if (!term) return [];
    const json = obj(
      await this.http.getJson('https://itunes.apple.com/search', {
        term,
        media: 'music',
        entity: 'album',
        limit: '10',
      }),
    );
    if (!json) throw this.http.badResponse();
    const out: CoverCandidate[] = [];
    for (const item of arr(json.results)) {
      const o = obj(item);
      const ref = str(o?.artworkUrl100);
      if (!o || !ITUNES_ART.test(ref)) continue;
      const year = Number(str(o.releaseDate).slice(0, 4));
      out.push({
        provider: this.id,
        ref,
        title: str(o.collectionName),
        artist: str(o.artistName),
        year: Number.isInteger(year) && year > 0 ? year : null,
        trackCount: int(o.trackCount),
      });
    }
    return out;
  }

  imageUrls(ref: string, size: 'thumb' | 'full'): string[] | null {
    const m = ITUNES_ART.exec(ref);
    if (!m) return null;
    const px = size === 'thumb' ? 200 : 1000;
    return [`${m[1]}${px}x${px}bb.${m[2]}`];
  }

  allowsImageHost(hostname: string): boolean {
    return hostIs(hostname, 'mzstatic.com');
  }
}

// --------------------------------------------------------------------------------------- Deezer

const DEEZER_REF = /^[a-f0-9]{32}$/;

export class DeezerCoverSource implements CoverSource {
  readonly id = 'deezer';
  private readonly http: PoliteHttp;

  constructor(opts: HttpOptions) {
    this.http = new PoliteHttp({
      errorBackoffGrowth: 2,
      maxBackoffMs: 15 * 60_000,
      ...opts,
      service: 'Deezer',
    });
  }

  blockedForMs(): number {
    return this.http.blockedForMs();
  }

  async search(q: CoverSearch): Promise<CoverCandidate[]> {
    const text = searchText(q);
    if (!text) return [];
    const json = obj(
      await this.http.getJson('https://api.deezer.com/search/album', { q: text, limit: '10' }),
    );
    if (!json) throw this.http.badResponse();
    // Deezer reports quota and other errors inside a 200 answer.
    if (json.error) throw this.http.pause('rate_limited', 10_000);
    const out: CoverCandidate[] = [];
    for (const item of arr(json.data)) {
      const o = obj(item);
      const ref = str(o?.md5_image);
      if (!o || !DEEZER_REF.test(ref)) continue;
      out.push({
        provider: this.id,
        ref,
        title: str(o.title),
        artist: str(obj(o.artist)?.name),
        year: null,
        trackCount: int(o.nb_tracks),
      });
    }
    return out;
  }

  imageUrls(ref: string, size: 'thumb' | 'full'): string[] | null {
    if (!DEEZER_REF.test(ref)) return null;
    const px = size === 'thumb' ? 250 : 1000;
    return [`https://cdn-images.dzcdn.net/images/cover/${ref}/${px}x${px}-000000-80-0-0.jpg`];
  }

  allowsImageHost(hostname: string): boolean {
    return hostIs(hostname, 'dzcdn.net');
  }
}

// ------------------------------------------------------------- MusicBrainz + Cover Art Archive

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Releases come from MusicBrainz (the same rate-limited client as the album check), the image
 * from the Cover Art Archive. Many releases have no cover there; those answer 404.
 */
export class MusicBrainzCoverSource implements CoverSource {
  readonly id = 'musicbrainz';
  private blockedUntil = 0;

  constructor(
    private readonly client: MusicBrainzClient,
    private readonly now: () => number = Date.now,
  ) {}

  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  async search(q: CoverSearch): Promise<CoverCandidate[]> {
    const blocked = this.blockedForMs();
    if (blocked > 0) {
      throw new OnlineUnavailableError('unavailable', blocked, 'MusicBrainz paused');
    }
    const text = searchText(q);
    if (!text) return [];
    let releases;
    try {
      releases = await this.client.findReleases(
        'text' in q ? { text } : { title: q.album, artist: q.artist },
      );
    } catch {
      this.blockedUntil = this.now() + 30_000;
      throw new OnlineUnavailableError(
        'unavailable',
        30_000,
        'MusicBrainz is not reachable right now',
      );
    }
    return releases
      .filter((r) => MBID.test(r.id))
      .map((r) => ({
        provider: this.id,
        ref: r.id,
        title: r.title,
        artist: r.artist,
        year: r.year,
        trackCount: r.trackCount,
      }));
  }

  imageUrls(ref: string, size: 'thumb' | 'full'): string[] | null {
    if (!MBID.test(ref)) return null;
    const base = `https://coverartarchive.org/release/${ref}/front`;
    return size === 'thumb' ? [`${base}-250`] : [`${base}-1200`, `${base}-500`];
  }

  allowsImageHost(hostname: string): boolean {
    return hostIs(hostname, 'coverartarchive.org', 'archive.org');
  }
}

export function createCoverSources(
  http: HttpOptions,
  musicbrainz: MusicBrainzClient,
): CoverSource[] {
  return [
    new ItunesCoverSource(http),
    new DeezerCoverSource(http),
    new MusicBrainzCoverSource(musicbrainz, http.now),
  ];
}

// ------------------------------------------------------------------------------------- matching

const VARIOUS = /^(various(artists)?|va|群星|合辑|合輯|unknownartist|未知艺术家|未知藝術家)$/;

/** The album artist when it identifies someone; null for "Various Artists" / unknown. */
export function usableAlbumArtist(artist: string): string | null {
  const a = artist.trim();
  return a && !VARIOUS.test(normName(a)) ? a : null;
}

export interface CoverWanted {
  album: string;
  /** Null for compilations / unknown artists. */
  artist: string | null;
  trackCount: number;
}

/**
 * Candidates that are the wanted album, best first. The title must match (decorations such as
 * "(Deluxe Edition)" or "(Remastered 2009)" aside) and so must the artist; without a usable
 * artist (compilations) the track count has to be the same instead. An equal or close track
 * count ranks a candidate higher.
 */
export function rankCovers(hits: readonly CoverCandidate[], wanted: CoverWanted): CoverCandidate[] {
  const title = normName(cleanTitle(wanted.album));
  if (!title) return [];
  const artists = wanted.artist
    ? [...new Set([wanted.artist, firstArtist(wanted.artist)].map(normName))].filter(Boolean)
    : [];
  const scored: { hit: CoverCandidate; score: number; order: number }[] = [];
  hits.forEach((hit, order) => {
    if (normName(cleanTitle(hit.title)) !== title) return;
    const sameCount = hit.trackCount !== null && hit.trackCount === wanted.trackCount;
    if (artists.length > 0) {
      const theirs = [...new Set([hit.artist, firstArtist(hit.artist)].map(normName))].filter(
        Boolean,
      );
      if (!artists.some((a) => theirs.some((b) => a.includes(b) || b.includes(a)))) return;
    } else if (!sameCount) {
      return;
    }
    const close = hit.trackCount !== null && Math.abs(hit.trackCount - wanted.trackCount) <= 2;
    scored.push({ hit, score: sameCount ? 2 : close ? 1 : 0, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.hit);
}

// ----------------------------------------------------------------------------- image downloads

export interface ImageDownloadOptions {
  fetch: typeof fetch;
  userAgent: string;
  allowsHost: (hostname: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** What the bytes are, judged by their signature (the Content-Type header is not trusted). */
export function sniffImageMime(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  const ascii = (from: number, text: string) =>
    [...text].every((ch, i) => b[from + i] === ch.charCodeAt(0));
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/**
 * Download one image. HTTPS only; every hop (redirects are followed by hand, at most four) must
 * be on an allowed host; the body is capped and must really be a JPEG, PNG or WebP. Returns null
 * when the source has no such image (404) or it is not a usable picture; throws
 * OnlineUnavailableError when the host cannot be reached.
 */
export async function downloadImage(
  url: string,
  opts: ImageDownloadOptions,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024;
  const unavailable = () =>
    new OnlineUnavailableError('unavailable', 30_000, 'The cover image could not be downloaded');
  let next = url;
  for (let hop = 0; hop < 5; hop += 1) {
    let target: URL;
    try {
      target = new URL(next);
    } catch {
      return null;
    }
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443') ||
      !opts.allowsHost(target.hostname)
    ) {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    try {
      let res: Response;
      try {
        res = await opts.fetch(target, {
          method: 'GET',
          headers: { 'User-Agent': opts.userAgent, Accept: 'image/jpeg, image/png, image/webp' },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        throw unavailable();
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location) return null;
        next = new URL(location, target).toString();
        continue;
      }
      if (res.status === 404 || res.status === 410 || res.status === 400) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, maxBytes);
      } catch {
        throw unavailable();
      }
      const mime = bytes.byteLength > 0 ? sniffImageMime(bytes) : null;
      return mime ? { bytes, mime } : null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // too many redirects
}

/** The response body, or an empty array when it is larger than `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return new Uint8Array(0);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
