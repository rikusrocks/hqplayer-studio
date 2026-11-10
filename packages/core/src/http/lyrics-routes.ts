import {
  LyricsOffsetRequestSchema,
  LyricsSearchQuerySchema,
  LyricsSelectRequestSchema,
  UpdateLyricsSettingsRequestSchema,
  type LyricsCandidate,
  type LyricsSettings,
  type TrackLyrics,
} from '@hqps/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StudioServices } from '../server';

const IdParams = z.object({ id: z.string().min(1).max(128) });

/**
 * Lyrics API (inside `/api/v1`). Reading lyrics and calibrating the per-track offset are open to
 * paired phones as well; manual LRCLIB matching and the lyrics settings exist only on the
 * loopback app (this computer).
 */
export function registerLyricsRoutes(api: FastifyInstance, s: StudioServices): void {
  const local = api.studioScope !== 'lan';
  const lyrics = s.lyrics;

  api.get('/tracks/:id/lyrics', async (req): Promise<TrackLyrics> =>
    lyrics.get(IdParams.parse(req.params).id),
  );
  api.post('/tracks/:id/lyrics/offset', async (req): Promise<TrackLyrics> =>
    lyrics.setOffset(
      IdParams.parse(req.params).id,
      LyricsOffsetRequestSchema.parse(req.body ?? {}).offsetMs,
    ),
  );

  if (!local) return;

  api.get('/tracks/:id/lyrics/search', async (req): Promise<LyricsCandidate[]> =>
    lyrics.search(IdParams.parse(req.params).id, LyricsSearchQuerySchema.parse(req.query).q),
  );
  api.post('/tracks/:id/lyrics/select', async (req): Promise<TrackLyrics> =>
    lyrics.select(
      IdParams.parse(req.params).id,
      LyricsSelectRequestSchema.parse(req.body ?? {}).lrclibId,
    ),
  );
  api.post('/tracks/:id/lyrics/reset', async (req): Promise<TrackLyrics> =>
    lyrics.reset(IdParams.parse(req.params).id),
  );
  api.get('/settings/lyrics', async (): Promise<LyricsSettings> => lyrics.settings());
  api.post('/settings/lyrics', async (req): Promise<LyricsSettings> =>
    lyrics.setOnline(UpdateLyricsSettingsRequestSchema.parse(req.body ?? {}).online),
  );
  api.post('/settings/lyrics/clear-cache', async (): Promise<LyricsSettings> =>
    lyrics.clearOnlineCache(),
  );
}
