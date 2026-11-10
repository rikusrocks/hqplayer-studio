import { z } from 'zod';
import { AdapterKindSchema } from './capabilities';
import { EngineStatusSchema } from './engine';
import { QueueModeSchema, QueueSourceSchema } from './queue';

export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/api/${API_VERSION}` as const;

const id = z.string().min(1).max(128);
const trackIds = z.array(id).min(1).max(5000);

export const TransportActionSchema = z.enum([
  'play',
  'pause',
  'toggle',
  'stop',
  'next',
  'previous',
]);
export type TransportAction = z.infer<typeof TransportActionSchema>;

export const TransportRequestSchema = z.object({ action: TransportActionSchema });
export type TransportRequest = z.infer<typeof TransportRequestSchema>;

export const SeekRequestSchema = z.object({ positionMs: z.number().int().nonnegative() });
export type SeekRequest = z.infer<typeof SeekRequestSchema>;

export const VolumeRequestSchema = z.object({ volumeDb: z.number().min(-120).max(20) });
export type VolumeRequest = z.infer<typeof VolumeRequestSchema>;

export const EngineCommandResultSchema = z.object({
  accepted: z.boolean(),
  status: EngineStatusSchema,
});
export type EngineCommandResult = z.infer<typeof EngineCommandResultSchema>;

// --- library -----------------------------------------------------------------------------------

export const AlbumSortSchema = z.enum(['artist', 'title', 'year', 'added']);
export const LibraryQuerySchema = z.object({
  q: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sort: AlbumSortSchema.optional(),
  artistId: id.optional(),
});
export type AlbumSort = z.infer<typeof AlbumSortSchema>;
export interface LibraryQuery {
  q?: string;
  offset?: number;
  limit?: number;
  sort?: AlbumSort;
  artistId?: string;
}

export const FolderQuerySchema = z.object({
  rootId: id.optional(),
  path: z.string().max(4096).default(''),
});
export interface FolderQuery {
  rootId?: string;
  path?: string;
}

export const AddLibraryRootRequestSchema = z.object({
  path: z.string().trim().min(1).max(4096),
});
export type AddLibraryRootRequest = z.infer<typeof AddLibraryRootRequestSchema>;

export const ScanRequestSchema = z.object({ rootId: id.optional() });
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

// --- playlists ---------------------------------------------------------------------------------

const playlistName = z.string().trim().min(1).max(200);

export const CreatePlaylistRequestSchema = z.object({
  name: playlistName,
  description: z.string().max(2000).nullable().optional(),
  trackIds: z.array(id).max(5000).optional(),
});
export type CreatePlaylistRequest = z.infer<typeof CreatePlaylistRequestSchema>;

export const UpdatePlaylistRequestSchema = z
  .object({
    name: playlistName.optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Nothing to update',
  });
export type UpdatePlaylistRequest = z.infer<typeof UpdatePlaylistRequestSchema>;

export const AddPlaylistItemsRequestSchema = z.object({
  trackIds,
  /** Insert before this position (0-based). Defaults to the end. */
  position: z.number().int().min(0).optional(),
});
export type AddPlaylistItemsRequest = z.infer<typeof AddPlaylistItemsRequestSchema>;

export const RemovePlaylistItemsRequestSchema = z.object({
  itemIds: z.array(id).min(1).max(5000),
});
export type RemovePlaylistItemsRequest = z.infer<typeof RemovePlaylistItemsRequestSchema>;

/** The complete new order of item ids; must be a permutation of the current items. */
export const ReorderPlaylistItemsRequestSchema = z.object({
  itemIds: z.array(id).max(20000),
});
export type ReorderPlaylistItemsRequest = z.infer<typeof ReorderPlaylistItemsRequestSchema>;

export const DuplicatePlaylistRequestSchema = z.object({ name: playlistName.optional() });
export type DuplicatePlaylistRequest = z.infer<typeof DuplicatePlaylistRequestSchema>;

// --- queue & playback --------------------------------------------------------------------------

export const QueueReplaceRequestSchema = z.object({
  trackIds,
  startIndex: z.number().int().min(0).default(0),
  source: QueueSourceSchema.optional(),
  mode: QueueModeSchema.optional(),
  autoplay: z.boolean().default(true),
});
export type QueueReplaceRequest = z.input<typeof QueueReplaceRequestSchema>;

export const QueueAddRequestSchema = z.object({
  trackIds,
  /** `next` = Play Next (after current), `end` = Add to Queue. */
  position: z.enum(['next', 'end']),
});
export type QueueAddRequest = z.infer<typeof QueueAddRequestSchema>;

export const QueueRemoveRequestSchema = z.object({ itemIds: z.array(id).min(1).max(5000) });
export type QueueRemoveRequest = z.infer<typeof QueueRemoveRequestSchema>;

export const QueueJumpRequestSchema = z.object({ index: z.number().int().min(0) });
export type QueueJumpRequest = z.infer<typeof QueueJumpRequestSchema>;

export const PlayAlbumRequestSchema = z.object({ startTrackId: id.optional() });
export type PlayAlbumRequest = z.infer<typeof PlayAlbumRequestSchema>;

export const PlayPlaylistRequestSchema = z.object({ startItemId: id.optional() });
export type PlayPlaylistRequest = z.infer<typeof PlayPlaylistRequestSchema>;

// --- server ------------------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  apiVersion: z.literal(API_VERSION),
  appVersion: z.string(),
  adapter: AdapterKindSchema,
  uptimeMs: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ServerInfoSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  appVersion: z.string(),
  adapter: AdapterKindSchema,
  /** True for loopback (same machine) clients — they may see local paths & settings. */
  trustedClient: z.boolean(),
  remote: z.object({
    lanEnabled: z.boolean(),
    urls: z.array(z.string()),
    note: z.string().nullable(),
  }),
  demoMode: z.boolean(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const ApiErrorCodeSchema = z.enum([
  'invalid_request',
  'not_found',
  'conflict',
  'engine_unavailable',
  'engine_timeout',
  'engine_error',
  'capability_unavailable',
  'forbidden',
  /** LAN request without a valid device token (pair again). */
  'unauthorized',
  /** Too many requests / pairing attempts from this address; retry later. */
  'rate_limited',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// --- engine settings ---------------------------------------------------------------------------

/**
 * Which engine adapter Studio uses. `live` is read-only until write commands are verified.
 * `source`: `override` = forced by a launch flag/env var (the saved preference applies once the
 * override is removed), `setting` = saved preference, `default` = nothing saved (mock).
 */
export const EngineSettingsSchema = z.object({
  activeAdapter: AdapterKindSchema,
  preferredAdapter: AdapterKindSchema,
  source: z.enum(['default', 'setting', 'override']),
  restartRequired: z.boolean(),
  hqplayer: z.object({ host: z.string(), port: z.number().int() }),
  /**
   * “允许 Studio 控制 HQPlayer” — off by default. When on, write commands that were confirmed on
   * this engine (Gate C) become usable; DSP/output changes are never included.
   */
  allowControl: z.boolean(),
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const UpdateEngineSettingsRequestSchema = z
  .object({ adapter: AdapterKindSchema.optional(), allowControl: z.boolean().optional() })
  .refine((v) => v.adapter !== undefined || v.allowControl !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateEngineSettingsRequest = z.infer<typeof UpdateEngineSettingsRequestSchema>;

/** HQPlayer's own current playlist, read-only. Local paths are deliberately not exposed. */
export const EngineQueueEntrySchema = z.object({
  index: z.number().int(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  /** Set when the engine's file could be matched to a Studio library track. */
  studioTrackId: z.string().nullable(),
});
export type EngineQueueEntry = z.infer<typeof EngineQueueEntrySchema>;

export const EngineQueueSchema = z.object({
  albumMode: z.boolean().nullable(),
  entries: z.array(EngineQueueEntrySchema),
  /** Index (0-based) of the engine's current track within `entries`, if known. */
  currentIndex: z.number().int().nullable(),
  /**
   * How the current track was located: `uri` = matched by file URI (index base verified),
   * `index` = from the engine's track number, `none` = no current track.
   */
  currentMatchedBy: z.enum(['uri', 'index', 'none']),
  /** Numbering base of HQPlayer's Status `track` (1 or 0) once verified by URI; null if not yet. */
  statusTrackBase: z.number().int().nullable(),
  observedAt: z.number(),
});
export type EngineQueue = z.infer<typeof EngineQueueSchema>;

export const MockControlRequestSchema = z.object({
  action: z.enum(['disconnect', 'reconnect', 'external-change', 'fail-next-command']),
});
export type MockControlRequest = z.infer<typeof MockControlRequestSchema>;
