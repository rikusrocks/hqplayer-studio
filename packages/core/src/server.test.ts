import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueState, StudioEvent } from '@hqps/contracts';
import { LiveHQPlayerAdapter, MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { startFakeEngine, type FakeEngine } from '../../hqplayer-adapter/src/testing/fake-engine';
import { startFakeHqpServer } from '../../hqplayer-adapter/src/testing/fake-hqp-server';
import { openLibrary, pathKey, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { createStudioClient } from '@hqps/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { bootstrapStudio } from './bootstrap';
import { createStudioServer, type StudioServer } from './server';

let dir: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:47321' };

async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(method === 'GET' ? { host: '127.0.0.1:47321' } : JSON_HEADERS), ...headers },
    payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  return { status: res.statusCode, body: res.json() as T };
}

async function firstAlbumId(q: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>(
    'GET',
    `/library/albums?q=${encodeURIComponent(q)}`,
  );
  return r.body.items[0]!.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-core-'));
  ctx = openLibrary(dir);
  seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
  server = await createStudioServer({
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    demoMode: true,
    engine: { commandTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
  });
  await server.engine.start();
});

afterEach(async () => {
  await server.close();
  adapter.dispose();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Studio Core REST API', () => {
  it('serves health, server info and library data (no absolute paths in track DTOs)', async () => {
    expect((await api('GET', '/health')).body).toMatchObject({
      ok: true,
      apiVersion: 'v1',
      adapter: 'mock',
    });
    expect((await api('GET', '/server-info')).body).toMatchObject({
      trustedClient: true,
      remote: { lanEnabled: false },
    });
    const albums = await api<{ total: number }>('GET', '/library/albums?sort=year');
    expect(albums.body.total).toBe(13);
    const album = await api<{ tracks: Record<string, unknown>[] }>(
      'GET',
      `/library/albums/${await firstAlbumId('quiet theme')}`,
    );
    expect(album.body.tracks).toHaveLength(12);
    expect(JSON.stringify(album.body)).not.toContain('D:\\\\Music');
    expect((await api('GET', '/library/albums/al_missing')).status).toBe(404);
    expect((await api('GET', '/library/tracks?limit=9999')).status).toBe(400);
  });

  it('runs playlist CRUD with validation', async () => {
    const tracks = (
      await api<{ items: { id: string }[] }>('GET', '/library/tracks?limit=3')
    ).body.items.map((t) => t.id);
    const created = await api<{ id: string; items: { itemId: string }[] }>('POST', '/playlists', {
      name: '测试 Playlist',
      trackIds: tracks,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const reversed = [...created.body.items].reverse().map((i) => i.itemId);
    const reordered = await api<{ items: { itemId: string }[] }>(
      'PATCH',
      `/playlists/${id}/items/order`,
      { itemIds: reversed },
    );
    expect(reordered.body.items.map((i) => i.itemId)).toEqual(reversed);
    expect((await api('PATCH', `/playlists/${id}/items/order`, { itemIds: ['x'] })).status).toBe(
      400,
    );
    expect((await api('POST', '/playlists', { name: '' })).status).toBe(400);
    expect((await api('POST', `/playlists/${id}/items`, { trackIds: ['t_nope'] })).status).toBe(
      404,
    );
    expect((await api('DELETE', `/playlists/${id}`)).status).toBe(200);
    expect((await api('GET', `/playlists/${id}`)).status).toBe(404);
  });

  it('plays an album via the engine and reports engine-confirmed state', async () => {
    const albumId = await firstAlbumId('quiet theme');
    const q = await api<QueueState>('POST', `/playback/album/${albumId}`, {});
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({
      mode: 'album',
      currentIndex: 0,
      source: { kind: 'album', id: albumId },
    });
    expect(q.body.items).toHaveLength(12);
    const status = (
      await api<{ transport: string; track: { studioTrackId: string } }>('GET', '/engine/status')
    ).body;
    expect(status.transport).toBe('playing');
    expect(status.track.studioTrackId).toBe(q.body.items[0]!.track.id);

    await api('POST', '/engine/transport', { action: 'next' });
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.currentIndex).toBe(1),
    );

    const paused = await api<{ status: { transport: string } }>('POST', '/engine/transport', {
      action: 'toggle',
    });
    expect(paused.body.status.transport).toBe('paused');
  });

  it('distinguishes Play Next from Add to Queue and never edits saved playlists', async () => {
    const pl = (await api<{ id: string }[]>('GET', '/playlists')).body[0]!;
    const before = (await api<{ items: unknown[] }>('GET', `/playlists/${pl.id}`)).body.items
      .length;
    await api('POST', `/playback/playlist/${pl.id}`, {});
    const extra = (await api<{ items: { id: string }[] }>('GET', '/library/tracks?q=prism')).body
      .items[0]!.id;
    const next = await api<QueueState>('POST', '/queue/add', {
      trackIds: [extra],
      position: 'next',
    });
    expect(next.body.items[1]!.track.id).toBe(extra);
    const end = await api<QueueState>('POST', '/queue/add', { trackIds: [extra], position: 'end' });
    expect(end.body.items.at(-1)!.track.id).toBe(extra);
    expect((await api<{ items: unknown[] }>('GET', `/playlists/${pl.id}`)).body.items.length).toBe(
      before,
    );
    const engineQueue = await adapter.getEngineQueue();
    expect(engineQueue.entries).toHaveLength(end.body.items.length);
  });

  it('flags an external change as out_of_sync and lets the user take over without autoplay', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {});
    adapter.simulateExternalChange();
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('out_of_sync'),
    );
    const q = (await api<QueueState>('GET', '/queue')).body;
    expect(q.sync.code).toBe('engine_track_differs');
    expect(q.sync.reason).toMatch(/outside Studio/);
    expect(q.items).toHaveLength(6); // plan preserved, not overwritten

    const t = await api<QueueState>('POST', '/queue/takeover', {});
    expect(t.body.sync.state).toBe('in_sync');
    expect((await adapter.getStatus()).transport).toBe('stopped');
  });

  it('"follow HQPlayer" drops a plan HQPlayer cannot match, without touching HQPlayer', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {});
    adapter.simulateExternalChange(); // a file that is not in the library
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('out_of_sync'),
    );
    const engineBefore = await adapter.getEngineQueue();
    const f = await api<QueueState>('POST', '/queue/follow', {});
    expect(f.status).toBe(200);
    expect(f.body.items).toEqual([]);
    expect(f.body.sync.state).not.toBe('out_of_sync');
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync).toMatchObject({
        state: 'unknown',
        code: 'engine_unqueued',
      }),
    );
    expect(await adapter.getEngineQueue()).toEqual(engineBefore);
    expect((await adapter.getStatus()).transport).toBe('playing');
  });

  it('"follow HQPlayer" adopts HQPlayer\'s playlist when every entry is in the library', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {});
    const other = await firstAlbumId('glass architecture');
    const tracks = (await api<{ tracks: { id: string }[] }>('GET', `/library/albums/${other}`)).body
      .tracks;
    const sources = ctx.library.getTrackSources(tracks.map((t) => t.id));
    // someone loads another album in the native HQPlayer UI
    await adapter.replaceQueue(
      sources.map((s) => ({
        studioTrackId: s.id,
        uri: s.sourcePath,
        title: s.title,
        artist: s.artist,
        album: s.album,
        durationMs: s.durationMs,
      })),
      { startIndex: 1, autoplay: true, albumMode: false },
    );
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('out_of_sync'),
    );
    const f = await api<QueueState>('POST', '/queue/follow', {});
    expect(f.body.items.map((i) => i.track.id)).toEqual(tracks.map((t) => t.id));
    expect(f.body.source).toMatchObject({ kind: 'manual', label: 'HQPlayer' });
    await vi.waitFor(async () => {
      const q = (await api<QueueState>('GET', '/queue')).body;
      expect(q.sync.state).toBe('in_sync');
      expect(q.currentIndex).toBe(1);
    });
  });

  it("does not flag a mismatch while HQPlayer catches up with Studio's own change", async () => {
    const slowAdapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
    const slow = await createStudioServer({
      adapter: slowAdapter,
      ctx,
      appVersion: 'test',
      port: 0,
      queue: { settleMs: 400 },
    });
    await slow.engine.start();
    try {
      const album = (await api<{ items: { id: string }[] }>('GET', '/library/albums?q=blue%20hour'))
        .body.items[0]!.id;
      await slow.queue.playAlbum(album);
      slowAdapter.simulateExternalChange();
      await new Promise((r) => setTimeout(r, 150));
      expect(slow.queue.get().sync.state).toBe('in_sync');
      await vi.waitFor(() => expect(slow.queue.get().sync.state).toBe('out_of_sync'), {
        timeout: 2000,
      });
    } finally {
      await slow.close();
      slowAdapter.dispose();
    }
  });

  it('reports engine outages honestly and recovers without auto-playing', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {});
    await api('POST', '/engine/transport', { action: 'pause' });
    adapter.simulateDisconnect();
    await vi.waitFor(async () =>
      expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('engine_offline'),
    );
    const fail = await api<{ error: { code: string } }>('POST', '/engine/transport', {
      action: 'play',
    });
    expect(fail.status).toBe(503);
    expect(fail.body.error.code).toBe('engine_unavailable');
    expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('engine_offline');

    adapter.simulateReconnect();
    await vi.waitFor(
      async () => expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('in_sync'),
      { timeout: 3000 },
    );
    const status = (await api<{ connection: string; transport: string }>('GET', '/engine/status'))
      .body;
    expect(status.connection).toBe('connected');
    expect(status.transport).toBe('paused'); // nothing was resumed automatically
    expect((await api<QueueState>('GET', '/queue')).body.sync.state).toBe('in_sync');
  });

  it('surfaces an ACK timeout and leaves the plan unchanged (no silent retry)', async () => {
    const before = (await api<QueueState>('GET', '/queue')).body;
    adapter.failNextCommand();
    const res = await api<{ error: { code: string } }>(
      'POST',
      `/playback/album/${await firstAlbumId('folded maps')}`,
      {},
    );
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('engine_timeout');
    const after = (await api<QueueState>('GET', '/queue')).body;
    expect(after.items).toHaveLength(before.items.length);
    expect((await adapter.getEngineQueue()).entries).toHaveLength(0);
  });

  it('serialises concurrent commands from Desktop and Web into a consistent final state', async () => {
    const a = await firstAlbumId('blue hour');
    const b = await firstAlbumId('glass architecture');
    const [r1, r2] = await Promise.all([
      api<QueueState>('POST', `/playback/album/${a}`, {}),
      api<QueueState>('POST', `/playback/album/${b}`, {}),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const q = (await api<QueueState>('GET', '/queue')).body;
    const engineQueue = await adapter.getEngineQueue();
    expect(q.source?.id).toBe(b);
    expect(engineQueue.entries.map((e) => e.title)).toEqual(q.items.map((i) => i.track.title));
  });

  it('rejects cross-origin writes, non-JSON bodies, foreign Host headers and non-loopback clients', async () => {
    expect(
      (
        await api(
          'POST',
          '/engine/transport',
          { action: 'play' },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          'POST',
          '/engine/transport',
          { action: 'play' },
          { origin: 'http://localhost:5173' },
        )
      ).status,
    ).not.toBe(403);
    expect(
      (await api('GET', '/health', undefined, { host: 'rebind.attacker.example' })).status,
    ).toBe(403);
    const form = await server.app.inject({
      method: 'POST',
      url: '/api/v1/engine/transport',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1' },
      payload: 'action=play',
      remoteAddress: '127.0.0.1',
    });
    expect(form.statusCode).toBe(415);
    const lan = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: '127.0.0.1' },
      remoteAddress: '192.168.1.50',
    });
    expect(lan.statusCode).toBe(403);
  });

  it('serves artwork only by validated id', async () => {
    const album = (await api<{ items: { artworkId: string }[] }>('GET', '/library/albums?limit=1'))
      .body.items[0]!;
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/v1/artwork/${album.artworkId}`,
      headers: { host: '127.0.0.1' },
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    const bad = await server.app.inject({
      method: 'GET',
      url: '/api/v1/artwork/..%2F..%2Fstudio.sqlite',
      headers: { host: '127.0.0.1' },
      remoteAddress: '127.0.0.1',
    });
    expect(bad.statusCode).toBe(404);
  });

  it('keeps the main listener loopback-only (LAN access is a separate, opt-in listener)', async () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
      await expect(
        createStudioServer({ adapter: new MockHQPlayerAdapter(), ctx, appVersion: 't', host }),
      ).rejects.toThrow(/loopback-only/);
    }
  });

  it('deletes a playlist through the typed client (DELETE carries a JSON body)', async () => {
    const { url } = await server.listen();
    const client = createStudioClient({ baseUrl: url });
    const pl = (await client.playlists.list())[0]!;
    await expect(client.playlists.remove(pl.id)).resolves.toEqual({ ok: true });
    await expect(client.playlists.get(pl.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('engine settings and read-only engine queue', () => {
  it('reports and saves the preferred adapter without switching the running one', async () => {
    const initial = await api<Record<string, unknown>>('GET', '/settings/engine');
    expect(initial.body).toMatchObject({
      activeAdapter: 'mock',
      preferredAdapter: 'mock',
      source: 'default',
      restartRequired: false,
      hqplayer: { host: '127.0.0.1', port: 4321 },
      allowControl: false,
    });
    const saved = await api<Record<string, unknown>>('POST', '/settings/engine', {
      adapter: 'live',
    });
    expect(saved.body).toMatchObject({
      activeAdapter: 'mock',
      preferredAdapter: 'live',
      restartRequired: true,
    });
    expect(ctx.settings.get('engine.adapter', null)).toBe('live');
    expect((await api('POST', '/settings/engine', { adapter: 'nope' })).status).toBe(400);
  });

  it('lists the engine playlist read-only, matched to the library, without file paths', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {});
    const q = await api<{ entries: { index: number; studioTrackId: string | null }[] }>(
      'GET',
      '/engine/queue',
    );
    expect(q.status).toBe(200);
    expect(q.body.entries).toHaveLength(6);
    expect(q.body.entries[0]).toMatchObject({ index: 0 });
    expect(q.body.entries.every((e) => e.studioTrackId)).toBe(true);
    expect(JSON.stringify(q.body)).not.toMatch(/uri|D:\\\\|Music/);
  });
});

describe('control switch with the live adapter', () => {
  it('enables confirmed writes immediately and never sends demo tracks to a real engine', async () => {
    const xml = (b: string) => `<?xml version="1.0" encoding="UTF-8"?>${b}\n`;
    const fake = await startFakeHqpServer({
      GetInfo: () =>
        xml('<GetInfo product="Signalyst HQPlayer Desktop" version="6" engine="6.1.0"/>'),
      VolumeRange: () => xml('<VolumeRange enabled="0" min="-12" max="0"/>'),
      PlaylistGet: () => xml('<PlaylistGet album="0"/>'),
      Status: () => xml('<Status state="0" track="0" position="0" length="0"/>'),
      State: () => xml('<State state="0" repeat="0" random="0"/>'),
    });
    const liveDir = mkdtempSync(join(tmpdir(), 'hqps-live-'));
    const liveCtx = openLibrary(liveDir);
    seedDemoLibrary(liveCtx.library, liveCtx.playlists, liveCtx.artwork);
    const live = await createStudioServer({
      adapter: new LiveHQPlayerAdapter({ port: fake.port }),
      ctx: liveCtx,
      appVersion: 't',
      port: 0,
    });
    await live.engine.start();
    const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await live.app.inject({
        method,
        url: `/api/v1${url}`,
        headers:
          method === 'GET'
            ? { host: '127.0.0.1' }
            : { host: '127.0.0.1', 'content-type': 'application/json' },
        payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
        remoteAddress: '127.0.0.1',
      });
      return { status: res.statusCode, body: res.json() as T };
    };
    try {
      type Caps = { items: Record<string, { usable: boolean; status: string }> };
      expect(
        (await call<{ allowControl: boolean }>('GET', '/settings/engine')).body.allowControl,
      ).toBe(false);
      expect(
        (await call<Caps>('GET', '/engine/capabilities')).body.items['transport.play'],
      ).toMatchObject({ status: 'confirmed', usable: false });
      expect((await call('POST', '/engine/transport', { action: 'play' })).status).toBe(409);

      const on = await call<{ allowControl: boolean }>('POST', '/settings/engine', {
        allowControl: true,
      });
      expect(on.body.allowControl).toBe(true);
      const caps = (await call<Caps>('GET', '/engine/capabilities')).body.items;
      expect(caps['transport.play']?.usable).toBe(true);
      expect(caps['queue.replace']?.usable).toBe(true);
      expect(caps['volume.set']?.usable).toBe(false); // HQPlayer volume control disabled
      expect(caps['dsp.write']?.usable).toBe(false);

      const album = (
        await call<{ items: { id: string }[] }>('GET', '/library/albums?q=blue%20hour')
      ).body.items[0]!;
      const refused = await call<{ error: { code: string; message: string } }>(
        'POST',
        `/playback/album/${album.id}`,
        {},
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/Demo tracks/);
      expect(fake.received.map((r) => r.name)).not.toContain('PlaylistClear');
      expect(fake.received.map((r) => r.name)).not.toContain('PlaylistAdd');

      await call('POST', '/settings/engine', { allowControl: false });
      expect(
        (await call<Caps>('GET', '/engine/capabilities')).body.items['transport.play']?.usable,
      ).toBe(false);
    } finally {
      await live.close();
      liveCtx.close();
      await fake.close();
      rmSync(liveDir, { recursive: true, force: true });
    }
  });
});

describe('bootstrap adapter precedence', () => {
  it('uses the saved preference unless a launch override is given', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hqps-boot-'));
    const pre = openLibrary(dataDir);
    pre.settings.set('engine.adapter', 'live');
    pre.close();
    const common = { dataDir, appVersion: 't', port: 0, demo: false, hqplayer: { port: 1 } };
    const live = await bootstrapStudio(common);
    expect(live.server.engine.adapter.kind).toBe('live');
    expect(live.server.engineInfo.source).toBe('setting');
    await live.server.close();
    live.ctx.close();
    const forced = await bootstrapStudio({ ...common, adapter: 'mock' });
    expect(forced.server.engine.adapter.kind).toBe('mock');
    expect(forced.server.engineInfo.source).toBe('override');
    await forced.server.close();
    forced.ctx.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('WebSocket events', () => {
  it('sends hello, then engine and queue updates to every client', async () => {
    const { port } = await server.listen();
    const open = (headers: Record<string, string> = {}) =>
      new Promise<{ ws: WebSocket; events: StudioEvent[] }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, { headers });
        const events: StudioEvent[] = [];
        ws.on('message', (m) => events.push(JSON.parse(String(m)) as StudioEvent));
        ws.on('open', () => resolve({ ws, events }));
        ws.on('error', reject);
        ws.on('unexpected-response', (req, res) => {
          req.destroy();
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
    const desktop = await open();
    const remote = await open({ origin: `http://127.0.0.1:${port}` });
    await vi.waitFor(() => expect(desktop.events[0]?.type).toBe('hello'));

    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/playback/album/${await firstAlbumId('saltwater')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      for (const client of [desktop, remote]) {
        const last = client.events.filter((e) => e.type === 'queue.changed').at(-1);
        expect(last && last.type === 'queue.changed' && last.queue.source?.label).toContain(
          'Saltwater Hymns',
        );
      }
    });
    for (const client of [desktop, remote]) {
      const types = new Set(client.events.map((e) => e.type));
      expect(types.has('engine.status')).toBe(true);
      expect(types.has('queue.changed')).toBe(true);
      const lastQueue = client.events.filter((e) => e.type === 'queue.changed').at(-1);
      expect(
        lastQueue && lastQueue.type === 'queue.changed' && lastQueue.queue.source?.label,
      ).toContain('Saltwater Hymns');
    }
    await expect(open({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
    desktop.ws.close();
    remote.ws.close();
  });
});

/** A "real" (non-demo) album on a network share, as a library scan on Windows would record it. */
function addShareAlbum(lib: LibraryContext['library'], title: string, count: number) {
  const folder = `\\\\nas\\music\\${title}`;
  const root = lib.addRoot(folder);
  const now = Date.now();
  const albumId = lib.ensureAlbum({
    title,
    albumArtist: 'Test Artist',
    year: 2024,
    releaseId: null,
    rootId: root.id,
    folder: '',
    now,
  });
  const ids: string[] = [];
  const paths: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const fileName = `0${i} Song ${i} 100% live.flac`;
    const sourcePath = `${folder}\\${fileName}`;
    const { id } = lib.upsertTrack({
      rootId: root.id,
      sourcePath,
      pathKey: pathKey(sourcePath, 'win32'),
      relativeDir: '',
      fileName,
      fileIdentity: null,
      title: `Song ${i}`,
      artist: 'Test Artist',
      albumArtist: 'Test Artist',
      album: title,
      albumId,
      genre: null,
      year: 2024,
      discNumber: 1,
      discTotal: 1,
      trackNumber: i,
      trackTotal: count,
      durationMs: 200_000,
      sampleRate: 96_000,
      bitDepth: 24,
      channels: 2,
      codec: 'FLAC',
      container: 'FLAC',
      lossless: true,
      isDsd: false,
      bitrate: null,
      mtimeMs: now,
      sizeBytes: 1,
      metadataSource: 'tags',
      scanError: null,
      seenAt: now,
    });
    ids.push(id);
    paths.push(sourcePath);
  }
  return { albumId, ids, paths, uris: paths.map((p) => `file://${p}`) };
}

describe('queue control against a busy HQPlayer (stateful stand-in engine)', () => {
  const OTHER = { uri: 'file://E:\\Other\\not in library.flac', song: 'other', lengthSec: 300 };
  let engine: FakeEngine | null = null;
  let liveDir: string;
  let liveCtx: LibraryContext;
  const studios: StudioServer[] = [];

  beforeEach(() => {
    liveDir = mkdtempSync(join(tmpdir(), 'hqps-busy-'));
    liveCtx = openLibrary(liveDir);
  });
  afterEach(async () => {
    for (const st of studios.splice(0)) await st.close();
    await engine?.close();
    engine = null;
    liveCtx.close();
    rmSync(liveDir, { recursive: true, force: true });
  });

  async function startStudio(onCtx: LibraryContext = liveCtx) {
    const studio = await createStudioServer({
      adapter: new LiveHQPlayerAdapter({ port: engine!.port, policy: { controlEnabled: true } }),
      ctx: onCtx,
      appVersion: 't',
      port: 0,
      queue: { settleMs: 0 },
    });
    studios.push(studio);
    await studio.engine.start();
    const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await studio.app.inject({
        method,
        url: `/api/v1${url}`,
        headers:
          method === 'GET'
            ? { host: '127.0.0.1' }
            : { host: '127.0.0.1', 'content-type': 'application/json' },
        payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
        remoteAddress: '127.0.0.1',
      });
      return { status: res.statusCode, body: res.json() as T };
    };
    return { studio, call };
  }

  it('playing an album while HQPlayer plays something else really switches to that album', async () => {
    engine = await startFakeEngine({ playlist: [OTHER], startPlaying: true });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const { studio, call } = await startStudio();
    await vi.waitFor(() => expect(studio.engine.getStatus().transport).toBe('playing'));

    const res = await call<QueueState>('POST', `/playback/album/${a.albumId}`, {});
    expect(res.status).toBe(200);
    expect(engine.playlist().map((t) => t.uri)).toEqual(a.uris); // nothing left behind
    expect(engine.state()).toMatchObject({ transport: 2, current: 1 });
    await vi.waitFor(() => {
      expect(studio.engine.getStatus().track?.studioTrackId).toBe(a.ids[0]);
      expect(studio.queue.get().sync.state).toBe('in_sync');
    });
  });

  it('clearing the queue stops HQPlayer and leaves no track behind', async () => {
    engine = await startFakeEngine({ playlist: [OTHER] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const { studio, call } = await startStudio();
    await call('POST', `/playback/album/${a.albumId}`, {});
    expect(engine.state().transport).toBe(2);

    const res = await call<QueueState>('POST', '/queue/clear', {});
    expect(res.status).toBe(200);
    expect(engine.playlist()).toEqual([]);
    expect(engine.state().transport).toBe(0);
    await vi.waitFor(() => expect(studio.queue.get().sync.state).toBe('in_sync'));
    expect(studio.queue.get().items).toEqual([]);
  });

  it('v0.1.5 report: clear while playing leaves no song even when HQPlayer stops slowly', async () => {
    // HQPlayer ACKs Stop before it has stopped; the playing track can't be cleared/removed yet.
    engine = await startFakeEngine({ playlist: [], stopDelayMs: 400 });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const { studio, call } = await startStudio();
    await call('POST', `/playback/album/${a.albumId}`, {});
    await vi.waitFor(() => expect(studio.engine.getStatus().transport).toBe('playing'));

    const res = await call<QueueState>('POST', '/queue/clear', {});
    expect(res.status).toBe(200);
    expect(engine.playlist()).toEqual([]);
    expect(engine.state().transport).toBe(0);

    // and switching albums mid-song really switches
    const b = addShareAlbum(liveCtx.library, 'Album B', 2);
    await call('POST', `/playback/album/${a.albumId}`, {});
    await vi.waitFor(() => expect(studio.engine.getStatus().transport).toBe('playing'));
    const sw = await call<QueueState>('POST', `/playback/album/${b.albumId}`, {});
    expect(sw.status).toBe(200);
    expect(engine.playlist().map((t) => t.uri)).toEqual(b.uris);

    const diag = await call<{ protocol: { entries: { dir: string; text: string }[] } }>(
      'GET',
      '/engine/diagnostics',
    );
    expect(diag.status).toBe(200);
    const text = JSON.stringify(diag.body);
    expect(text).toMatch(/stopped confirmed after/);
    expect(text).not.toMatch(/nas|Song 1|Album A|Test Artist/i); // paths + metadata redacted
    expect(text).toMatch(/uri#\d+\.flac/);
  });

  it("take over after a change in the native UI: HQPlayer stopped, holds exactly Studio's queue, stays in sync", async () => {
    engine = await startFakeEngine({ playlist: [] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const { studio, call } = await startStudio();
    await call('POST', `/playback/album/${a.albumId}`, {});
    engine.external([OTHER]);
    await vi.waitFor(() =>
      expect(studio.queue.get().sync).toMatchObject({
        state: 'out_of_sync',
        code: 'engine_track_differs',
      }),
    );

    const res = await call<QueueState>('POST', '/queue/takeover', {});
    expect(res.status).toBe(200);
    expect(engine.playlist().map((t) => t.uri)).toEqual(a.uris);
    expect(engine.state().transport).toBe(0); // takeover never starts playback
    await new Promise((r) => setTimeout(r, 300)); // several Status pushes later…
    expect(studio.queue.get().sync.state).toBe('in_sync');
  });

  it('"follow HQPlayer" adopts its playlist and sends HQPlayer no write command', async () => {
    engine = await startFakeEngine({ playlist: [] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const b = addShareAlbum(liveCtx.library, 'Album B', 2);
    const { studio, call } = await startStudio();
    await call('POST', `/playback/album/${a.albumId}`, {});
    engine.external(b.uris.map((uri) => ({ uri, song: 'b', lengthSec: 300 })));
    await vi.waitFor(() => expect(studio.queue.get().sync.state).toBe('out_of_sync'));

    const sentBefore = engine.received.length;
    const res = await call<QueueState>('POST', '/queue/follow', {});
    expect(res.body.items.map((i) => i.track.id)).toEqual(b.ids);
    expect(engine.received.slice(sentBefore).map((r) => r.name)).toEqual(['PlaylistGet']);
    expect(engine.state()).toMatchObject({ transport: 2, current: 1 }); // still playing
    await vi.waitFor(() => expect(studio.queue.get().sync.state).toBe('in_sync'));
  });

  it('after a restart, a stale plan does not raise an alarm: Studio follows HQPlayer', async () => {
    engine = await startFakeEngine({ playlist: [] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const first = await startStudio();
    await first.call('POST', `/playback/album/${a.albumId}`, {});
    await first.studio.close();
    studios.splice(studios.indexOf(first.studio), 1);
    engine.external([OTHER]); // meanwhile someone played other music in HQPlayer

    const { studio } = await startStudio();
    await vi.waitFor(() =>
      expect(studio.queue.get().sync).toMatchObject({ state: 'unknown', code: 'engine_unqueued' }),
    );
    expect(studio.queue.get().items).toEqual([]);
    expect(engine.playlist().map((t) => t.uri)).toEqual([OTHER.uri]); // HQPlayer untouched
  });

  it('after a restart, a plan that still matches HQPlayer is kept', async () => {
    engine = await startFakeEngine({ playlist: [] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const first = await startStudio();
    const played = await first.call<QueueState>('POST', `/playback/album/${a.albumId}`, {});
    await first.studio.close();
    studios.splice(studios.indexOf(first.studio), 1);

    const { studio } = await startStudio();
    await vi.waitFor(() => expect(studio.queue.get().sync.state).toBe('in_sync'));
    expect(studio.queue.get().sessionId).toBe(played.body.sessionId);
    expect(studio.queue.get().items).toHaveLength(3);
  });

  it('after a restart with an empty HQPlayer playlist, the plan is kept and can be pushed back', async () => {
    engine = await startFakeEngine({ playlist: [] });
    const a = addShareAlbum(liveCtx.library, 'Album A', 3);
    const first = await startStudio();
    await first.call('POST', `/playback/album/${a.albumId}`, {});
    await first.studio.close();
    studios.splice(studios.indexOf(first.studio), 1);
    engine.external([]); // HQPlayer restarted with nothing loaded

    const { studio } = await startStudio();
    await vi.waitFor(() =>
      expect(studio.queue.get().sync).toMatchObject({
        state: 'out_of_sync',
        code: 'engine_playlist_empty',
      }),
    );
    expect(studio.queue.get().items).toHaveLength(3);
  });

  it('jumping to a queue track while playing really plays it, whether or not HQPlayer switches by itself', async () => {
    for (const ignores of [false, true]) {
      engine = await startFakeEngine({
        playlist: [],
        selectIgnoredWhilePlaying: ignores,
        stopDelayMs: ignores ? 200 : 0,
      });
      const a = addShareAlbum(liveCtx.library, `Album ${ignores ? 'B' : 'A'}`, 3);
      const { studio, call } = await startStudio();
      await call('POST', `/playback/album/${a.albumId}`, {});
      await vi.waitFor(() => expect(studio.engine.getStatus().transport).toBe('playing'));
      const before = engine.received.length;
      const res = await call<QueueState>('POST', '/queue/jump', { index: 2 });
      expect(res.status).toBe(200);
      expect(engine.state()).toMatchObject({ transport: 2, current: 3 });
      const names = engine.received.slice(before).map((r) => r.name);
      expect(names.includes('Stop')).toBe(ignores); // the slow path only when needed
      for (const st of studios.splice(0)) await st.close();
      await engine.close();
    }
    engine = null;
  });

  it('shows library artwork for a track HQPlayer plays on its own', async () => {
    const a = addShareAlbum(liveCtx.library, 'Album A', 2);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const art = liveCtx.artwork.put(png, 'image/png', 'folder') as string;
    liveCtx.library.setAlbumArtwork(a.albumId, art);
    engine = await startFakeEngine({
      playlist: a.uris.map((uri) => ({ uri, song: 'x', lengthSec: 300 })),
      startPlaying: true,
    });
    const { studio } = await startStudio();
    await vi.waitFor(() =>
      expect(studio.engine.getStatus().track).toMatchObject({
        studioTrackId: a.ids[0],
        artworkId: art,
      }),
    );
    expect(studio.queue.get().items).toEqual([]); // not from Studio's queue
  });

  it('never restores a queue of demo tracks when connected to a real HQPlayer', async () => {
    await api('POST', `/playback/album/${await firstAlbumId('blue hour')}`, {}); // mock mode, demo
    expect(ctx.queue.load()?.items.length).toBe(6);
    engine = await startFakeEngine({ playlist: [] });
    const { studio } = await startStudio(ctx);
    expect(studio.queue.get().items).toEqual([]);
  });
});
