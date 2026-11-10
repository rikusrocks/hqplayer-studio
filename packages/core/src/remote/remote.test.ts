import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioClient, StudioApiError } from '@hqps/api-client';
import {
  TrackLyricsSchema,
  type PairingCode,
  type PairResponse,
  type QueueState,
  type RemoteSettings,
  type StudioEvent,
} from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createStudioServer, type StudioServer, type StudioServerOptions } from '../server';
import type { InterfaceProvider } from './lan-address';

/** A home PC: Ethernet on the LAN, plus interfaces Studio must never listen on. */
const HOME_PC: ReturnType<InterfaceProvider> = {
  Ethernet: [
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  'Wi-Fi': [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
  Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
};

const PHONE = '192.168.1.50';

let dir: string;
let staticDir: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let clock: number;
let interfaces: ReturnType<InterfaceProvider>;

function options(over: Partial<StudioServerOptions['remote']> = {}): StudioServerOptions {
  return {
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    demoMode: true,
    staticDirs: { remote: staticDir },
    engine: { commandTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    remote: {
      interfaces: () => interfaces,
      testBindAddress: '127.0.0.1',
      port: 0,
      checkIntervalMs: 0,
      pairing: { now: () => clock },
      ...over,
    },
  };
}

// Seeding the demo library and starting a server can exceed 10 s on loaded Windows runners.
const HOOK_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-remote-'));
  staticDir = join(dir, 'remote-dist');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Remote</title>');
  writeFileSync(join(staticDir, 'manifest.webmanifest'), '{"name":"Studio Remote"}');
  ctx = openLibrary(join(dir, 'data'));
  seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
  clock = 1_000_000;
  interfaces = HOME_PC;
  server = await createStudioServer(options());
  await server.listen();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await server.close();
  adapter.dispose();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
}, HOOK_TIMEOUT_MS);

// --- helpers -------------------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Request on this computer (loopback listener). */
async function local<T = unknown>(method: Method, url: string, payload?: unknown) {
  const res = await server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers:
      method === 'GET'
        ? { host: '127.0.0.1:47321' }
        : { host: '127.0.0.1:47321', 'content-type': 'application/json' },
    payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

function lanHost(): string {
  const url = new URL(server.remote.urls()[0]!);
  return url.host;
}

/** Request from a phone on the LAN (the LAN listener). */
async function lan<T = unknown>(
  method: Method,
  url: string,
  opts: {
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
    from?: string;
    raw?: boolean;
  } = {},
) {
  const app = server.remote.lanApp();
  if (!app) throw new Error('LAN listener is not running');
  const headers: Record<string, string> = { host: lanHost() };
  if (method !== 'GET') headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.inject({
    method,
    url: opts.raw ? url : `/api/v1${url}`,
    headers: { ...headers, ...opts.headers },
    payload: method === 'GET' ? undefined : JSON.stringify(opts.payload ?? {}),
    remoteAddress: opts.from ?? PHONE,
  });
  const body = (() => {
    try {
      return res.json() as unknown;
    } catch {
      return res.body;
    }
  })();
  return { status: res.statusCode, body: body as T, headers: res.headers };
}

async function enableLan(): Promise<RemoteSettings> {
  const r = await local<RemoteSettings>('POST', '/remote/settings', {
    enabled: true,
    interfaceName: 'Ethernet',
  });
  expect(r.status).toBe(200);
  expect(r.body.state).toBe('listening');
  return r.body;
}

async function pairPhone(name = 'iPhone'): Promise<PairResponse & { cookie: string }> {
  const code = (await local<PairingCode>('POST', '/remote/pairing-code')).body.code;
  const r = await lan<PairResponse>('POST', '/remote/pair', {
    payload: { code, deviceName: name },
  });
  expect(r.status).toBe(201);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  return { ...r.body, cookie };
}

function openWs(
  url: string,
  protocols: string[] = [],
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; events: StudioEvent[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    const events: StudioEvent[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => events.push(JSON.parse(String(m)) as StudioEvent));
    ws.on('open', () => resolve({ ws, events, closed }));
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
}

const lanWsUrl = () => `ws://${lanHost()}/api/v1/events`;
const lanOrigin = () => `http://${lanHost()}`;

// --- tests ---------------------------------------------------------------------------------------

describe('Web Remote LAN listener', () => {
  it('is off by default; only private LAN addresses are offered', async () => {
    const s = (await local<RemoteSettings>('GET', '/remote/settings')).body;
    expect(s).toMatchObject({ enabled: false, state: 'off', urls: [], pairing: null, devices: [] });
    expect(server.remote.isListening()).toBe(false);
    expect(server.remote.lanApp()).toBeNull();
    expect(s.interfaces).toEqual([
      { name: 'Ethernet', address: '192.168.1.20', kind: 'private', usable: true },
      { name: 'Wi-Fi', address: '203.0.113.7', kind: 'public', usable: false },
      { name: 'Tailscale', address: '100.101.102.103', kind: 'cgnat', usable: false },
    ]);
    expect((await local('GET', '/server-info')).body).toMatchObject({
      remote: { lanEnabled: false, urls: [] },
    });
    // a pairing code needs the listener
    expect((await local('POST', '/remote/pairing-code')).status).toBe(409);
  });

  it('refuses public, VPN and unknown addresses (never 0.0.0.0)', async () => {
    for (const [address, reason] of [
      ['203.0.113.7', 'address_not_private'],
      ['100.101.102.103', 'address_not_private'],
      ['0.0.0.0', 'address_unavailable'],
      ['192.168.9.9', 'address_unavailable'],
    ] as const) {
      const r = await local<{ error: { details: { reason: string } } }>(
        'POST',
        '/remote/settings',
        { enabled: true, address },
      );
      expect(r.status, address).toBe(400);
      expect(r.body.error.details.reason).toBe(reason);
    }
    expect(server.remote.isListening()).toBe(false);
    // With exactly one private interface, enabling without a choice picks it.
    const r = await local<RemoteSettings>('POST', '/remote/settings', { enabled: true });
    expect(r.body).toMatchObject({
      enabled: true,
      state: 'listening',
      interfaceName: 'Ethernet',
      address: '192.168.1.20',
    });
    expect((await local('GET', '/server-info')).body).toMatchObject({
      remote: { lanEnabled: true, urls: server.remote.urls() },
    });
  });

  it('refuses every unpaired request except the remote page and pairing', async () => {
    await enableLan();
    for (const [method, url] of [
      ['GET', '/health'],
      ['GET', '/server-info'],
      ['GET', '/library/albums'],
      ['GET', '/queue'],
      ['POST', '/engine/transport'],
      ['POST', '/remote/unpair'],
      ['GET', '/artwork/abc'],
    ] as const) {
      const r = await lan<{ error: { code: string } }>(method, url, {
        payload: { action: 'play' },
      });
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(r.body.error.code).toBe('unauthorized');
    }
    // the remote's own page, manifest and pairing status are public
    const page = await lan('GET', '/remote/', { raw: true });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    const manifest = await lan('GET', '/remote/manifest.webmanifest', { raw: true });
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect((await lan('GET', '/', { raw: true })).headers.location).toBe('/remote/');
    expect((await lan('GET', '/remote/pairing-status')).body).toEqual({
      lanEnabled: true,
      trusted: false,
      paired: false,
      device: null,
    });
  });

  it('pairs with a one-time code and stores only hashes', async () => {
    await enableLan();
    expect(
      (
        await lan<{ error: { details: { reason: string } } }>('POST', '/remote/pair', {
          payload: { code: '123456', deviceName: 'iPhone' },
        })
      ).body.error.details.reason,
    ).toBe('no_code');

    const created = (await local<PairingCode>('POST', '/remote/pairing-code')).body;
    expect(created.code).toMatch(/^\d{6}$/);
    expect(created.expiresAt).toBe(clock + 5 * 60_000);
    expect(created.urls).toEqual([`${server.remote.urls()[0]}#pair=${created.code}`]);
    expect((await local<RemoteSettings>('GET', '/remote/settings')).body.pairing?.code).toBe(
      created.code,
    );

    const wrong = String((Number(created.code) + 1) % 1_000_000).padStart(6, '0');
    const bad = await lan<{ error: { details: { reason: string; attemptsLeft: number } } }>(
      'POST',
      '/remote/pair',
      { payload: { code: wrong, deviceName: 'iPhone' } },
    );
    expect(bad.status).toBe(401);
    expect(bad.body.error.details).toMatchObject({ reason: 'wrong_code', attemptsLeft: 4 });

    // users may type the code with a space
    const spaced = `${created.code.slice(0, 3)} ${created.code.slice(3)}`;
    const ok = await lan<PairResponse>('POST', '/remote/pair', {
      payload: { code: spaced, deviceName: '  iPhone\u0007 ' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.device.name).toBe('iPhone');
    expect(ok.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(/^hqps_media=[A-Za-z0-9_-]+; Path=\/api\/v1\/artwork;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    // single use
    expect(
      (await lan('POST', '/remote/pair', { payload: { code: created.code, deviceName: 'x' } }))
        .status,
    ).toBe(409);

    const token = ok.body.token;
    expect((await lan('GET', '/library/albums', { token })).status).toBe(200);
    expect((await lan('GET', '/remote/pairing-status', { token })).body).toMatchObject({
      paired: true,
      device: { name: 'iPhone' },
    });

    // only hashes at rest
    const rows = ctx.db.prepare('SELECT * FROM remote_devices').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]).toMatchObject({
      name: 'iPhone',
      token_hash: createHash('sha256').update(token).digest('hex'),
      last_address: PHONE,
    });

    const s = (await local<RemoteSettings>('GET', '/remote/settings')).body;
    expect(s.pairing).toBeNull();
    expect(s.devices).toEqual([
      expect.objectContaining({ name: 'iPhone', lastAddress: PHONE, connected: false }),
    ]);
  });

  it('burns a code after five wrong guesses, expires codes and limits attempts per address', async () => {
    await enableLan();
    const pairAs = (code: string, from = PHONE) =>
      lan<{ error: { code: string; details: { reason: string } } }>('POST', '/remote/pair', {
        payload: { code, deviceName: 'Tablet' },
        from,
      });
    let code = (await local<PairingCode>('POST', '/remote/pairing-code')).body.code;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i += 1)
      expect((await pairAs(wrong, `192.168.1.${60 + i}`)).status).toBe(401);
    const locked = await pairAs(wrong, '192.168.1.70');
    expect(locked.status).toBe(409);
    expect(locked.body.error.details.reason).toBe('code_locked');
    expect((await pairAs(code)).body.error.details.reason).toBe('no_code');

    code = (await local<PairingCode>('POST', '/remote/pairing-code')).body.code;
    clock += 5 * 60_000;
    expect((await pairAs(code)).body.error.details.reason).toBe('expired');

    // 10 attempts per address per 10 minutes, whatever the code
    const attacker = '192.168.1.99';
    for (let i = 0; i < 10; i += 1) {
      await local('POST', '/remote/pairing-code'); // fresh code so it never locks
      expect((await pairAs(wrong, attacker)).status).not.toBe(429);
    }
    const limited = await pairAs(wrong, attacker);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    clock += 10 * 60_000;
    expect((await pairAs(wrong, attacker)).status).not.toBe(429);
  });

  it('never gives LAN clients settings, diagnostics, library-root writes or remote management', async () => {
    await enableLan();
    const { token } = await pairPhone();
    for (const [method, url] of [
      ['GET', '/settings/engine'],
      ['POST', '/settings/engine'],
      ['GET', '/engine/diagnostics'],
      ['POST', '/engine/mock'],
      ['POST', '/library/roots'],
      ['DELETE', '/library/roots/root_x'],
      ['POST', '/library/scan'],
      ['GET', '/remote/settings'],
      ['POST', '/remote/settings'],
      ['POST', '/remote/pairing-code'],
      ['POST', '/remote/pairing-code/cancel'],
      ['POST', '/remote/devices/x/revoke'],
      ['GET', '/settings/lyrics'],
      ['POST', '/settings/lyrics'],
      ['POST', '/settings/lyrics/clear-cache'],
      ['GET', '/tracks/x/lyrics/search'],
      ['POST', '/tracks/x/lyrics/select'],
      ['POST', '/tracks/x/lyrics/reset'],
      ['GET', '/settings/covers'],
      ['POST', '/settings/covers'],
      ['POST', '/settings/covers/fill'],
      ['POST', '/settings/covers/fill/cancel'],
      ['GET', '/library/albums/x/cover/search'],
      ['POST', '/library/albums/x/cover/select'],
      ['POST', '/library/albums/x/cover/reset'],
      ['GET', '/covers/preview?provider=deezer&ref=0123456789abcdef0123456789abcdef'],
    ] as const) {
      const r = await lan(method, url, {
        token,
        payload: {
          enabled: true,
          allowControl: true,
          online: true,
          provider: 'lrclib',
          ref: '1',
          path: 'C:\\',
          action: 'disconnect',
        },
      });
      expect(r.status, `${method} ${url}`).toBe(404);
    }
    expect(ctx.settings.get('engine.allowControl', false)).toBe(false);
    expect(ctx.settings.get('lyrics.online', false)).toBe(false);
    expect(ctx.settings.get('covers.online', false)).toBe(false);
    // ... and no desktop UI either
    expect((await lan('GET', '/index.html', { raw: true, token })).status).toBe(404);
    const info = (await lan<{ trustedClient: boolean }>('GET', '/server-info', { token })).body;
    expect(info.trustedClient).toBe(false);
  });

  it('lets paired phones read lyrics and calibrate the offset', async () => {
    await enableLan();
    const { token } = await pairPhone();
    const track = ctx.library.listTracks({ limit: 1 }).items[0]!;
    const got = await lan<{ state: string; source: string }>('GET', `/tracks/${track.id}/lyrics`, {
      token,
    });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ state: 'found', source: 'demo' });
    // lyric text and timing only — no .lrc or track path, nothing from the settings
    expect(Object.keys(got.body).sort()).toEqual(Object.keys(TrackLyricsSchema.shape).sort());
    expect(JSON.stringify(got.body)).not.toMatch(
      /[A-Z]:\\\\|\\\\\\\\|file:|\.lrc|\/Users\/|\/home\//,
    );
    const cal = await lan<{ offsetMs: number }>('POST', `/tracks/${track.id}/lyrics/offset`, {
      token,
      payload: { offsetMs: 400 },
    });
    expect(cal.body.offsetMs).toBe(400);
    expect((await lan('GET', `/tracks/${track.id}/lyrics`)).status).toBe(401); // unpaired
  });

  it('never sends absolute paths to LAN clients', async () => {
    await enableLan();
    const { token } = await pairPhone();
    const roots = (await lan<{ path: string; name: string }[]>('GET', '/library/roots', { token }))
      .body;
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(r.path).toBe(r.name);
    const album = (
      await lan<{ items: { id: string }[] }>('GET', '/library/albums?limit=1', {
        token,
      })
    ).body.items[0]!;
    await lan('POST', `/playback/album/${album.id}`, { token, payload: {} });
    await vi.waitFor(async () => {
      const local_ = (await local<{ track: { uri: string } | null }>('GET', '/engine/status')).body;
      expect(local_.track?.uri).toMatch(/^[A-Z]:\\/); // this computer sees the real path
    });
    const status = await lan<{ track: { uri: string } }>('GET', '/engine/status', { token });
    expect(status.body.track.uri).toMatch(/^uri:[0-9a-f]{20}$/);
    for (const url of ['/engine/status', '/queue', `/library/albums/${album.id}`]) {
      const text = JSON.stringify(
        (await lan(url === '/queue' ? 'GET' : 'GET', url, { token })).body,
      );
      expect(text, url).not.toMatch(/[A-Z]:\\\\|\\\\\\\\|file:/);
    }
  });

  it('checks Host, Origin, fetch metadata and content type', async () => {
    await enableLan();
    const { token } = await pairPhone();
    const transport = (headers: Record<string, string>) =>
      lan('POST', '/engine/transport', { token, payload: { action: 'pause' }, headers });
    expect((await lan('GET', '/health', { token, headers: { host: 'evil.example' } })).status).toBe(
      403,
    );
    expect((await lan('GET', '/health', { token, headers: { host: '192.168.1.20' } })).status).toBe(
      403,
    );
    // typing the PC's name opens the page on the real address; the API never answers that Host
    const byName = await lan('GET', '/remote/?x=1', {
      raw: true,
      headers: { host: 'music-pc:47321' },
    });
    expect(byName.status).toBe(302);
    expect(byName.headers.location).toBe(`http://${lanHost()}/remote/?x=1`);
    expect(
      (await lan('GET', '//evil.example/', { raw: true, headers: { host: 'music-pc' } })).headers
        .location,
    ).toBe(`http://${lanHost()}//evil.example/`);
    expect(
      (await lan('POST', '/remote/pair', { headers: { host: 'music-pc:47321' }, payload: {} }))
        .status,
    ).toBe(403);
    expect((await transport({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await transport({ origin: `https://${lanHost()}` })).status).toBe(403);
    expect((await transport({ origin: 'null' })).status).toBe(403);
    expect((await transport({ origin: lanOrigin() })).status).not.toBe(403);
    expect((await transport({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await transport({ 'content-type': 'text/plain' })).status).toBe(415);
    // no token in query strings
    expect((await lan('GET', `/library/albums?token=${token}`)).status).toBe(401);
    expect((await lan('GET', `/library/albums?access_token=${token}`)).status).toBe(401);
  });

  it('serves artwork to <img> via the artwork-only cookie', async () => {
    await enableLan();
    const { token, cookie } = await pairPhone();
    const album = (
      await lan<{ items: { artworkId: string }[] }>('GET', '/library/albums?limit=1', {
        token,
      })
    ).body.items[0]!;
    const art = await lan('GET', `/artwork/${album.artworkId}`, { headers: { cookie } });
    expect(art.status).toBe(200);
    expect(art.headers['cache-control']).toContain('private');
    // the cookie unlocks nothing else
    expect((await lan('GET', '/library/albums', { headers: { cookie } })).status).toBe(401);
    expect(
      (await lan('GET', `/artwork/${album.artworkId}`, { headers: { cookie: 'hqps_media=nope' } }))
        .status,
    ).toBe(401);
    // a bearer request without the cookie gets it (re)set
    const again = await lan('GET', '/queue', { token });
    expect(String(again.headers['set-cookie'])).toContain(cookie);
    expect(
      (await lan('GET', '/queue', { token, headers: { cookie } })).headers['set-cookie'],
    ).toBeUndefined();
  });

  it('rate-limits requests and blocks an address after repeated bad tokens', async () => {
    await server.close();
    server = await createStudioServer({
      ...options(),
      remote: {
        ...options().remote,
        security: { authFailures: 3, requestsPerMinute: 40, now: () => clock },
      },
    });
    await server.listen();
    await enableLan();
    const { token } = await pairPhone();
    const attacker = '192.168.1.66';
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await lan('GET', '/queue', { token: `x${i}`.repeat(10), from: attacker })).status,
      ).toBe(401);
    }
    const blocked = await lan('GET', '/queue', { token: 'y'.repeat(20), from: attacker });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // pairing status still answers (so a real phone can find out it must pair again)
    expect((await lan('GET', '/remote/pairing-status', { from: attacker })).status).toBe(200);
    // the paired phone is unaffected
    expect((await lan('GET', '/queue', { token })).status).toBe(200);
    // overall request budget per address
    let last = 0;
    for (let i = 0; i < 45; i += 1) last = (await lan('GET', '/queue', { token })).status;
    expect(last).toBe(429);
    clock += 60_000;
    expect((await lan('GET', '/queue', { token })).status).toBe(200);
  });
});

describe('Web Remote realtime', () => {
  it('desktop and phone see the same state live; the phone recovers after a disconnect', async () => {
    await enableLan();
    const { token } = await pairPhone();
    const localPort = (server.app.server.address() as { port: number }).port;
    const pc = await openWs(`ws://127.0.0.1:${localPort}/api/v1/events`);
    const phone = await openWs(lanWsUrl(), ['hqps.v1', `hqps.auth.${token}`], {
      origin: lanOrigin(),
    });
    expect(phone.ws.protocol).toBe('hqps.v1'); // the token is never echoed back
    await vi.waitFor(() => expect(phone.events[0]?.type).toBe('hello'));
    const hello = phone.events[0] as Extract<StudioEvent, { type: 'hello' }>;
    expect(hello.server.trustedClient).toBe(false);
    expect(
      (await local<RemoteSettings>('GET', '/remote/settings')).body.devices[0]?.connected,
    ).toBe(true);

    // the phone starts an album; both screens follow
    const album = (
      await lan<{ items: { id: string; title: string }[] }>('GET', '/library/albums?q=saltwater', {
        token,
      })
    ).body.items[0]!;
    const played = await lan<QueueState>('POST', `/playback/album/${album.id}`, {
      token,
      payload: {},
      headers: { origin: lanOrigin() },
    });
    expect(played.status).toBe(200);
    const lastQueue = (events: StudioEvent[]) =>
      events.filter((e) => e.type === 'queue.changed').at(-1) as
        Extract<StudioEvent, { type: 'queue.changed' }> | undefined;
    await vi.waitFor(() => {
      for (const c of [pc, phone])
        expect(lastQueue(c.events)?.queue.source?.label).toContain('Saltwater');
    });
    // the desktop skips; the phone sees the engine move
    await local('POST', '/engine/transport', { action: 'next' });
    await vi.waitFor(() => expect(lastQueue(phone.events)?.queue.currentIndex).toBe(1));
    // phone events never contain local paths; the desktop's do
    expect(JSON.stringify(pc.events)).toMatch(/[A-Z]:\\\\/);
    expect(JSON.stringify(phone.events)).not.toMatch(/[A-Z]:\\\\|file:/);
    expect(phone.events.some((e) => e.type === 'remote.changed')).toBe(false);

    // the phone drops off (Wi-Fi sleep) and comes back: hello carries the current state
    phone.ws.terminate();
    await phone.closed;
    const back = await openWs(lanWsUrl(), ['hqps.v1', `hqps.auth.${token}`]);
    await vi.waitFor(() => expect(back.events[0]?.type).toBe('hello'));
    const hello2 = back.events[0] as Extract<StudioEvent, { type: 'hello' }>;
    expect(hello2.queue.currentIndex).toBe(1);
    expect(hello2.queue.source?.label).toContain('Saltwater');
    expect(hello2.status.transport).toBe('playing');
    pc.ws.close();
    back.ws.close();
  });

  it('refuses unauthenticated, cross-origin and query-string-token WebSocket upgrades', async () => {
    await enableLan();
    const { token } = await pairPhone();
    await expect(openWs(lanWsUrl())).rejects.toThrow(/401/);
    await expect(openWs(lanWsUrl(), ['hqps.v1', 'hqps.auth.not-a-real-token'])).rejects.toThrow(
      /401/,
    );
    await expect(openWs(`${lanWsUrl()}?token=${token}`, ['hqps.v1'])).rejects.toThrow(/401/);
    await expect(
      openWs(lanWsUrl(), ['hqps.v1', `hqps.auth.${token}`], { origin: 'http://evil.example' }),
    ).rejects.toThrow(/403/);
    const ok = await openWs(lanWsUrl(), ['hqps.v1', `hqps.auth.${token}`]);
    ok.ws.close();
  });

  it('revoking a device logs it out at once (open connection and HTTP)', async () => {
    await enableLan();
    const { token, device } = await pairPhone();
    const client = createStudioClient({
      baseUrl: server.remote.urls()[0]!.replace(/\/remote\/$/, ''),
      getAuthToken: () => token,
      onUnauthorized: vi.fn(),
    });
    expect((await client.library.albums({ limit: 1 })).items).toHaveLength(1);
    const phone = await openWs(lanWsUrl(), client.eventsProtocols());
    await vi.waitFor(() => expect(phone.events[0]?.type).toBe('hello'));

    expect((await local('POST', `/remote/devices/${device.id}/revoke`)).status).toBe(200);
    expect(await phone.closed).toBe(4401);
    const err = await client.library.albums().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((await client.remote.pairingStatus()).paired).toBe(false);
    expect((await local<RemoteSettings>('GET', '/remote/settings')).body.devices).toEqual([]);
    expect((await local('POST', `/remote/devices/${device.id}/revoke`)).status).toBe(404);
  });

  it('a phone can forget itself', async () => {
    await enableLan();
    const { token } = await pairPhone('iPad');
    expect((await lan('POST', '/remote/unpair', { token })).status).toBe(200);
    expect((await lan('GET', '/queue', { token })).status).toBe(401);
    expect(ctx.remoteDevices.count()).toBe(0);
  });
});

describe('Web Remote lifecycle', () => {
  it('turning LAN access off closes the listener; devices and the setting survive a restart', async () => {
    await enableLan();
    const { token } = await pairPhone();
    const url = server.remote.urls()[0]!;
    await local('POST', '/remote/pairing-code');
    const off = (await local<RemoteSettings>('POST', '/remote/settings', { enabled: false })).body;
    expect(off).toMatchObject({ enabled: false, state: 'off', urls: [], pairing: null });
    expect(off.devices).toHaveLength(1);
    await expect(fetch(`${url}`)).rejects.toThrow();

    await enableLan();
    await server.close();
    server = await createStudioServer(options());
    await server.listen();
    expect(server.remote.isListening()).toBe(true); // saved preference applied at start-up
    expect((await lan('GET', '/queue', { token })).status).toBe(200);
  });

  it('follows the interface to its new address after a network change, never another one', async () => {
    await enableLan();
    expect(ctx.settings.get<{ address: string }>('remote.lan', { address: '' }).address).toBe(
      '192.168.1.20',
    );
    // DHCP gives Ethernet a new address
    interfaces = {
      ...HOME_PC,
      Ethernet: [{ address: '192.168.1.33', family: 'IPv4', internal: false }],
    };
    await server.remote.recheckNow();
    let s = (await local<RemoteSettings>('GET', '/remote/settings')).body;
    expect(s).toMatchObject({
      state: 'listening',
      address: '192.168.1.33',
      interfaceName: 'Ethernet',
    });
    // Ethernet unplugged: only the public Wi-Fi is left -> stop, do not move to Wi-Fi
    interfaces = { 'Wi-Fi': HOME_PC['Wi-Fi'] };
    await server.remote.recheckNow();
    s = (await local<RemoteSettings>('GET', '/remote/settings')).body;
    expect(s).toMatchObject({ state: 'error', error: 'address_unavailable', urls: [] });
    expect(server.remote.isListening()).toBe(false);
    // plugged back in
    interfaces = HOME_PC;
    await server.remote.recheckNow();
    expect(server.remote.isListening()).toBe(true);
  });

  it('reports a port that is already in use', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    try {
      await server.close();
      server = await createStudioServer(options({ port }));
      await server.listen();
      const s = (
        await local<RemoteSettings>('POST', '/remote/settings', {
          enabled: true,
          interfaceName: 'Ethernet',
        })
      ).body;
      expect(s).toMatchObject({ enabled: true, state: 'error', error: 'port_in_use' });
    } finally {
      blocker.close();
    }
  });
});
