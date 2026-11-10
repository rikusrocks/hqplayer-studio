import {
  PairRequestSchema,
  UpdateRemoteSettingsRequestSchema,
  type PairResponse,
  type PairingStatus,
  type PairingCode,
} from '@hqps/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StudioServices } from '../server';
import { HttpError } from './errors';
import { setMediaCookie } from './security';

const IdParams = z.object({ id: z.string().min(1).max(128) });

/**
 * `/api/v1/remote/*`. Management (listener, pairing codes, devices) exists only on the loopback
 * app; pairing itself only on the LAN app. Registered inside the `/api/v1` prefix.
 */
export function registerRemoteRoutes(api: FastifyInstance, s: StudioServices): void {
  const remote = s.remote;
  const lan = api.studioScope === 'lan';

  api.get('/remote/pairing-status', async (req): Promise<PairingStatus> => {
    const device = req.remoteDevice;
    return {
      lanEnabled: remote.isListening(),
      trusted: !lan,
      paired: device !== null,
      device: device ? { id: device.id, name: device.name } : null,
    };
  });

  if (lan) {
    api.post('/remote/pair', async (req, reply): Promise<PairResponse> => {
      const { code, deviceName } = PairRequestSchema.parse(req.body ?? {});
      const res = remote.pairing.pair(code, deviceName, req.socket.remoteAddress ?? 'unknown');
      setMediaCookie(reply, res.mediaKey);
      void reply.status(201);
      return { token: res.token, device: res.device };
    });
    /** "Forget this device" from the phone itself. */
    api.post('/remote/unpair', async (req) => {
      const device = req.remoteDevice;
      if (!device) throw new HttpError(401, 'unauthorized', 'Not paired');
      remote.pairing.revoke(device.id);
      return { ok: true as const };
    });
    return;
  }

  // --- this computer only ----------------------------------------------------------------
  api.get('/remote/settings', async () => remote.settings());
  api.post('/remote/settings', async (req) =>
    remote.update(UpdateRemoteSettingsRequestSchema.parse(req.body ?? {})),
  );
  api.post('/remote/pairing-code', async (): Promise<PairingCode> => {
    if (!remote.isListening()) {
      throw new HttpError(409, 'conflict', 'Turn on LAN access first', {
        reason: 'lan_disabled',
      });
    }
    remote.pairing.createCode();
    return remote.pairing.describeCode(remote.urls())!;
  });
  api.post('/remote/pairing-code/cancel', async () => {
    remote.pairing.cancelCode();
    return { ok: true as const };
  });
  api.post('/remote/devices/:id/revoke', async (req) => {
    const { id } = IdParams.parse(req.params);
    if (!remote.pairing.revoke(id)) throw new HttpError(404, 'not_found', 'Device not found');
    return { ok: true as const };
  });
}
