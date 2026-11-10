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
    sync: { state: 'unknown', reason: null, detectedAt: null },
    updatedAt: Date.now(),
  };
}
