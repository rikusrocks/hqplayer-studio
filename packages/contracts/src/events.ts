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
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    code: z.string(),
    message: z.string(),
  }),
]);
export type StudioEvent = z.infer<typeof StudioEventSchema>;
export type StudioEventType = StudioEvent['type'];
