import { existsSync } from 'node:fs';
import fastifyStatic, { type FastifyStaticOptions } from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { API_PREFIX } from '@hqps/contracts';
import type { HQPlayerAdapter } from '@hqps/hqplayer-adapter';
import type { LibraryContext } from '@hqps/library';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventHub } from './event-hub';
import { errorHandler } from './http/errors';
import { registerApiRoutes, serverInfo } from './http/routes';
import { HTML_CSP, isLoopbackHost, registerSecurity } from './http/security';
import { EngineService, type EngineServiceOptions } from './services/engine-service';
import { LibraryService, type LibraryServiceOptions } from './services/library-service';
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
    throw new Error(
      `Refusing to listen on "${host}": LAN access requires remote pairing/authentication, which arrives in Phase 3.`,
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
    pace: async () => {
      if (paceMs > 0 && engine.getStatus().transport === 'playing') {
        await new Promise((r) => setTimeout(r, paceMs));
      }
    },
    ...opts.library,
  });
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
    ctx: opts.ctx,
  };

  const app = Fastify({
    logger: opts.logger ? { level: 'info' } : false,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: true,
  });
  app.setErrorHandler(errorHandler);
  registerSecurity(app);
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.register(async (ws) => {
    ws.get(`${API_PREFIX}/events`, { websocket: true }, (socket, req) => {
      const send = (data: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
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
      const ping = setInterval(() => socket.ping(), 25_000);
      socket.on('close', () => {
        clearInterval(ping);
        unsubscribe();
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
  if (desktop && existsSync(desktop)) {
    await app.register(fastifyStatic, {
      root: desktop,
      prefix: '/',
      decorateReply: false,
      setHeaders,
    });
  }

  queue.init();

  return {
    ...services,
    app,
    async listen() {
      await engine.start();
      library.start();
      const address = await app.listen({ host, port: opts.port ?? DEFAULT_PORT });
      const url = new URL(address);
      return {
        url: `http://${host === '::1' ? '[::1]' : host}:${url.port}`,
        port: Number(url.port),
      };
    },
    async close() {
      queue.dispose();
      await library.stop();
      await engine.stop();
      await app.close();
    },
  };
}
