import {
  API_PREFIX,
  AlbumDetailSchema,
  AlbumPageSchema,
  ApiErrorSchema,
  ArtistDetailSchema,
  ArtistPageSchema,
  DspStateSchema,
  EngineCapabilitiesSchema,
  EngineCommandResultSchema,
  EngineQueueSchema,
  EngineSettingsSchema,
  EngineStatusSchema,
  FolderListingSchema,
  HealthResponseSchema,
  LibraryRootSchema,
  LibraryStatsSchema,
  PlaylistDetailSchema,
  PlaylistSummarySchema,
  QueueStateSchema,
  ScanJobSchema,
  ServerInfoSchema,
  TrackPageSchema,
  type AddPlaylistItemsRequest,
  type ApiErrorCode,
  type CreatePlaylistRequest,
  type FolderQuery,
  type LibraryQuery,
  type MockControlRequest,
  type QueueAddRequest,
  type QueueReplaceRequest,
  type TransportAction,
  type UpdatePlaylistRequest,
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
}

/** Plain object of query parameters; undefined/null/empty values are omitted. */
type Query = object;

const OkSchema = z.object({ ok: z.literal(true) });

export function createStudioClient(options: StudioClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T extends z.ZodType>(
    schema: T,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Query,
  ): Promise<z.infer<T>> {
    const url = new URL(`${baseUrl}${API_PREFIX}${path}`, baseUrl || globalThis.location?.origin);
    if (query) {
      for (const [k, v] of Object.entries(query) as [string, unknown][]) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
  const del = <T extends z.ZodType>(schema: T, path: string) => request(schema, 'DELETE', path);
  const enc = encodeURIComponent;

  return {
    baseUrl,
    artworkUrl(artworkId: string | null | undefined, size?: 'thumb' | 'full'): string | null {
      if (!artworkId) return null;
      const q = size ? `?size=${size}` : '';
      return `${baseUrl}${API_PREFIX}/artwork/${enc(artworkId)}${q}`;
    },
    eventsUrl(): string {
      const origin = baseUrl || globalThis.location?.origin || 'http://127.0.0.1';
      return `${origin.replace(/^http/, 'ws')}${API_PREFIX}/events`;
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
      mockControl: (action: MockControlRequest['action']) =>
        post(OkSchema, '/engine/mock', { action }),
    },

    settings: {
      engine: () => get(EngineSettingsSchema, '/settings/engine'),
      setEngine: (adapter: 'mock' | 'live') =>
        post(EngineSettingsSchema, '/settings/engine', { adapter }),
      /** “允许 Studio 控制 HQPlayer” — applies immediately, no restart. */
      setControl: (allowControl: boolean) =>
        post(EngineSettingsSchema, '/settings/engine', { allowControl }),
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

    playback: {
      album: (albumId: string, startTrackId?: string) =>
        post(QueueStateSchema, `/playback/album/${enc(albumId)}`, { startTrackId }),
      playlist: (playlistId: string, startItemId?: string) =>
        post(QueueStateSchema, `/playback/playlist/${enc(playlistId)}`, { startItemId }),
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;
