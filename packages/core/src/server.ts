import { existsSync } from 'node:fs';
import fastifyStatic, { type FastifyStaticOptions } from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { API_PREFIX, LIVE_LYRICS_TRACK_ID, WS_PROTOCOL, type StudioEvent } from '@hqps/contracts';
import type { HQPlayerAdapter } from '@hqps/hqplayer-adapter';
import type { LibraryContext } from '@hqps/library';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventHub } from './event-hub';
import { errorHandler, toApiError } from './http/errors';
import { registerApiRoutes, serverInfo } from './http/routes';
import {
  HTML_CSP,
  isLoopbackHost,
  registerLanSecurity,
  registerSecurity,
  type LanSecurityOptions,
  type StudioScope,
} from './http/security';
import { RemoteAccessService, type RemoteAccessOptions } from './remote/remote-access';
import { sanitizeForLan } from './remote/sanitize';
import { EngineService, type EngineServiceOptions } from './services/engine-service';
import { LibraryService, type LibraryServiceOptions } from './services/library-service';
import { MusicBrainzClient, OnlineAlbumChecker } from './services/online-albums';
import { CoverService, type CoverServiceOptions } from './services/cover-service';
import { LyricsService, type LyricsServiceOptions } from './services/lyrics-service';
import { QueueService, type QueueServiceOptions } from './services/queue-service';
import { BackupService, type BackupServiceOptions } from './services/backup-service';
import { SoakRecorder, type SoakRecorderOptions } from './services/soak-recorder';
import { DspPresetService } from './services/dsp-presets';
import { AppleMusicService } from './services/apple-music-service';
import { SimulatedSound, windowsSound, type WindowsSound } from './services/windows-sound';
import { SimulatedMedia, windowsMedia, type WindowsMedia } from './services/windows-media';
import { attachActivityLog } from './logging/activity-log';
import { nullLog, type StudioLog } from './logging/studio-log';

export interface StudioServerOptions {
  adapter: HQPlayerAdapter;
  ctx: LibraryContext;
  appVersion: string;
  host?: string;
  port?: number;
  /** Built UI bundles to serve: desktop renderer at "/", web remote at "/remote/". */
  staticDirs?: { desktop?: string; remote?: string };
  demoMode?: boolean;
  /** How the adapter was chosen + where HQPlayer is expected (for GET /settings/engine). */
  engineInfo?: EngineInfo;
  logger?: boolean;
  engine?: EngineServiceOptions;
  queue?: QueueServiceOptions;
  library?: LibraryServiceOptions;
  /** Lyrics (LRCLIB client, file readers) — tests inject fakes. */
  lyrics?: Omit<LyricsServiceOptions, 'appVersion'>;
  /** Online covers (sources, fetch) — tests inject fakes. */
  covers?: Partial<Omit<CoverServiceOptions, 'appVersion'>>;
  /** Local log (app data folder). Default: no log. */
  log?: StudioLog;
  /** Database backups while running (daily / manual). */
  backups?: Partial<Omit<BackupServiceOptions, 'appVersion' | 'log'>>;
  /** Soak-test recorder; `dir` = where its reports go (null = memory only). */
  soak?: Partial<Omit<SoakRecorderOptions, 'appVersion' | 'log'>>;
  /** Windows media sessions for the Apple Music source — tests inject a fake. */
  appleMusic?: { media?: WindowsMedia; sound?: WindowsSound };
  /** Pause before each file read while HQPlayer is playing (handoff §12.6). Default 25 ms. */
  scanPaceWhilePlayingMs?: number;
  /** Web Remote LAN listener (off unless enabled in Settings → 网页遥控). */
  remote?: RemoteAccessOptions & {
    /** Rate limits of the LAN listener (tests lower them). */
    security?: Pick<
      LanSecurityOptions,
      'requestsPerMinute' | 'authFailures' | 'authFailureWindowMs' | 'now'
    >;
  };
}

export interface EngineInfo {
  source: 'default' | 'setting' | 'override';
  hqplayer: { host: string; port: number };
}

export interface StudioServices {
  engineInfo: EngineInfo;
  appVersion: string;
  demoMode: boolean;
  hub: EventHub;
  engine: EngineService;
  queue: QueueService;
  library: LibraryService;
  remote: RemoteAccessService;
  lyrics: LyricsService;
  covers: CoverService;
  backups: BackupService;
  soak: SoakRecorder;
  dspPresets: DspPresetService;
  appleMusic: AppleMusicService;
  log: StudioLog;
  ctx: LibraryContext;
}

export interface StudioServer extends StudioServices {
  app: FastifyInstance;
  /** Start listening; resolves with the bound URL. */
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 47321;

export async function createStudioServer(opts: StudioServerOptions): Promise<StudioServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    // The main listener is for this computer only. Phones use the separate, authenticated LAN
    // listener that the user turns on in Settings → 网页遥控 (RemoteAccessService).
    throw new Error(
      `Refusing to listen on "${host}": the main listener is loopback-only; enable LAN access for the Web Remote in Settings → 网页遥控 instead.`,
    );
  }
  const hub = new EventHub();
  const log = opts.log ?? nullLog();
  const engine = new EngineService(opts.adapter, hub, opts.ctx.library, opts.engine);
  const backups = new BackupService(opts.ctx, {
    appVersion: opts.appVersion,
    log,
    // daily backups wait for a pause in playback (they run in a worker, but stay polite)
    isPlaying: () => engine.getStatus().transport === 'playing',
    ...opts.backups,
  });
  const soak = new SoakRecorder(engine, hub, {
    dir: null,
    ...opts.soak,
    appVersion: opts.appVersion,
    log,
  });
  const queue = new QueueService(engine, opts.ctx, hub, opts.queue);
  // Apple Music through a live input. With the mock engine the Windows side is simulated too,
  // so the page can be explored on any computer (and says so).
  const appleMusic = new AppleMusicService(
    engine,
    queue,
    hub,
    opts.ctx.settings,
    opts.appleMusic?.media ??
      (opts.adapter.kind === 'mock' ? new SimulatedMedia() : windowsMedia()),
    log,
    opts.appleMusic?.sound ??
      (opts.adapter.kind === 'mock' ? new SimulatedSound() : windowsSound()),
  );
  const paceMs = opts.scanPaceWhilePlayingMs ?? 25;
  // One MusicBrainz client for the album check and the cover lookups (one request per second
  // in total). MusicBrainz asks clients to identify themselves; no personal data is sent.
  const musicbrainz =
    opts.covers?.musicbrainz ??
    new MusicBrainzClient({
      userAgent: `HQPlayerStudio/${opts.appVersion} ( third-party HQPlayer library client )`,
    });
  const library = new LibraryService(opts.ctx, hub, {
    // Scans yield to playback: while HQPlayer plays, every file read waits a little, so a big
    // rescan never competes with DSD512 for disk/NAS bandwidth or CPU.
    onTracksRemoved: (ids) => queue.forgetTracks(ids),
    onlineChecker: new OnlineAlbumChecker(opts.ctx, musicbrainz),
    pace: async () => {
      if (paceMs > 0 && engine.getStatus().transport === 'playing') {
        await new Promise((r) => setTimeout(r, paceMs));
      }
    },
    ...opts.library,
  });
  // Online lyrics only for what is playing right now (never bulk lookups).
  const lyrics = new LyricsService(
    opts.ctx,
    hub,
    (trackId) => {
      if (trackId === LIVE_LYRICS_TRACK_ID) return engine.getStatus().track?.source != null;
      if (engine.getStatus().track?.studioTrackId === trackId) return true;
      const q = queue.get();
      return q.currentIndex !== null && q.items[q.currentIndex]?.track.id === trackId;
    },
    { appVersion: opts.appVersion, ...opts.lyrics },
  );
  // Online covers: opt-in; by itself only for the album that is playing and has no cover.
  const covers = new CoverService(opts.ctx, hub, {
    appVersion: opts.appVersion,
    ...opts.covers,
    musicbrainz,
  });
  // The LAN app is built only when the user turns LAN access on (after `services` exists).
  const remote: RemoteAccessService = new RemoteAccessService(
    opts.ctx,
    hub,
    (binding) =>
      buildStudioApp(services, 'lan', {
        staticDirs: { remote: opts.staticDirs?.remote },
        logger: opts.logger,
        lan: { ...opts.remote?.security, bound: binding, pairing: remote.pairing },
      }),
    opts.remote,
  );
  const services: StudioServices = {
    appVersion: opts.appVersion,
    demoMode: Boolean(opts.demoMode),
    engineInfo: opts.engineInfo ?? {
      source: 'default',
      hqplayer: { host: '127.0.0.1', port: 4321 },
    },
    hub,
    engine,
    queue,
    library,
    remote,
    lyrics,
    covers,
    backups,
    soak,
    dspPresets: new DspPresetService(engine, opts.ctx.settings, log),
    appleMusic,
    log,
    ctx: opts.ctx,
  };

  const app = await buildStudioApp(services, 'local', {
    staticDirs: opts.staticDirs,
    logger: opts.logger,
  });

  queue.init();
  appleMusic.init();
  // Lyrics of the song Apple Music is playing: by title and artist, kept in memory only.
  lyrics.setLiveTrack(() => appleMusic.liveTrack());
  // …and its cover, when Windows provides none and the user turned online covers on.
  appleMusic.setCoverLookup({
    enabled: () => covers.onlineEnabled(),
    find: (album, artist) => covers.findOnline(album, artist),
  });
  let detachLog: (() => void) | null = null;

  return {
    ...services,
    app,
    async listen() {
      detachLog = attachActivityLog(engine, hub, log);
      await engine.start();
      library.start();
      backups.start();
      const address = await app.listen({ host, port: opts.port ?? DEFAULT_PORT });
      const url = new URL(address);
      // LAN listener only if the user turned it on (never fails start-up; errors show in Settings).
      await remote.start();
      return {
        url: `http://${host === '::1' ? '[::1]' : host}:${url.port}`,
        port: Number(url.port),
      };
    },
    async close() {
      if (soak.isRunning()) soak.stop('app-quit');
      appleMusic.dispose();
      queue.dispose();
      await backups.stop();
      await remote.stop();
      await covers.stop();
      await library.stop();
      await engine.stop();
      await app.close();
      detachLog?.();
      detachLog = null;
    },
  };
}

interface BuildAppOptions {
  staticDirs?: { desktop?: string; remote?: string };
  logger?: boolean;
  /** Required for the LAN app. */
  lan?: LanSecurityOptions;
}

/**
 * One Fastify app per listener. `local` = this computer (loopback security, desktop UI + remote,
 * every route). `lan` = Web Remote on the home network (paired devices only, remote UI only, no
 * settings/diagnostics routes, every JSON payload and event stripped of local paths).
 */
export async function buildStudioApp(
  services: StudioServices,
  scope: StudioScope,
  opts: BuildAppOptions,
): Promise<FastifyInstance> {
  const { engine, queue, hub } = services;
  const lan = scope === 'lan';
  const app = Fastify({
    logger: opts.logger ? { level: 'info' } : false,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: true,
  });
  app.decorate('studioScope', scope);
  app.decorateRequest('remoteDevice', null);
  if (lan) {
    if (!opts.lan) throw new Error('LAN app needs LAN security options');
    registerLanSecurity(app, opts.lan);
    // Error messages may quote paths (e.g. a failed scan): sanitise them like any other payload.
    app.setErrorHandler((err, req, reply) => {
      const { status, body } = toApiError(err);
      if (status >= 500 && status !== 503 && status !== 504 && status !== 502) {
        req.log.error({ err }, 'request failed');
      }
      void reply.status(status).send(sanitizeForLan(body));
    });
    app.addHook('preSerialization', async (_req, _reply, payload) => sanitizeForLan(payload));
  } else {
    app.setErrorHandler((err, req, reply) => {
      if (toApiError(err).status === 500) {
        services.log.error(
          'http',
          `${req.method} ${req.routeOptions.url ?? 'unknown route'} failed`,
          {
            error: (err as Error)?.message ?? String(err),
          },
        );
      }
      errorHandler(err, req, reply);
    });
    registerSecurity(app);
  }
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 64 * 1024,
      // Clients offer `hqps.v1` (+ `hqps.auth.<token>` on the LAN). Only `hqps.v1` is ever
      // selected, so the token is never echoed back in the handshake.
      handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
    },
  });

  app.register(async (ws) => {
    ws.get(`${API_PREFIX}/events`, { websocket: true }, (socket, req) => {
      const send = (data: StudioEvent) => {
        if (socket.readyState !== socket.OPEN) return;
        if (lan && data.type === 'remote.changed') return; // desktop Settings only
        socket.send(JSON.stringify(lan ? sanitizeForLan(data) : data));
      };
      void engine.getCapabilities().then((capabilities) =>
        send({
          type: 'hello',
          server: serverInfo(services, req),
          status: engine.getStatus(),
          capabilities,
          queue: queue.get(),
        }),
      );
      const unsubscribe = hub.subscribe(send);
      const device = req.remoteDevice;
      const untrack = device
        ? services.remote.pairing.trackSocket(device.id, socket)
        : () => undefined;
      const ping = setInterval(() => socket.ping(), 25_000);
      socket.on('close', () => {
        clearInterval(ping);
        unsubscribe();
        untrack();
      });
      socket.on('message', () => undefined); // clients do not send commands over WS (REST only)
    });
  });

  registerApiRoutes(app, services);

  const { desktop, remote } = opts.staticDirs ?? {};
  const setHeaders: NonNullable<FastifyStaticOptions['setHeaders']> = (res, path) => {
    if (path.endsWith('.html')) {
      void res.header('Content-Security-Policy', HTML_CSP);
      void res.header('Cache-Control', 'no-cache');
    }
    if (path.endsWith('.webmanifest')) {
      void res.header('Content-Type', 'application/manifest+json; charset=utf-8');
    }
  };
  if (remote && existsSync(remote)) {
    await app.register(fastifyStatic, {
      root: remote,
      prefix: '/remote/',
      decorateReply: false,
      setHeaders,
    });
    app.get('/remote', (_req, reply) => reply.redirect('/remote/'));
  }
  if (lan) {
    // Phones only get the Web Remote; the desktop UI is never served on the LAN.
    app.get('/', (_req, reply) => reply.redirect('/remote/'));
  } else if (desktop && existsSync(desktop)) {
    await app.register(fastifyStatic, {
      root: desktop,
      prefix: '/',
      decorateReply: false,
      setHeaders,
    });
  }
  return app;
}
