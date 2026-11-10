import { z } from 'zod';
import { ServerInfoSchema } from './api';
import { EngineCapabilitiesSchema } from './capabilities';
import { EngineStatusSchema } from './engine';
import { LibraryStatsSchema, ScanJobSchema } from './library';
import { QueueStateSchema } from './queue';

/** Messages pushed over `WS /api/v1/events`. */
export const StudioEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    server: ServerInfoSchema,
    status: EngineStatusSchema,
    capabilities: EngineCapabilitiesSchema,
    queue: QueueStateSchema,
  }),
  z.object({ type: z.literal('engine.status'), status: EngineStatusSchema }),
  z.object({ type: z.literal('engine.capabilities'), capabilities: EngineCapabilitiesSchema }),
  z.object({ type: z.literal('queue.changed'), queue: QueueStateSchema }),
  z.object({ type: z.literal('playlists.changed'), playlistId: z.string().nullable() }),
  z.object({ type: z.literal('library.changed'), stats: LibraryStatsSchema }),
  z.object({ type: z.literal('library.scan'), job: ScanJobSchema }),
  /** Web Remote listener, pairing code or paired devices changed (desktop Settings refetches). */
  z.object({ type: z.literal('remote.changed') }),
  /** Lyrics of a track changed (offset, manual choice); null = possibly all (cache cleared). */
  z.object({ type: z.literal('lyrics.changed'), trackId: z.string().nullable() }),
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    code: z.string(),
    /** English fallback; clients translate `code` (+ `params`) when they know it. */
    message: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  }),
]);
export type StudioEvent = z.infer<typeof StudioEventSchema>;
export type StudioEventType = StudioEvent['type'];
