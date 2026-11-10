import { createReadStream } from 'node:fs';
import {
  API_PREFIX,
  API_VERSION,
  AddLibraryRootRequestSchema,
  AddPlaylistItemsRequestSchema,
  CreatePlaylistRequestSchema,
  DuplicatePlaylistRequestSchema,
  FolderQuerySchema,
  LibraryQuerySchema,
  MockControlRequestSchema,
  UpdateEngineSettingsRequestSchema,
  PlayAlbumRequestSchema,
  PlayPlaylistRequestSchema,
  QueueAddRequestSchema,
  QueueJumpRequestSchema,
  QueueRemoveRequestSchema,
  QueueReplaceRequestSchema,
  RemovePlaylistItemsRequestSchema,
  ReorderPlaylistItemsRequestSchema,
  ScanRequestSchema,
  SeekRequestSchema,
  TransportRequestSchema,
  UpdatePlaylistRequestSchema,
  VolumeRequestSchema,
  type EngineQueue,
  type EngineSettings,
  type ServerInfo,
} from '@hqps/contracts';
import { CapabilityUnavailableError, MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { ArtworkStore } from '@hqps/library';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ENGINE_ADAPTER_SETTING } from '../settings-keys';
import type { StudioServices } from '../server';
import { HttpError } from './errors';
import { isTrustedRequest } from './security';

const IdParams = z.object({ id: z.string().min(1).max(128) });

function body<T extends z.ZodType>(schema: T, req: FastifyRequest): z.infer<T> {
  return schema.parse(req.body ?? {});
}

export function serverInfo(services: StudioServices, req: FastifyRequest): ServerInfo {
  return {
    apiVersion: API_VERSION,
    appVersion: services.appVersion,
    adapter: services.engine.adapter.kind,
    trustedClient: isTrustedRequest(req),
    remote: {
      lanEnabled: false,
      urls: [],
      note: 'LAN access for phones/tablets ships with pairing in Phase 3. Until then the Web Remote is available on this computer only.',
    },
    demoMode: services.demoMode,
  };
}

export function engineSettings(s: StudioServices): EngineSettings {
  const active = s.engine.adapter.kind;
  const saved = s.ctx.settings.get<'mock' | 'live' | null>(ENGINE_ADAPTER_SETTING, null);
  const preferred = saved ?? 'mock';
  return {
    activeAdapter: active,
    preferredAdapter: preferred,
    source: s.engineInfo.source,
    restartRequired: s.engineInfo.source !== 'override' && preferred !== active,
    hqplayer: s.engineInfo.hqplayer,
  };
}

export function registerApiRoutes(app: FastifyInstance, s: StudioServices): void {
  const { engine, queue, library: lib, ctx } = s;

  app.register(
    async (api) => {
      // --- system
      api.get('/health', async () => ({
        ok: true as const,
        apiVersion: API_VERSION,
        appVersion: s.appVersion,
        adapter: engine.adapter.kind,
        uptimeMs: Math.round(performance.now()),
      }));
      api.get('/server-info', async (req) => serverInfo(s, req));
      api.get('/remote/pairing-status', async () => ({
        lanEnabled: false,
        paired: false,
        note: 'Pairing is not implemented yet (Phase 3).',
      }));

      // --- engine
      api.get('/engine/status', async () => engine.getStatus());
      api.get('/engine/capabilities', async () => engine.getCapabilities());
      api.post('/engine/transport', async (req) => {
        const { action } = body(TransportRequestSchema, req);
        return { accepted: true, status: await engine.transport(action) };
      });
      api.post('/engine/seek', async (req) => {
        const { positionMs } = body(SeekRequestSchema, req);
        return { accepted: true, status: await engine.seek(positionMs) };
      });
      api.post('/engine/volume', async (req) => {
        const { volumeDb } = body(VolumeRequestSchema, req);
        return { accepted: true, status: await engine.setVolume(volumeDb) };
      });
      api.get('/engine/dsp', async () => {
        engine.require('dsp.read');
        return engine.run('getDspState', (a) => {
          if (!a.getDspState)
            throw new CapabilityUnavailableError('dsp.read', 'adapter cannot read DSP state');
          return a.getDspState();
        });
      });
      api.get('/engine/queue', async (): Promise<EngineQueue> => {
        engine.require('queue.read');
        const snap = await engine.run('getEngineQueue', (a) => {
          if (!a.getEngineQueue) {
            throw new CapabilityUnavailableError(
              'queue.read',
              'adapter cannot read the engine queue',
            );
          }
          return a.getEngineQueue();
        });
        return {
          albumMode: snap.albumMode,
          observedAt: Date.now(),
          entries: snap.entries.map((e) => ({
            index: e.index,
            title: e.title,
            artist: e.artist,
            album: e.album,
            durationMs: e.durationMs,
            studioTrackId: e.uri ? ctx.library.findTrackIdBySource(e.uri) : null,
          })),
        };
      });

      // --- settings (local machine only: requests are loopback-gated)
      api.get('/settings/engine', async () => engineSettings(s));
      api.post('/settings/engine', async (req) => {
        const { adapter } = body(UpdateEngineSettingsRequestSchema, req);
        ctx.settings.set(ENGINE_ADAPTER_SETTING, adapter);
        return engineSettings(s);
      });

      api.post('/engine/mock', async (req) => {
        const adapter = engine.adapter;
        if (!(adapter instanceof MockHQPlayerAdapter)) {
          throw new HttpError(
            404,
            'not_found',
            'Mock controls are only available with the mock engine',
          );
        }
        const { action } = body(MockControlRequestSchema, req);
        if (action === 'disconnect') adapter.simulateDisconnect();
        else if (action === 'reconnect') adapter.simulateReconnect();
        else if (action === 'external-change') adapter.simulateExternalChange();
        else adapter.failNextCommand();
        return { ok: true as const };
      });

      // --- library
      api.get('/library/stats', async () => ctx.library.stats());
      api.get('/library/albums', async (req) =>
        ctx.library.listAlbums(LibraryQuerySchema.parse(req.query)),
      );
      api.get('/library/albums/:id', async (req) =>
        ctx.library.getAlbum(IdParams.parse(req.params).id),
      );
      api.get('/library/artists', async (req) =>
        ctx.library.listArtists(LibraryQuerySchema.parse(req.query)),
      );
      api.get('/library/artists/:id', async (req) =>
        ctx.library.getArtist(IdParams.parse(req.params).id),
      );
      api.get('/library/tracks', async (req) =>
        ctx.library.listTracks(LibraryQuerySchema.parse(req.query)),
      );
      api.get('/library/folders', async (req) => {
        const q = FolderQuerySchema.parse(req.query);
        return ctx.library.listFolders(q.rootId, q.path);
      });
      api.get('/library/roots', async (req) => {
        const roots = ctx.library.listRoots();
        // Local paths are only shown to clients on this computer.
        return isTrustedRequest(req) ? roots : roots.map((r) => ({ ...r, path: r.name }));
      });
      api.post('/library/roots', async (req, reply) => {
        const { path } = body(AddLibraryRootRequestSchema, req);
        void reply.status(201);
        return lib.addRoot(path);
      });
      api.post('/library/scan', async (req) => lib.scan(body(ScanRequestSchema, req).rootId));
      api.get('/library/scan', async () => lib.listJobs());
      api.get('/library/scan/:id', async (req) => {
        const job = lib.getJob(IdParams.parse(req.params).id);
        if (!job) throw new HttpError(404, 'not_found', 'Scan job not found');
        return job;
      });

      // --- playlists
      const playlistsChanged = (playlistId: string | null) =>
        s.hub.publish({ type: 'playlists.changed', playlistId });
      api.get('/playlists', async () => ctx.playlists.list());
      api.post('/playlists', async (req, reply) => {
        const pl = ctx.playlists.create(body(CreatePlaylistRequestSchema, req));
        playlistsChanged(pl.id);
        void reply.status(201);
        return pl;
      });
      api.get('/playlists/:id', async (req) => ctx.playlists.get(IdParams.parse(req.params).id));
      api.patch('/playlists/:id', async (req) => {
        const { id } = IdParams.parse(req.params);
        const pl = ctx.playlists.update(id, body(UpdatePlaylistRequestSchema, req));
        playlistsChanged(id);
        return pl;
      });
      api.delete('/playlists/:id', async (req) => {
        const { id } = IdParams.parse(req.params);
        ctx.playlists.delete(id);
        playlistsChanged(id);
        return { ok: true as const };
      });
      api.post('/playlists/:id/duplicate', async (req, reply) => {
        const { id } = IdParams.parse(req.params);
        const pl = ctx.playlists.duplicate(id, body(DuplicatePlaylistRequestSchema, req).name);
        playlistsChanged(pl.id);
        void reply.status(201);
        return pl;
      });
      api.post('/playlists/:id/items', async (req) => {
        const { id } = IdParams.parse(req.params);
        const b = body(AddPlaylistItemsRequestSchema, req);
        const pl = ctx.playlists.addItems(id, b.trackIds, b.position);
        playlistsChanged(id);
        return pl;
      });
      api.post('/playlists/:id/items/remove', async (req) => {
        const { id } = IdParams.parse(req.params);
        const pl = ctx.playlists.removeItems(
          id,
          body(RemovePlaylistItemsRequestSchema, req).itemIds,
        );
        playlistsChanged(id);
        return pl;
      });
      api.patch('/playlists/:id/items/order', async (req) => {
        const { id } = IdParams.parse(req.params);
        const pl = ctx.playlists.reorder(id, body(ReorderPlaylistItemsRequestSchema, req).itemIds);
        playlistsChanged(id);
        return pl;
      });

      // --- queue & playback
      api.get('/queue', async () => queue.get());
      api.post('/queue/replace', async (req) => {
        const b = body(QueueReplaceRequestSchema, req);
        return queue.replace({
          trackIds: b.trackIds,
          startIndex: b.startIndex,
          source: b.source,
          mode: b.mode,
          autoplay: b.autoplay,
        });
      });
      api.post('/queue/add', async (req) => {
        const b = body(QueueAddRequestSchema, req);
        return queue.add(b.trackIds, b.position);
      });
      api.post('/queue/remove', async (req) =>
        queue.remove(body(QueueRemoveRequestSchema, req).itemIds),
      );
      api.post('/queue/jump', async (req) => queue.jump(body(QueueJumpRequestSchema, req).index));
      api.post('/queue/clear', async () => queue.clear());
      api.post('/queue/takeover', async () => queue.takeover());
      api.post('/playback/album/:id', async (req) =>
        queue.playAlbum(
          IdParams.parse(req.params).id,
          body(PlayAlbumRequestSchema, req).startTrackId,
        ),
      );
      api.post('/playback/playlist/:id', async (req) =>
        queue.playPlaylist(
          IdParams.parse(req.params).id,
          body(PlayPlaylistRequestSchema, req).startItemId,
        ),
      );

      // --- artwork (served from the content-addressed cache only; ids are validated)
      api.get('/artwork/:id', async (req, reply) => {
        const { id } = IdParams.parse(req.params);
        if (!ArtworkStore.isValidId(id)) throw new HttpError(404, 'not_found', 'Artwork not found');
        const art = ctx.artwork.resolve(id);
        if (!art) throw new HttpError(404, 'not_found', 'Artwork not found');
        void reply.header('Content-Type', art.mime);
        void reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        if (art.mime === 'image/svg+xml') {
          void reply.header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'",
          );
        }
        return reply.send(createReadStream(art.file));
      });

      api.setNotFoundHandler(async () => {
        throw new HttpError(404, 'not_found', 'Unknown API endpoint');
      });
    },
    { prefix: API_PREFIX },
  );
}
