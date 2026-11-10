import { existsSync } from 'node:fs';
import fastifyStatic, { type FastifyStaticOptions } from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { API_PREFIX, WS_PROTOCOL, type StudioEvent } from '@hqps/contracts';
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
import { QueueService, type QueueServiceOptions } from './services/queue-service';

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
  const engine = new EngineService(opts.adapter, hub, opts.ctx.library, opts.engine);
  const queue = new QueueService(engine, opts.ctx, hub, opts.queue);
  const paceMs = opts.scanPaceWhilePlayingMs ?? 25;
  const library = new LibraryService(opts.ctx, hub, {
    // Scans yield to playback: while HQPlayer plays, every file read waits a little, so a big
    // rescan never competes with DSD512 for disk/NAS bandwidth or CPU.
    onTracksRemoved: (ids) => queue.forgetTracks(ids),
    onlineChecker: new OnlineAlbumChecker(
      opts.ctx,
      new MusicBrainzClient({
        // MusicBrainz asks clients to identify themselves; no personal data is sent.
        userAgent: `HQPlayerStudio/${opts.appVersion} ( third-party HQPlayer library client )`,
      }),
    ),
    pace: async () => {
      if (paceMs > 0 && engine.getStatus().transport === 'playing') {
        await new Promise((r) => setTimeout(r, paceMs));
      }
    },
    ...opts.library,
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
    ctx: opts.ctx,
  };

  const app = await buildStudioApp(services, 'local', {
    staticDirs: opts.staticDirs,
    logger: opts.logger,
  });

  queue.init();

  return {
    ...services,
    app,
    async listen() {
      await engine.start();
      library.start();
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
      queue.dispose();
      await remote.stop();
      await library.stop();
      await engine.stop();
      await app.close();
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
    app.setErrorHandler(errorHandler);
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
