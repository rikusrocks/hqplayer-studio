import { z } from 'zod';
import { TrackSchema } from './library';

export const PlaylistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  itemCount: z.number().int(),
  durationMs: z.number().int(),
  /** Up to four artwork ids for a mosaic cover. */
  artworkIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;

/** One entry of a saved playlist. The same track may appear several times (distinct itemId). */
export const PlaylistItemSchema = z.object({
  itemId: z.string(),
  position: z.number().int(),
  addedAt: z.number(),
  track: TrackSchema,
});
export type PlaylistItem = z.infer<typeof PlaylistItemSchema>;

export const PlaylistDetailSchema = PlaylistSummarySchema.extend({
  items: z.array(PlaylistItemSchema),
});
export type PlaylistDetail = z.infer<typeof PlaylistDetailSchema>;
