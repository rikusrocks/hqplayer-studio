import {
  AppleMusicControlRequestSchema,
  UpdateAppleMusicSettingsRequestSchema,
  type AppleMusicState,
} from '@hqps/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StudioServices } from '../server';

const OpenRequestSchema = z.object({
  target: z.enum(['sound', 'app-volume', 'microphone', 'cable-site', 'apple-music']),
});

/**
 * Apple Music (live input) API, inside `/api/v1`. This computer only: paired phones see what is
 * playing through the ordinary engine status and use the ordinary transport buttons, but they
 * cannot switch HQPlayer to the live input, change the set-up or open Windows pages.
 */
export function registerAppleMusicRoutes(api: FastifyInstance, s: StudioServices): void {
  if (api.studioScope === 'lan') return;
  const am = s.appleMusic;

  api.get('/apple-music', async (): Promise<AppleMusicState> => am.get());
  api.post('/apple-music/settings', async (req): Promise<AppleMusicState> =>
    am.updateSettings(UpdateAppleMusicSettingsRequestSchema.parse(req.body ?? {})),
  );
  api.post('/apple-music/check', async (): Promise<AppleMusicState> => am.checkSetup());
  api.post('/apple-music/start', async (): Promise<AppleMusicState> => am.start());
  api.post('/apple-music/stop', async (): Promise<AppleMusicState> => am.stop());
  api.post('/apple-music/control', async (req): Promise<AppleMusicState> =>
    am.control(AppleMusicControlRequestSchema.parse(req.body ?? {}).action),
  );
  api.post('/apple-music/open', async (req) => {
    await am.open(OpenRequestSchema.parse(req.body ?? {}).target);
    return { ok: true as const };
  });
}
