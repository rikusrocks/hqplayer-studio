import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StudioEvent, TrackLyrics } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import {
  LrclibClient,
  LrclibProvider,
  OnlineUnavailableError,
  type OnlineLyrics,
  type OnlineLyricsProvider,
  type OnlineLyricsQuery,
} from '@hqps/lyrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWav } from '../../../library/src/testing/synthetic-audio';
import { createStudioServer, type StudioServer } from '../server';
import { lrclibUserAgent } from './lyrics-service';

// Every lyric line in this file is invented for the tests.
const LOCAL_LRC = '[00:00.50]invented local line one\n[00:02.00]invented local line two';
const ONLINE_SYNCED = '[00:01.00]invented online line\n[00:03.00]another invented line';

let dir: string;
let music: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let lrclibCalls: URL[];
let lrclibResponses: Array<() => Response>;
const events: StudioEvent[] = [];

/** A scripted online source: answers `find` from `next`, records what it was asked. */
interface FakeProvider extends OnlineLyricsProvider {
  finds: OnlineLyricsQuery[];
  next: Array<() => OnlineLyrics | null>;
}
function fakeProvider(id: 'netease' | 'kugou'): FakeProvider {
  const p: FakeProvider = {
    id,
    finds: [],
    next: [],
    blockedForMs: () => 0,
    async find(q) {
      p.finds.push(q);
      return p.next.shift()?.() ?? null;
    },
    async search() {
      return [
        {
          provider: id,
          ref: `${id}-1`,
          trackName: 'Hit',
          artistName: 'Invented Artist',
          albumName: '',
          durationSec: 2,
          synced: null,
          instrumental: false,
          lyrics: null,
        },
      ];
    },
    async fetch(ref) {
      return ref === `${id}-1` ? { synced: ONLINE_SYNCED, plain: null, instrumental: false } : null;
    },
  };
  return p;
}
let netease: FakeProvider;
let kugou: FakeProvider;

const HOOK_TIMEOUT_MS = 30_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const record = (over: Record<string, unknown> = {}) => ({
  id: 7,
  trackName: 'Online Song',
  artistName: 'Invented Artist',
  albumName: 'Invented Album',
  duration: 1,
  instrumental: false,
  plainLyrics: 'invented online line\nanother invented line',
  syncedLyrics: ONLINE_SYNCED,
  ...over,
});
const notFound = () =>
  json({ code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' }, 404);

async function api<T>(method: 'GET' | 'POST', url: string, payload?: unknown) {
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
  return { status: res.statusCode, body: res.json() as T };
}

const trackId = (title: string) =>
  ctx.library.listTracks({ limit: 100 }).items.find((t) => t.title === title)!.id;

async function play(title: string): Promise<string> {
  const id = trackId(title);
  const res = await api('POST', '/queue/replace', { trackIds: [id], autoplay: true });
  expect(res.status).toBe(200);
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-lyrics-core-'));
  music = join(dir, 'Music', 'Invented Artist', 'Invented Album');
  mkdirSync(music, { recursive: true });
  const tags = { artist: 'Invented Artist', album: 'Invented Album' };
  writeFileSync(join(music, '01 Local Song.wav'), makeWav({ ...tags, title: 'Local Song' }, 1000));
  writeFileSync(join(music, '01 Local Song.lrc'), LOCAL_LRC);
  writeFileSync(
    join(music, '02 Online Song.wav'),
    makeWav({ ...tags, title: 'Online Song' }, 1000),
  );
  writeFileSync(join(music, '03 Quiet Song.wav'), makeWav({ ...tags, title: 'Quiet Song' }, 1000));
  ctx = openLibrary(join(dir, 'data'));
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
  lrclibCalls = [];
  lrclibResponses = [];
  netease = fakeProvider('netease');
  kugou = fakeProvider('kugou');
  events.length = 0;
  const lrclib = new LrclibClient({
    userAgent: lrclibUserAgent('test'),
    minIntervalMs: 0,
    sleep: async () => undefined,
    fetch: (async (input: URL | string) => {
      lrclibCalls.push(new URL(String(input)));
      const next = lrclibResponses.shift();
      return next ? next() : notFound();
    }) as typeof fetch,
  });
  server = await createStudioServer({
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    engine: { commandTimeoutMs: 2000, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    lyrics: { providers: [new LrclibProvider(lrclib), netease, kugou] },
  });
  server.hub.subscribe((e) => events.push(e));
  await server.engine.start();
  server.library.addRoot(join(dir, 'Music'));
  await server.library.idle();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await server.close();
  adapter.dispose();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
}, HOOK_TIMEOUT_MS);

describe('lyrics', () => {
  it('is local-only by default: a .lrc next to the file shows, LRCLIB is never contacted', async () => {
    expect((await api('GET', '/settings/lyrics')).body).toMatchObject({ online: false });
    const local = await api<TrackLyrics>('GET', `/tracks/${await play('Local Song')}/lyrics`);
    expect(local.body).toMatchObject({
      state: 'found',
      source: 'local',
      kind: 'synced',
      lines: [
        { timeMs: 500, text: 'invented local line one' },
        { timeMs: 2000, text: 'invented local line two' },
      ],
      online: { enabled: false },
    });
    const none = await api<TrackLyrics>('GET', `/tracks/${await play('Online Song')}/lyrics`);
    expect(none.body).toMatchObject({ state: 'not_found', online: { enabled: false } });
    expect(lrclibCalls).toHaveLength(0);
  });

  it('asks LRCLIB only for the playing track (opt-in), stores the result and the offset', async () => {
    await api('POST', '/settings/lyrics', { online: true });
    const online = trackId('Online Song');
    // Not playing → no lookup, even with online lyrics on (no bulk / browse-time fetching).
    const idle = await api<TrackLyrics>('GET', `/tracks/${online}/lyrics`);
    expect(idle.body).toMatchObject({
      state: 'not_found',
      online: { enabled: true, eligible: false },
    });
    expect(lrclibCalls).toHaveLength(0);

    await play('Online Song');
    lrclibResponses.push(() => json(record()));
    const first = await api<TrackLyrics>('GET', `/tracks/${online}/lyrics`);
    expect(first.body).toMatchObject({ state: 'found', source: 'lrclib', kind: 'synced' });
    expect(first.body.lines[0]).toEqual({ timeMs: 1000, text: 'invented online line' });
    expect(lrclibCalls).toHaveLength(1);
    expect(Object.fromEntries(lrclibCalls[0]!.searchParams)).toEqual({
      track_name: 'Online Song',
      artist_name: 'Invented Artist',
      album_name: 'Invented Album',
      duration: '1',
    });

    // cached: asking again (another client, a restart) does not go online
    await Promise.all([
      api('GET', `/tracks/${online}/lyrics`),
      api('GET', `/tracks/${online}/lyrics`),
    ]);
    expect(lrclibCalls).toHaveLength(1);

    const cal = await api<TrackLyrics>('POST', `/tracks/${online}/lyrics/offset`, {
      offsetMs: -1500,
    });
    expect(cal.body.offsetMs).toBe(-1500);
    expect(events).toContainEqual({ type: 'lyrics.changed', trackId: online });
    expect((await api<TrackLyrics>('GET', `/tracks/${online}/lyrics`)).body.offsetMs).toBe(-1500);
    expect(
      (await api('POST', `/tracks/${online}/lyrics/offset`, { offsetMs: 999_999 })).status,
    ).toBe(400);
  });

  it('remembers "not found", reports outages without breaking playback, and backs off on 429', async () => {
    await api('POST', '/settings/lyrics', { online: true });
    const quiet = await play('Quiet Song');
    lrclibResponses.push(notFound, () => json([]));
    expect((await api<TrackLyrics>('GET', `/tracks/${quiet}/lyrics`)).body.state).toBe('not_found');
    expect(lrclibCalls.map((u) => u.pathname)).toEqual(['/api/get', '/api/search']);
    await api('GET', `/tracks/${quiet}/lyrics`);
    expect(lrclibCalls).toHaveLength(2); // the "no lyrics" answer is remembered

    const online = await play('Online Song');
    lrclibResponses.push(() => new Response('', { status: 429, headers: { 'retry-after': '90' } }));
    const limited = await api<TrackLyrics>('GET', `/tracks/${online}/lyrics`);
    expect(limited.body).toMatchObject({ state: 'unavailable', online: { retryAfterMs: 90_000 } });
    expect(server.engine.getStatus().transport).toBe('playing');
    await api('GET', `/tracks/${online}/lyrics`);
    expect(lrclibCalls).toHaveLength(3); // nothing sent during the back-off
    expect(
      (await api<{ onlinePausedForMs: number }>('GET', '/settings/lyrics')).body.onlinePausedForMs,
    ).toBeGreaterThan(0);
  });

  it('never contacts LRCLIB while scanning, and a local .lrc beats LRCLIB', async () => {
    await api('POST', '/settings/lyrics', { online: true });
    writeFileSync(
      join(music, '04 New Song.wav'),
      makeWav({ title: 'New Song', artist: 'Invented Artist' }, 1000),
    );
    server.library.scan();
    await server.library.idle();
    expect(lrclibCalls).toHaveLength(0);
    const local = await api<TrackLyrics>('GET', `/tracks/${await play('Local Song')}/lyrics`);
    expect(local.body.source).toBe('local');
    expect(lrclibCalls).toHaveLength(0);
  });

  it('lets the user pick LRCLIB lyrics by hand (wins over the .lrc) and undo it', async () => {
    const local = await play('Local Song');
    // Manual search sends names to LRCLIB too, so it needs the opt-in.
    expect((await api('GET', `/tracks/${local}/lyrics/search`)).status).toBe(409);
    await api('POST', '/settings/lyrics', { online: true });
    lrclibResponses.push(() => json([record({ id: 99, trackName: 'Local Song' })]));
    const found = await api<{ provider: string; ref: string; preview: string[] }[]>(
      'GET',
      `/tracks/${local}/lyrics/search?q=local%20song`,
    );
    expect(found.body).toEqual([
      expect.objectContaining({
        provider: 'lrclib',
        ref: '99',
        synced: true,
        preview: ['invented online line', 'another invented line'],
      }),
    ]);
    expect(lrclibCalls.at(-1)?.searchParams.get('q')).toBe('local song');

    lrclibResponses.push(() => json(record({ id: 99 })));
    const picked = await api<TrackLyrics>('POST', `/tracks/${local}/lyrics/select`, {
      provider: 'lrclib',
      ref: '99',
    });
    expect(picked.body).toMatchObject({ source: 'lrclib', selectedByUser: true });
    expect((await api<TrackLyrics>('GET', `/tracks/${local}/lyrics`)).body.source).toBe('lrclib');

    const reset = await api<TrackLyrics>('POST', `/tracks/${local}/lyrics/reset`);
    expect(reset.body).toMatchObject({ source: 'local', selectedByUser: false });
  });

  it('keeps showing stored local lyrics while the music folder is offline', async () => {
    const local = await play('Local Song');
    expect((await api<TrackLyrics>('GET', `/tracks/${local}/lyrics`)).body.source).toBe('local');
    const root = ctx.library.listRoots()[0]!;
    ctx.library.setRootTracksAvailable(root.id, false);
    rmSync(join(music, '01 Local Song.lrc')); // unreachable folder: Studio must not conclude "deleted"
    const offline = await api<TrackLyrics>('GET', `/tracks/${local}/lyrics`);
    expect(offline.body).toMatchObject({ state: 'found', source: 'local' });
    ctx.library.setRootTracksAvailable(root.id, true);
    const back = await api<TrackLyrics>('GET', `/tracks/${local}/lyrics`);
    expect(back.body.state).toBe('not_found'); // online now: the file really is gone
  });

  it('keeps lyric text out of diagnostics', async () => {
    const local = await play('Local Song');
    await api('GET', `/tracks/${local}/lyrics`);
    const diag = await api('GET', '/engine/diagnostics');
    expect(JSON.stringify(diag.body)).not.toContain('invented local line');
  });
});

describe('more online sources', () => {
  const synced = (): OnlineLyrics => ({ synced: ONLINE_SYNCED, plain: null, instrumental: false });
  const plain = (): OnlineLyrics => ({
    synced: null,
    plain: 'an invented plain line',
    instrumental: false,
  });
  type Settings = { online: boolean; providers: { id: string; enabled: boolean }[] };

  it('asks only LRCLIB until the user switches other sources on', async () => {
    const initial = await api<Settings>('GET', '/settings/lyrics');
    expect(initial.body.providers).toEqual([
      expect.objectContaining({ id: 'lrclib', enabled: true }),
      expect.objectContaining({ id: 'netease', enabled: false }),
      expect.objectContaining({ id: 'kugou', enabled: false }),
    ]);
    await api('POST', '/settings/lyrics', { online: true });
    const quiet = await play('Quiet Song');
    lrclibResponses.push(notFound, () => json([]));
    expect((await api<TrackLyrics>('GET', `/tracks/${quiet}/lyrics`)).body.state).toBe('not_found');
    expect(netease.finds).toHaveLength(0);
    expect(kugou.finds).toHaveLength(0);
    expect((await api('POST', '/settings/lyrics', {})).status).toBe(400);
    expect((await api('POST', '/settings/lyrics', { providers: ['bogus'] })).status).toBe(400);
  });

  it('tries the enabled sources in order and prefers synced over plain lyrics', async () => {
    // the order is Studio's, whatever order the request lists them in
    const set = await api<Settings>('POST', '/settings/lyrics', {
      online: true,
      providers: ['kugou', 'lrclib', 'netease'],
    });
    expect(set.body.providers.map((p) => [p.id, p.enabled])).toEqual([
      ['lrclib', true],
      ['netease', true],
      ['kugou', true],
    ]);
    const quiet = await play('Quiet Song');
    lrclibResponses.push(notFound, () => json([]));
    netease.next.push(plain);
    kugou.next.push(synced);
    const res = await api<TrackLyrics>('GET', `/tracks/${quiet}/lyrics`);
    expect(res.body).toMatchObject({ state: 'found', source: 'kugou', kind: 'synced' });
    expect(netease.finds).toEqual([
      {
        trackName: 'Quiet Song',
        artistName: 'Invented Artist',
        albumName: 'Invented Album',
        durationSec: 1,
      },
    ]);

    // nobody has synced lyrics: the plain ones found first are used
    const online = await play('Online Song');
    lrclibResponses.push(notFound, () => json([]));
    netease.next.push(plain);
    const fallback = await api<TrackLyrics>('GET', `/tracks/${online}/lyrics`);
    expect(fallback.body).toMatchObject({
      state: 'found',
      source: 'netease',
      kind: 'plain',
      plain: ['an invented plain line'],
    });
    expect(kugou.finds).toHaveLength(2);
    expect(
      (await api<{ cached: Record<string, number> }>('GET', '/settings/lyrics')).body.cached,
    ).toMatchObject({ netease: 1, kugou: 1, lrclib: 0 });
  });

  it('when one source is down, asks only that one again after the pause', async () => {
    await api('POST', '/settings/lyrics', { online: true, providers: ['lrclib', 'netease'] });
    const quiet = await play('Quiet Song');
    lrclibResponses.push(notFound, () => json([]));
    netease.next.push(() => {
      throw new OnlineUnavailableError('unavailable', 45_000, 'down');
    });
    const down = await api<TrackLyrics>('GET', `/tracks/${quiet}/lyrics`);
    expect(down.body).toMatchObject({ state: 'unavailable', online: { retryAfterMs: 45_000 } });
    expect(lrclibCalls).toHaveLength(2);

    netease.next.push(synced);
    const back = await api<TrackLyrics>('GET', `/tracks/${quiet}/lyrics`);
    expect(back.body).toMatchObject({ state: 'found', source: 'netease' });
    expect(lrclibCalls).toHaveLength(2); // LRCLIB had answered already
    expect(netease.finds).toHaveLength(2);
  });

  it('offers candidates from every enabled source and stores the one picked', async () => {
    await api('POST', '/settings/lyrics', { online: true, providers: ['lrclib', 'netease'] });
    const local = await play('Local Song');
    lrclibResponses.push(() => json([record({ id: 99 })]));
    const found = await api<{ provider: string; ref: string; synced: boolean | null }[]>(
      'GET',
      `/tracks/${local}/lyrics/search`,
    );
    expect(found.body.map((c) => [c.provider, c.ref, c.synced])).toEqual([
      ['lrclib', '99', true],
      ['netease', 'netease-1', null],
    ]);
    const picked = await api<TrackLyrics>('POST', `/tracks/${local}/lyrics/select`, {
      provider: 'netease',
      ref: 'netease-1',
    });
    expect(picked.body).toMatchObject({ source: 'netease', selectedByUser: true, kind: 'synced' });
    const select = (payload: unknown) => api('POST', `/tracks/${local}/lyrics/select`, payload);
    expect((await select({ provider: 'netease', ref: 'gone' })).status).toBe(404);
    expect((await select({ provider: 'kugou', ref: 'kugou-1' })).status).toBe(409); // switched off
    expect((await select({ provider: 'bogus', ref: 'x' })).status).toBe(400);
    expect((await select({ lrclibId: 99 })).status).toBe(400);
  });
});

describe('demo lyrics', () => {
  it('gives the fictional demo library invented, synced demo lyrics — never online', async () => {
    seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
    await api('POST', '/settings/lyrics', { online: true });
    const demo = ctx.library
      .getTrackSources(ctx.library.listTracks({ limit: 500 }).items.map((t) => t.id))
      .find((s) => s.isFixture)!;
    await api('POST', '/queue/replace', { trackIds: [demo.id], autoplay: true });
    const res = await api<TrackLyrics>('GET', `/tracks/${demo.id}/lyrics`);
    expect(res.body).toMatchObject({ state: 'found', source: 'demo', kind: 'synced' });
    expect(res.body.lines.length).toBeGreaterThan(3);
    expect(res.body.lines.every((l) => /演示|Demo|デモ|示例/.test(l.text))).toBe(true);
    expect(lrclibCalls).toHaveLength(0);
  });
});
