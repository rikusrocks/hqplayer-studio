import {
  CoverRefSchema,
  CoverSearchQuerySchema,
  UpdateCoverSettingsRequestSchema,
  type AlbumCover,
  type CoverCandidate,
  type CoverSettings,
} from '@hqps/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StudioServices } from '../server';

const IdParams = z.object({ id: z.string().min(1).max(128) });

/**
 * Online covers (inside `/api/v1`). Everything here contacts third parties or changes what the
 * library shows, so it exists only on the loopback app (this computer) — paired phones just see
 * the covers through `/artwork/:id` like any other.
 */
export function registerCoverRoutes(api: FastifyInstance, s: StudioServices): void {
  if (api.studioScope === 'lan') return;
  const covers = s.covers;

  api.get('/library/albums/:id/cover/search', async (req): Promise<CoverCandidate[]> =>
    covers.search(IdParams.parse(req.params).id, CoverSearchQuerySchema.parse(req.query).q),
  );
  api.post('/library/albums/:id/cover/select', async (req): Promise<AlbumCover> => {
    const { provider, ref } = CoverRefSchema.parse(req.body ?? {});
    return covers.select(IdParams.parse(req.params).id, provider, ref);
  });
  api.post('/library/albums/:id/cover/reset', async (req): Promise<AlbumCover> =>
    covers.reset(IdParams.parse(req.params).id),
  );
  // The page's CSP allows images from Studio only, so Core fetches a candidate's thumbnail. The
  // image host is derived from the validated `ref`, never taken from the request as a URL.
  api.get('/covers/preview', async (req, reply) => {
    const { provider, ref } = CoverRefSchema.parse(req.query);
    const image = await covers.preview(provider, ref);
    void reply.header('Content-Type', image.mime);
    void reply.header('Cache-Control', 'private, max-age=86400');
    void reply.header('Content-Security-Policy', "default-src 'none'");
    return reply.send(
      Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
    );
  });

  api.get('/settings/covers', async (): Promise<CoverSettings> => covers.settings());
  api.post('/settings/covers', async (req): Promise<CoverSettings> =>
    covers.update(UpdateCoverSettingsRequestSchema.parse(req.body ?? {})),
  );
  api.post('/settings/covers/fill', async (): Promise<CoverSettings> => covers.startFill());
  api.post('/settings/covers/fill/cancel', async (): Promise<CoverSettings> => covers.cancelFill());
}
