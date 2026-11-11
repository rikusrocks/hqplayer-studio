import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LyricsCandidate, TrackLyrics } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, type LibraryContext } from '@hqps/library';
import { NeteaseProvider } from '@hqps/lyrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWav } from '../../../library/src/testing/synthetic-audio';
import { fakeNetease } from '../../../lyrics/src/testing/fake-netease';
import { createStudioServer, type StudioServer } from '../server';

/**
 * NetEase lyrics from the search list to the lines on screen, through the HTTP API, with the
 * real `NeteaseProvider` talking to a stand-in that follows the real service's rules (see
 * `fake-netease.ts`). This is the path that used to end in "The source has no such lyrics" for
 * every song whose lyrics were never revised.
 *
 * Every catalogue entry and lyric line here is invented.
 */
const VERSION_1 = '[00:01.00]invented first line\n[00:03.00]invented second line';
const REVISED = '[00:00.00] 作词 : Invented Writer\n[00:02.00]revised invented line';
const CATALOGUE = [
  { id: 101, name: 'Quiet Song', artists: ['Invented Artist'], durationMs: 1000, lyric: VERSION_1 },
  {
    id: 102,
    name: 'Quiet Song (Live)',
    artists: ['Invented Artist'],
    durationMs: 90_000,
    lyric: REVISED,
    lyricVersion: 12,
  },
  {
    id: 103,
    name: 'Quiet Song (Piano)',
    artists: ['Somebody Else'],
    lyric: '[00:05.00]纯音乐，请欣赏',
    pureMusic: true,
  },
  { id: 104, name: 'Quiet Song (Cover)', artists: ['Nobody'] }, // no lyrics on the service
  {
    id: 105,
    name: 'Quiet Song (Demo)',
    artists: ['Credits Only'],
    lyric: '[00:00.00-1] 作词 : Invented Writer\n[00:00.00-1] 作曲 : Invented Composer\n',
  },
];

let dir: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let net: ReturnType<typeof fakeNetease>;

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-lyrics-netease-'));
  const music = join(dir, 'Music', 'Invented Artist', 'Invented Album');
  mkdirSync(music, { recursive: true });
  writeFileSync(
    join(music, '01 Quiet Song.wav'),
    makeWav({ artist: 'Invented Artist', album: 'Invented Album', title: 'Quiet Song' }, 1000),
  );
  ctx = openLibrary(join(dir, 'data'));
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
  net = fakeNetease(CATALOGUE);
  server = await createStudioServer({
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    engine: { commandTimeoutMs: 2000, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    lyrics: {
      providers: [
        new NeteaseProvider({
          userAgent: 'HQPlayerStudio/test',
          fetch: net.fetch,
          minIntervalMs: 0,
          sleep: async () => undefined,
        }),
      ],
    },
  });
  await server.engine.start();
  server.library.addRoot(join(dir, 'Music'));
  await server.library.idle();
  await api('POST', '/settings/lyrics', { online: true, providers: ['netease'] });
}, 30_000);

afterEach(async () => {
  await server.close();
  adapter.dispose();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

const track = () => ctx.library.listTracks({ limit: 10 }).items[0]!.id;

describe('NetEase lyrics, from the search list to the screen', () => {
  it('every listed result that has lyrics can be chosen and shows them', async () => {
    const id = track();
    const listed = await api<LyricsCandidate[]>('GET', `/tracks/${id}/lyrics/search`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((c) => [c.provider, c.ref])).toEqual(
      CATALOGUE.map((s) => ['netease', String(s.id)]),
    );
    const choose = (ref: string) =>
      api<TrackLyrics>('POST', `/tracks/${id}/lyrics/select`, { provider: 'netease', ref });

    // Never revised (version 1) — used to fail with 404 "The source has no such lyrics".
    const fresh = await choose('101');
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({
      state: 'found',
      source: 'netease',
      kind: 'synced',
      selectedByUser: true,
      lines: [
        { timeMs: 1000, text: 'invented first line' },
        { timeMs: 3000, text: 'invented second line' },
      ],
    });
    // The choice is what the player then shows.
    expect((await api<TrackLyrics>('GET', `/tracks/${id}/lyrics`)).body.lines).toHaveLength(2);

    const revised = await choose('102');
    expect(revised.body).toMatchObject({ state: 'found', kind: 'synced' });
    expect(revised.body.lines.at(-1)).toEqual({ timeMs: 2000, text: 'revised invented line' });

    const piano = await choose('103');
    expect(piano.body).toMatchObject({ state: 'found', instrumental: true, lines: [] });
  });

  it('says so when a listed result has no lyrics, and keeps what was chosen before', async () => {
    const id = track();
    const choose = (ref: string) =>
      api<{ error?: { code: string; message: string; details?: { reason?: string } } }>(
        'POST',
        `/tracks/${id}/lyrics/select`,
        { provider: 'netease', ref },
      );
    expect((await choose('101')).status).toBe(200);
    for (const ref of ['104', '105']) {
      const res = await choose(ref);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({
        code: 'not_found',
        message: 'This result has no lyrics; choose another one',
        details: { reason: 'no_lyrics' },
      });
    }
    const still = await api<TrackLyrics>('GET', `/tracks/${id}/lyrics`);
    expect(still.body).toMatchObject({ state: 'found', source: 'netease', selectedByUser: true });
    expect(still.body.lines[0]).toEqual({ timeMs: 1000, text: 'invented first line' });
  });

  it('finds a never-revised song by itself while it plays', async () => {
    const id = track();
    expect((await api('POST', '/queue/replace', { trackIds: [id], autoplay: true })).status).toBe(
      200,
    );
    const res = await api<TrackLyrics>('GET', `/tracks/${id}/lyrics`);
    expect(res.body).toMatchObject({
      state: 'found',
      source: 'netease',
      kind: 'synced',
      selectedByUser: false,
    });
    expect(res.body.lines.map((l) => l.text)).toEqual([
      'invented first line',
      'invented second line',
    ]);
    // One search, one lyric request — and the lyric request asks for any version.
    expect(net.calls.map((u) => u.pathname)).toEqual(['/api/search/get', '/api/song/lyric']);
    expect(net.calls[1]!.searchParams.get('lv')).toBe('-1');
  });
});
