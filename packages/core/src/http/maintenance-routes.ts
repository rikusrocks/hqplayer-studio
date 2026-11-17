import {
  RestoreRequestSchema,
  SoakStartRequestSchema,
  type LogInfo,
  type SoakStatus,
} from '@hqps/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StudioServices } from '../server';
import { HttpError } from './errors';
import { isTrustedRequest } from './security';

function trustedOnly(req: FastifyRequest): void {
  if (!isTrustedRequest(req)) {
    throw new HttpError(403, 'forbidden', 'Only available on this computer');
  }
}

export function logInfo(s: StudioServices): LogInfo {
  const sum = s.log.summary();
  return {
    enabled: s.log.dir !== null,
    since: sum.since,
    counts: sum.counts,
    files: sum.files,
    problems: sum.problems,
    crashReports: sum.crashReports,
    previousSessionUnclean: sum.previousSessionUnclean,
  };
}

/**
 * Backups, logs and the soak test (Phase 5). This-computer-only: registered on the loopback app
 * only, and every route also checks for a trusted client.
 */
export function registerMaintenanceRoutes(api: FastifyInstance, s: StudioServices): void {
  if (api.studioScope === 'lan') return;

  // --- database backups
  api.get('/maintenance/backups', async (req) => {
    trustedOnly(req);
    return s.backups.state();
  });
  api.post('/maintenance/backups', async (req) => {
    trustedOnly(req);
    await s.backups.create('manual');
    return s.backups.state();
  });
  api.post('/maintenance/backups/restore', async (req) => {
    trustedOnly(req);
    const { id } = RestoreRequestSchema.parse(req.body ?? {});
    return s.backups.requestRestore(id);
  });
  api.post('/maintenance/backups/restore/cancel', async (req) => {
    trustedOnly(req);
    return s.backups.cancelRestore();
  });

  // --- local log
  api.get('/maintenance/logs', async (req): Promise<LogInfo> => {
    trustedOnly(req);
    return logInfo(s);
  });

  // --- soak test
  api.get('/maintenance/soak', async (req): Promise<SoakStatus> => {
    trustedOnly(req);
    return s.soak.snapshot();
  });
  api.post('/maintenance/soak/start', async (req): Promise<SoakStatus> => {
    trustedOnly(req);
    const { durationHours } = SoakStartRequestSchema.parse(req.body ?? {});
    return s.soak.start(durationHours);
  });
  api.post('/maintenance/soak/stop', async (req): Promise<SoakStatus> => {
    trustedOnly(req);
    return s.soak.stop('user');
  });
}
