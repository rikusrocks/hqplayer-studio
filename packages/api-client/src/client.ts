import {
  API_PREFIX,
  AlbumCoverSchema,
  AlbumDetailSchema,
  AlbumPageSchema,
  ApiErrorSchema,
  ArtistDetailSchema,
  ArtistPageSchema,
  CoverCandidateSchema,
  CoverSettingsSchema,
  DspStateSchema,
  EngineCapabilitiesSchema,
  EngineCommandResultSchema,
  EngineQueueSchema,
  EngineSettingsSchema,
  EngineStatusSchema,
  FolderListingSchema,
  HealthResponseSchema,
  LibraryRootSchema,
  LibrarySettingsSchema,
  LyricsCandidateSchema,
  LyricsSettingsSchema,
  TrackLyricsSchema,
  RemovedRootSchema,
  LibraryStatsSchema,
  PairResponseSchema,
  PairingCodeSchema,
  PairingStatusSchema,
  PlaylistDetailSchema,
  PlaylistSummarySchema,
  QueueStateSchema,
  RemoteSettingsSchema,
  ScanJobSchema,
  ServerInfoSchema,
  TrackPageSchema,
  WS_AUTH_PROTOCOL_PREFIX,
  WS_PROTOCOL,
  type AddPlaylistItemsRequest,
  type ApiErrorCode,
  type CoverProviderId,
  type CoverRef,
  type CreatePlaylistRequest,
  type FolderQuery,
  type LibraryQuery,
  type MockControlRequest,
  type OnlineLyricsProviderId,
  type PairRequest,
  type QueueAddRequest,
  type QueueReplaceRequest,
  type TransportAction,
  type UpdatePlaylistRequest,
  type UpdateRemoteSettingsRequest,
} from '@hqps/contracts';
import { z } from 'zod';

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network_error' | 'invalid_response',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StudioApiError';
  }
}

export interface StudioClientOptions {
  /** Origin of the Studio Core server. Empty string = same origin (default). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Web Remote on the LAN: the paired device token, sent as `Authorization: Bearer` (never in a
   * query string). Clients on the Studio computer itself need none.
   */
  getAuthToken?: () => string | null;
  /** Called when the server says this device is not (or no longer) paired. */
  onUnauthorized?: () => void;
}

/** Plain object of query parameters; undefined/null/empty values are omitted. */
type Query = object;

const OkSchema = z.object({ ok: z.literal(true) });

/** Page origin in a browser; undefined in Node (tests, tools). */
const pageOrigin = (): string | undefined =>
  (globalThis as { location?: { origin: string } }).location?.origin;

export function createStudioClient(options: StudioClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const authToken = () => options.getAuthToken?.() ?? null;

  async function request<T extends z.ZodType>(
    schema: T,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<z.infer<T>> {
    const url = new URL(`${baseUrl}${API_PREFIX}${path}`, baseUrl || pageOrigin());
    if (query) {
      for (const [k, v] of Object.entries(query) as [string, unknown][]) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = authToken();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new StudioApiError(0, 'network_error', (err as Error).message || 'Network error');
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new StudioApiError(res.status, 'invalid_response', 'Server returned non-JSON');
      }
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        if (res.status === 401 && e.code === 'unauthorized' && path !== '/remote/pair') {
          options.onUnauthorized?.();
        }
        throw new StudioApiError(res.status, e.code, e.message, e.details);
      }
      throw new StudioApiError(res.status, 'internal_error', `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new StudioApiError(
        res.status,
        'invalid_response',
        `Response for ${method} ${path} did not match contract`,
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  const get = <T extends z.ZodType>(schema: T, path: string, query?: Query) =>
    request(schema, 'GET', path, undefined, query);
  const post = <T extends z.ZodType>(schema: T, path: string, body: unknown = {}) =>
    request(schema, 'POST', path, body);
  const patch = <T extends z.ZodType>(schema: T, path: string, body: unknown) =>
    request(schema, 'PATCH', path, body);
  // Writes are JSON-only on the server (CSRF defence), so DELETE sends an empty JSON object too.
  const del = <T extends z.ZodType>(schema: T, path: string) => request(schema, 'DELETE', path, {});
  const enc = encodeURIComponent;

  return {
    baseUrl,
    artworkUrl(artworkId: string | null | undefined, size?: 'thumb' | 'full'): string | null {
      if (!artworkId) return null;
      const q = size ? `?size=${size}` : '';
      return `${baseUrl}${API_PREFIX}/artwork/${enc(artworkId)}${q}`;
    },
    eventsUrl(): string {
      const origin = baseUrl || pageOrigin() || 'http://127.0.0.1';
      return `${origin.replace(/^http/, 'ws')}${API_PREFIX}/events`;
    },
    /** WebSocket subprotocols: `hqps.v1`, plus the device token on the LAN. */
    eventsProtocols(): string[] {
      const token = authToken();
      return token ? [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`] : [WS_PROTOCOL];
    },

    health: () => get(HealthResponseSchema, '/health'),
    serverInfo: () => get(ServerInfoSchema, '/server-info'),

    engine: {
      status: () => get(EngineStatusSchema, '/engine/status'),
      capabilities: () => get(EngineCapabilitiesSchema, '/engine/capabilities'),
      transport: (action: TransportAction) =>
        post(EngineCommandResultSchema, '/engine/transport', { action }),
      seek: (positionMs: number) =>
        post(EngineCommandResultSchema, '/engine/seek', { positionMs: Math.round(positionMs) }),
      volume: (volumeDb: number) => post(EngineCommandResultSchema, '/engine/volume', { volumeDb }),
      dsp: () => get(DspStateSchema, '/engine/dsp'),
      /** HQPlayer's own playlist, read-only. */
      queue: () => get(EngineQueueSchema, '/engine/queue'),
      /** Privacy-safe diagnostics (this computer only): status + recent HQPlayer conversation. */
      diagnostics: () => get(z.record(z.string(), z.unknown()), '/engine/diagnostics'),
      mockControl: (action: MockControlRequest['action']) =>
        post(OkSchema, '/engine/mock', { action }),
    },

    settings: {
      engine: () => get(EngineSettingsSchema, '/settings/engine'),
      library: () => get(LibrarySettingsSchema, '/settings/library'),
      setOnlineAlbumCheck: (enabled: boolean) =>
        post(LibrarySettingsSchema, '/settings/library', { onlineAlbumCheck: enabled }),
      setEngine: (adapter: 'mock' | 'live') =>
        post(EngineSettingsSchema, '/settings/engine', { adapter }),
      /** “允许 Studio 控制 HQPlayer” — applies immediately, no restart. */
      setControl: (allowControl: boolean) =>
        post(EngineSettingsSchema, '/settings/engine', { allowControl }),
    },

    remote: {
      /** Is this client on the Studio computer, or a paired device? (no token needed to ask) */
      pairingStatus: () => get(PairingStatusSchema, '/remote/pairing-status'),
      /** LAN only: exchange a one-time code for this device's token. */
      pair: (req: PairRequest) => post(PairResponseSchema, '/remote/pair', req),
      /** LAN only: forget this device. */
      unpair: () => post(OkSchema, '/remote/unpair'),
      // --- Settings → 网页遥控 (this computer only)
      settings: () => get(RemoteSettingsSchema, '/remote/settings'),
      setSettings: (req: UpdateRemoteSettingsRequest) =>
        post(RemoteSettingsSchema, '/remote/settings', req),
      createPairingCode: () => post(PairingCodeSchema, '/remote/pairing-code'),
      cancelPairingCode: () => post(OkSchema, '/remote/pairing-code/cancel'),
      revokeDevice: (id: string) => post(OkSchema, `/remote/devices/${enc(id)}/revoke`),
    },

    library: {
      stats: () => get(LibraryStatsSchema, '/library/stats'),
      albums: (q: LibraryQuery = {}) => get(AlbumPageSchema, '/library/albums', q),
      album: (albumId: string) => get(AlbumDetailSchema, `/library/albums/${enc(albumId)}`),
      artists: (q: LibraryQuery = {}) => get(ArtistPageSchema, '/library/artists', q),
      artist: (artistId: string) => get(ArtistDetailSchema, `/library/artists/${enc(artistId)}`),
      tracks: (q: LibraryQuery = {}) => get(TrackPageSchema, '/library/tracks', q),
      folders: (q: FolderQuery = {}) => get(FolderListingSchema, '/library/folders', q),
      roots: () => get(z.array(LibraryRootSchema), '/library/roots'),
      addRoot: (path: string) => post(LibraryRootSchema, '/library/roots', { path }),
      /** Forget a folder and its songs (files on disk are not touched). */
      removeRoot: (id: string) => del(RemovedRootSchema, `/library/roots/${enc(id)}`),
      scan: (rootId?: string) => post(z.array(ScanJobSchema), '/library/scan', { rootId }),
      scanJobs: () => get(z.array(ScanJobSchema), '/library/scan'),
      scanJob: (jobId: string) => get(ScanJobSchema, `/library/scan/${enc(jobId)}`),
    },

    playlists: {
      list: () => get(z.array(PlaylistSummarySchema), '/playlists'),
      get: (id: string) => get(PlaylistDetailSchema, `/playlists/${enc(id)}`),
      create: (req: CreatePlaylistRequest) => post(PlaylistDetailSchema, '/playlists', req),
      update: (id: string, req: UpdatePlaylistRequest) =>
        patch(PlaylistDetailSchema, `/playlists/${enc(id)}`, req),
      remove: (id: string) => del(OkSchema, `/playlists/${enc(id)}`),
      duplicate: (id: string, name?: string) =>
        post(PlaylistDetailSchema, `/playlists/${enc(id)}/duplicate`, { name }),
      addItems: (id: string, req: AddPlaylistItemsRequest) =>
        post(PlaylistDetailSchema, `/playlists/${enc(id)}/items`, req),
      removeItems: (id: string, itemIds: string[]) =>
        post(PlaylistDetailSchema, `/playlists/${enc(id)}/items/remove`, { itemIds }),
      reorder: (id: string, itemIds: string[]) =>
        patch(PlaylistDetailSchema, `/playlists/${enc(id)}/items/order`, { itemIds }),
    },

    queue: {
      get: () => get(QueueStateSchema, '/queue'),
      replace: (req: QueueReplaceRequest) => post(QueueStateSchema, '/queue/replace', req),
      add: (req: QueueAddRequest) => post(QueueStateSchema, '/queue/add', req),
      remove: (itemIds: string[]) => post(QueueStateSchema, '/queue/remove', { itemIds }),
      jump: (index: number) => post(QueueStateSchema, '/queue/jump', { index }),
      clear: () => post(QueueStateSchema, '/queue/clear'),
      takeover: () => post(QueueStateSchema, '/queue/takeover'),
      follow: () => post(QueueStateSchema, '/queue/follow'),
    },

    lyrics: {
      /** Lyrics of a library track (local file / tags / cache / online sources when enabled). */
      get: (trackId: string) => get(TrackLyricsSchema, `/tracks/${enc(trackId)}/lyrics`),
      setOffset: (trackId: string, offsetMs: number) =>
        post(TrackLyricsSchema, `/tracks/${enc(trackId)}/lyrics/offset`, {
          offsetMs: Math.round(offsetMs),
        }),
      // --- this computer only
      search: (trackId: string, q?: string) =>
        get(z.array(LyricsCandidateSchema), `/tracks/${enc(trackId)}/lyrics/search`, { q }),
      select: (trackId: string, candidate: { provider: OnlineLyricsProviderId; ref: string }) =>
        post(TrackLyricsSchema, `/tracks/${enc(trackId)}/lyrics/select`, {
          provider: candidate.provider,
          ref: candidate.ref,
        }),
      reset: (trackId: string) => post(TrackLyricsSchema, `/tracks/${enc(trackId)}/lyrics/reset`),
      settings: () => get(LyricsSettingsSchema, '/settings/lyrics'),
      setOnline: (online: boolean) => post(LyricsSettingsSchema, '/settings/lyrics', { online }),
      /** Choose which online sources may be asked (the order is fixed). */
      setProviders: (providers: OnlineLyricsProviderId[]) =>
        post(LyricsSettingsSchema, '/settings/lyrics', { providers }),
      clearCache: () => post(LyricsSettingsSchema, '/settings/lyrics/clear-cache'),
    },

    /** Online covers — this computer only. */
    covers: {
      search: (albumId: string, q?: string) =>
        get(z.array(CoverCandidateSchema), `/library/albums/${enc(albumId)}/cover/search`, { q }),
      /** URL of a candidate's thumbnail (Core fetches it; the page never talks to the source). */
      previewUrl: (candidate: CoverRef): string =>
        `${baseUrl}${API_PREFIX}/covers/preview?provider=${enc(candidate.provider)}&ref=${enc(candidate.ref)}`,
      select: (albumId: string, candidate: CoverRef) =>
        post(AlbumCoverSchema, `/library/albums/${enc(albumId)}/cover/select`, {
          provider: candidate.provider,
          ref: candidate.ref,
        }),
      /** Drop the cover and look in the album's folder and tags again. */
      reset: (albumId: string) =>
        post(AlbumCoverSchema, `/library/albums/${enc(albumId)}/cover/reset`),
      settings: () => get(CoverSettingsSchema, '/settings/covers'),
      setOnline: (online: boolean) => post(CoverSettingsSchema, '/settings/covers', { online }),
      setProviders: (providers: CoverProviderId[]) =>
        post(CoverSettingsSchema, '/settings/covers', { providers }),
      /** Look up every album without a cover (background job; poll `settings()`). */
      fill: () => post(CoverSettingsSchema, '/settings/covers/fill'),
      cancelFill: () => post(CoverSettingsSchema, '/settings/covers/fill/cancel'),
    },

    playback: {
      album: (albumId: string, startTrackId?: string) =>
        post(QueueStateSchema, `/playback/album/${enc(albumId)}`, { startTrackId }),
      playlist: (playlistId: string, startItemId?: string) =>
        post(QueueStateSchema, `/playback/playlist/${enc(playlistId)}`, { startItemId }),
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;
