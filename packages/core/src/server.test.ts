import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueState, StudioEvent } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
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
    expect(q.sync.reason).toMatch(/outside Studio/);
    expect(q.items).toHaveLength(6); // plan preserved, not overwritten

    const t = await api<QueueState>('POST', '/queue/takeover', {});
    expect(t.body.sync.state).toBe('in_sync');
    expect((await adapter.getStatus()).transport).toBe('stopped');
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

  it('refuses to bind to a non-loopback interface in Phase 0', async () => {
    await expect(
      createStudioServer({
        adapter: new MockHQPlayerAdapter(),
        ctx,
        appVersion: 't',
        host: '0.0.0.0',
      }),
    ).rejects.toThrow(/Phase 3/);
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
