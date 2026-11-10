import { z } from 'zod';
import { TrackSchema } from './library';

/**
 * `album`    — whole album, in disc/track order, gapless preferred (HQPlayer Album Mode when verified)
 * `playlist` — free-form queue (HQPlayer Playlist Mode semantics)
 */
export const QueueModeSchema = z.enum(['album', 'playlist']);
export type QueueMode = z.infer<typeof QueueModeSchema>;

export const QueueSourceSchema = z.object({
  kind: z.enum(['album', 'playlist', 'artist', 'tracks', 'folder', 'search', 'manual']),
  id: z.string().nullable(),
  label: z.string(),
});
export type QueueSource = z.infer<typeof QueueSourceSchema>;

export const QueueSyncStateSchema = z.enum(['in_sync', 'out_of_sync', 'unknown', 'engine_offline']);
export type QueueSyncState = z.infer<typeof QueueSyncStateSchema>;

/**
 * Why the queue is not `in_sync` — clients translate these; `reason` is the English fallback.
 * `engine_unqueued`        HQPlayer plays something although Studio has no queue (state `unknown`)
 * `engine_playlist_empty`  HQPlayer's playlist is empty but Studio has a queue
 * `engine_track_differs`   HQPlayer's current track is not the planned one
 * `engine_length_differs`  same current track, but HQPlayer's playlist length differs
 */
export const QueueSyncCodeSchema = z.enum([
  'engine_unqueued',
  'engine_playlist_empty',
  'engine_track_differs',
  'engine_length_differs',
]);
export type QueueSyncCode = z.infer<typeof QueueSyncCodeSchema>;

export const QueueItemSchema = z.object({
  itemId: z.string(),
  track: TrackSchema,
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/**
 * Studio's *planned* Now Playing queue. Studio owns the plan; HQPlayer owns what actually plays.
 * When the two diverge (e.g. someone changed tracks in the native HQPlayer UI), `sync` says so
 * instead of silently overwriting either side.
 */
export const QueueStateSchema = z.object({
  sessionId: z.string().nullable(),
  version: z.number().int().nonnegative(),
  mode: QueueModeSchema,
  source: QueueSourceSchema.nullable(),
  items: z.array(QueueItemSchema),
  currentIndex: z.number().int().nullable(),
  sync: z.object({
    state: QueueSyncStateSchema,
    code: QueueSyncCodeSchema.nullable(),
    reason: z.string().nullable(),
    detectedAt: z.number().nullable(),
  }),
  updatedAt: z.number(),
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export function emptyQueue(): QueueState {
  return {
    sessionId: null,
    version: 0,
    mode: 'playlist',
    source: null,
    items: [],
    currentIndex: null,
    sync: { state: 'unknown', code: null, reason: null, detectedAt: null },
    updatedAt: Date.now(),
  };
}
