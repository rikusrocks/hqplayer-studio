import type {
  AlbumCover,
  CoverCandidate,
  CoverProviderId,
  CoverSettings,
  StudioEvent,
} from '@hqps/contracts';
import {
  findLocalArtwork,
  readEmbeddedPicture,
  type AlbumCoverTarget,
  type LibraryContext,
} from '@hqps/library';
import { OnlineUnavailableError } from '@hqps/lyrics';
import type { EventHub } from '../event-hub';
import { HttpError } from '../http/errors';
import { COVERS_ONLINE_SETTING, COVERS_PROVIDERS_SETTING } from '../settings-keys';
import {
  createCoverSources,
  downloadImage,
  rankCovers,
  usableAlbumArtist,
  type CoverSource,
} from './cover-sources';
import { studioUserAgent } from './lyrics-service';
import type { MusicBrainzClient } from './online-albums';

export interface CoverServiceOptions {
  appVersion: string;
  /** Shared with the album check so MusicBrainz sees one polite client. */
  musicbrainz: MusicBrainzClient;
  fetch?: typeof fetch;
  /** All cover sources in the order they are tried (tests). Default: the built-in ones. */
  sources?: CoverSource[];
  readPicture?: (file: string) => Promise<{ data: Uint8Array; mime: string } | null>;
  /** How long "no cover found" is trusted before an album is looked up again. Default 30 days. */
  notFoundTtlMs?: number;
  now?: () => number;
}

/** What `online_lookups` remembers per album (`cover:<albumId>`). */
interface CoverLookup {
  found: boolean;
  provider?: CoverProviderId;
  /** The user chose this by hand (a picked cover, or "remove the online cover"). */
  manual?: boolean;
}

const NOT_FOUND = 'cover-none';
const lookupKey = (albumId: string) => `cover:${albumId}`;
const MAX_CANDIDATES_PER_SOURCE = 10;
/** Images tried per source for one album (many MusicBrainz releases have no cover). */
const MAX_IMAGE_TRIES = 3;
const PREVIEW_CACHE_SIZE = 80;

/**
 * Album covers beyond what is on disk (handoff §8.1/§12): opt-in lookups at iTunes, Deezer and
 * MusicBrainz / Cover Art Archive for albums that have no cover in their folder or tags.
 *
 * Off by default. When on, Studio looks up — by itself — only the album that is playing and has
 * no cover; everything else needs the user: picking a cover for one album, or starting "find
 * covers for all albums without one" (a paced background job). Only album title + album artist
 * are sent, never paths. A cover found on disk is never replaced automatically.
 */
export class CoverService {
  private readonly sources: CoverSource[];
  private readonly doFetch: typeof fetch;
  private readonly userAgent: string;
  private readonly now: () => number;
  private readonly readPicture: NonNullable<CoverServiceOptions['readPicture']>;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly previews = new Map<string, { bytes: Uint8Array; mime: string }>();
  private readonly unsubscribe: () => void;
  private lastTrackId: string | null = null;
  private fill = { running: false, done: 0, total: 0, found: 0, finishedAt: null as number | null };
  private fillAbort: AbortController | null = null;
  private fillDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    private readonly opts: CoverServiceOptions,
  ) {
    this.userAgent = studioUserAgent(opts.appVersion);
    this.doFetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = opts.now ?? Date.now;
    this.readPicture = opts.readPicture ?? readEmbeddedPicture;
    this.sources =
      opts.sources ??
      createCoverSources(
        { userAgent: this.userAgent, fetch: this.doFetch, now: this.now },
        opts.musicbrainz,
      );
    this.unsubscribe = hub.subscribe((e) => this.onEvent(e));
  }

  /** Stop listening and cancel a running "find all" job. */
  async stop(): Promise<void> {
    this.unsubscribe();
    this.fillAbort?.abort();
    await this.fillDone;
  }

  onlineEnabled(): boolean {
    return this.ctx.settings.get<boolean>(COVERS_ONLINE_SETTING, false) === true;
  }

  /** The sources the user left switched on (all, unless chosen otherwise), in order. */
  private enabledSources(): CoverSource[] {
    const saved = this.ctx.settings.get<unknown>(COVERS_PROVIDERS_SETTING, null);
    if (!Array.isArray(saved)) return this.sources;
    const ids = new Set<unknown>(saved);
    return this.sources.filter((s) => ids.has(s.id));
  }

  settings(): CoverSettings {
    const enabled = this.enabledSources();
    return {
      online: this.onlineEnabled(),
      providers: this.sources.map((s) => ({
        id: s.id,
        enabled: enabled.includes(s),
        pausedForMs: Math.round(s.blockedForMs()),
      })),
      missing: this.ctx.library.albumIdsWithoutArtwork().length,
      fill: { ...this.fill },
    };
  }

  update(change: { online?: boolean; providers?: CoverProviderId[] }): CoverSettings {
    if (change.online !== undefined) {
      this.ctx.settings.set(COVERS_ONLINE_SETTING, change.online);
      if (!change.online) this.fillAbort?.abort();
      // Switched on while something plays: let the next status event look its album up.
      this.lastTrackId = null;
    }
    if (change.providers !== undefined) {
      const wanted = new Set(change.providers);
      this.ctx.settings.set(
        COVERS_PROVIDERS_SETTING,
        this.sources.map((s) => s.id).filter((id) => wanted.has(id)),
      );
      // Another set of sources may know albums the previous one did not.
      this.ctx.library.deleteOnlineLookups(NOT_FOUND);
    }
    return this.settings();
  }

  /** Albums at every enabled source for manual matching (this computer only). */
  async search(albumId: string, q?: string): Promise<CoverCandidate[]> {
    const target = this.ctx.library.getAlbumCoverTarget(albumId); // 404 for unknown albums
    const sources = this.requireOnline();
    const text = q?.trim();
    const query = text
      ? { text }
      : { album: target.title.trim(), artist: usableAlbumArtist(target.albumArtist) };
    const answers = await Promise.allSettled(sources.map((s) => s.search(query)));
    const out: CoverCandidate[] = [];
    let unavailable: OnlineUnavailableError | null = null;
    let answered = 0;
    for (const a of answers) {
      if (a.status === 'fulfilled') {
        answered += 1;
        out.push(...a.value.slice(0, MAX_CANDIDATES_PER_SOURCE));
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

  /** A small version of a candidate's cover, for the picker (fetched by Core, not the page). */
  async preview(
    provider: CoverProviderId,
    ref: string,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const source = this.requireSource(provider);
    const key = `${provider}\u0000${ref}`;
    const cached = this.previews.get(key);
    if (cached) return cached;
    const image = await this.imageForUser(source, ref, 'thumb');
    if (!image) throw new HttpError(404, 'not_found', 'The source has no cover for this album');
    if (this.previews.size >= PREVIEW_CACHE_SIZE) {
      this.previews.delete(this.previews.keys().next().value as string);
    }
    this.previews.set(key, image);
    return image;
  }

  /** Use a candidate's cover for this album from now on. */
  async select(albumId: string, provider: CoverProviderId, ref: string): Promise<AlbumCover> {
    this.ctx.library.getAlbumCoverTarget(albumId);
    const source = this.requireSource(provider);
    const image = await this.imageForUser(source, ref, 'full');
    const artworkId = image ? this.ctx.artwork.put(image.bytes, image.mime, 'online') : null;
    if (!artworkId) throw new HttpError(404, 'not_found', 'The source has no cover for this album');
    this.ctx.library.setAlbumArtwork(albumId, artworkId);
    this.ctx.library.setOnlineLookup(
      lookupKey(albumId),
      provider,
      { found: true, provider, manual: true } satisfies CoverLookup,
      this.now(),
    );
    this.changed();
    return this.cover(albumId);
  }

  /**
   * Drop the album's cover and look in its folder and tags again: undoes an online cover and
   * picks up an image that was added to the folder later. Nothing is asked online, and the
   * album is not looked up automatically afterwards.
   */
  async reset(albumId: string): Promise<AlbumCover> {
    const target = this.ctx.library.getAlbumCoverTarget(albumId);
    if (target.isFixture) return this.cover(albumId); // demo covers are generated, not on disk
    const local =
      target.sourcePath && target.folderPath
        ? await findLocalArtwork({
            folderPath: target.folderPath,
            sourcePath: target.sourcePath,
            artwork: this.ctx.artwork,
            readPicture: this.readPicture,
          })
        : null;
    if (local) {
      this.ctx.library.setAlbumArtwork(albumId, local);
      this.ctx.library.deleteOnlineLookup(lookupKey(albumId));
    } else if (target.sourcePath) {
      this.ctx.library.clearAlbumArtwork(albumId);
      this.ctx.library.setOnlineLookup(
        lookupKey(albumId),
        'cover-reset',
        { found: false, manual: true } satisfies CoverLookup,
        this.now(),
      );
    }
    // Folder offline: keep what is shown rather than concluding "no cover".
    this.changed();
    return this.cover(albumId);
  }

  /** Start looking up every album without a cover (one at a time, paced by the sources). */
  startFill(): CoverSettings {
    this.requireOnline();
    if (this.fill.running) return this.settings();
    const ids = this.ctx.library.albumIdsWithoutArtwork();
    const abort = new AbortController();
    this.fillAbort = abort;
    this.fill = { running: true, done: 0, total: ids.length, found: 0, finishedAt: null };
    this.fillDone = (async () => {
      try {
        for (const id of ids) {
          if (abort.signal.aborted || !this.onlineEnabled()) break;
          // Every source is pausing: nothing can be asked, so stop instead of spinning.
          const sources = this.enabledSources();
          if (sources.length === 0 || sources.every((s) => s.blockedForMs() > 0)) break;
          try {
            if (await this.autoFetch(id)) this.fill.found += 1;
          } catch {
            // one album failing must not end the job
          }
          this.fill.done += 1;
        }
      } finally {
        this.fill = { ...this.fill, running: false, finishedAt: this.now() };
        if (this.fillAbort === abort) this.fillAbort = null;
      }
    })();
    return this.settings();
  }

  cancelFill(): CoverSettings {
    this.fillAbort?.abort();
    return this.settings();
  }

  /** Resolves when the "find all" job has ended (tests). */
  async fillIdle(): Promise<void> {
    await this.fillDone;
  }

  /** Resolves when automatic lookups that are under way have ended (tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }

  /**
   * Look an album without a cover up at the enabled sources and store the first cover that
   * matches. Returns whether a cover was stored. "Nothing found" is remembered, so an album is
   * asked about once in a while, not on every play.
   */
  autoFetch(albumId: string): Promise<boolean> {
    let p = this.inflight.get(albumId);
    if (!p) {
      p = this.lookUp(albumId).finally(() => this.inflight.delete(albumId));
      this.inflight.set(albumId, p);
    }
    return p;
  }

  // ------------------------------------------------------------------------------------------

  private onEvent(e: StudioEvent): void {
    let trackId: string | null | undefined;
    if (e.type === 'engine.status') trackId = e.status.track?.studioTrackId;
    else if (e.type === 'queue.changed') {
      trackId =
        e.queue.currentIndex === null ? null : e.queue.items[e.queue.currentIndex]?.track.id;
    } else return;
    if (!trackId || trackId === this.lastTrackId) return;
    this.lastTrackId = trackId;
    if (!this.onlineEnabled()) return;
    const albumId = this.ctx.library.albumIdOfTrack(trackId);
    if (albumId) void this.autoFetch(albumId).catch(() => undefined);
  }

  private async lookUp(albumId: string): Promise<boolean> {
    let target: AlbumCoverTarget;
    try {
      target = this.ctx.library.getAlbumCoverTarget(albumId);
    } catch {
      return false; // album gone
    }
    const sources = this.onlineEnabled() ? this.enabledSources() : [];
    const album = target.title.trim();
    if (target.artworkId || target.isFixture || sources.length === 0 || !album) return false;
    const cached = this.ctx.library.getOnlineLookup<CoverLookup>(lookupKey(albumId));
    if (cached && !cached.result.found) {
      const ttl = this.opts.notFoundTtlMs ?? 30 * 24 * 3_600_000;
      if (cached.result.manual || this.now() - cached.checkedAt < ttl) return false;
    }
    const wanted = {
      album,
      artist: usableAlbumArtist(target.albumArtist),
      trackCount: target.trackCount,
    };
    let unavailable = false;
    for (const source of sources) {
      let image: { bytes: Uint8Array; mime: string } | null = null;
      try {
        const hits = await source.search({ album: wanted.album, artist: wanted.artist });
        for (const hit of rankCovers(hits, wanted).slice(0, MAX_IMAGE_TRIES)) {
          image = await this.image(source, hit.ref, 'full');
          if (image) break;
        }
      } catch (err) {
        if (!(err instanceof OnlineUnavailableError)) throw err;
        unavailable = true;
        continue;
      }
      const artworkId = image ? this.ctx.artwork.put(image.bytes, image.mime, 'online') : null;
      if (!artworkId) continue;
      // A scan may have found a cover on disk meanwhile; that one stays.
      if (this.ctx.library.getAlbumCoverTarget(albumId).artworkId) return false;
      this.ctx.library.setAlbumArtwork(albumId, artworkId);
      this.ctx.library.setOnlineLookup(
        lookupKey(albumId),
        source.id,
        { found: true, provider: source.id } satisfies CoverLookup,
        this.now(),
      );
      this.changed();
      return true;
    }
    // Remember "nothing" only when every source really answered.
    if (!unavailable) {
      this.ctx.library.setOnlineLookup(
        lookupKey(albumId),
        NOT_FOUND,
        { found: false } satisfies CoverLookup,
        this.now(),
      );
    }
    return false;
  }

  private async image(source: CoverSource, ref: string, size: 'thumb' | 'full') {
    const urls = source.imageUrls(ref, size);
    if (!urls) throw new HttpError(400, 'invalid_request', 'Not a cover of this source');
    for (const url of urls) {
      const image = await downloadImage(url, {
        fetch: this.doFetch,
        userAgent: this.userAgent,
        allowsHost: (host) => source.allowsImageHost(host),
      });
      if (image) return image;
    }
    return null;
  }

  /** Like `image`, with outages reported the way the API reports them (503). */
  private async imageForUser(source: CoverSource, ref: string, size: 'thumb' | 'full') {
    try {
      return await this.image(source, ref, size);
    } catch (err) {
      throw err instanceof OnlineUnavailableError ? upstreamUnavailable(err) : err;
    }
  }

  private cover(albumId: string): AlbumCover {
    const t = this.ctx.library.getAlbumCoverTarget(albumId);
    // The lookup record says where the album's cover came from. (The artwork cache is keyed by
    // content, so the same image may also be known from a folder elsewhere.)
    const online = this.ctx.library.getOnlineLookup<CoverLookup>(lookupKey(albumId))?.result.found;
    return {
      albumId,
      artworkId: t.artworkId,
      origin: !t.artworkId ? null : online ? 'online' : 'local',
    };
  }

  private changed(): void {
    this.hub.publish({ type: 'library.changed', stats: this.ctx.library.stats() });
  }

  /** The enabled sources; 409 when online covers (or every source) are switched off. */
  private requireOnline(): CoverSource[] {
    const sources = this.onlineEnabled() ? this.enabledSources() : [];
    if (sources.length === 0) {
      throw new HttpError(409, 'conflict', 'Online covers are turned off', {
        reason: 'online_disabled',
      });
    }
    return sources;
  }

  private requireSource(provider: CoverProviderId): CoverSource {
    const source = this.requireOnline().find((s) => s.id === provider);
    if (!source) {
      throw new HttpError(409, 'conflict', 'This cover source is turned off', {
        reason: 'provider_disabled',
      });
    }
    return source;
  }
}

function upstreamUnavailable(err: OnlineUnavailableError): HttpError {
  return new HttpError(503, 'upstream_unavailable', 'Online covers are not available right now', {
    reason: err.reason,
    retryAfterMs: err.retryAfterMs,
  });
}
