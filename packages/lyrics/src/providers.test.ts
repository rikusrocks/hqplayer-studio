import { describe, expect, it } from 'vitest';
import { LrclibClient } from './lrclib';
import { OnlineUnavailableError } from './polite-http';
import {
  KugouProvider,
  LrclibProvider,
  LyricsOvhProvider,
  NeteaseProvider,
  createOnlineLyricsProviders,
  neteaseLyricParams,
  neteaseLyrics,
} from './providers';
import { fakeNetease } from './testing/fake-netease';

// Every lyric line and catalogue entry below is invented for the tests.
const SYNCED = '[00:01.00]first invented line\n[00:03.00]second invented line';
const UA = 'HQPlayerStudio/9.9.9 (unofficial HQPlayer Desktop client)';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake network: answers by path, records what was asked. */
function fakeNet(routes: Record<string, (url: URL) => Response>) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const paths = Object.keys(routes);
    const route =
      paths.find((p) => url.pathname === p) ?? paths.find((p) => url.pathname.startsWith(p));
    if (!route) throw new TypeError('fetch failed');
    return routes[route]!(url);
  }) as typeof fetch;
  const http = { userAgent: UA, fetch: fetchFn, minIntervalMs: 0, sleep: async () => undefined };
  return { calls, http };
}

const q = {
  trackName: 'Invented Song (Remastered 2009)',
  artistName: 'Lin Xia / Chen Mo',
  albumName: 'Fictional Album',
  durationSec: 200,
};

describe('NeteaseProvider', () => {
  const song = (over: Record<string, unknown> = {}) => ({
    id: 501,
    name: 'Invented Song',
    artists: [{ name: 'Lin Xia' }],
    album: { name: 'Fictional Album' },
    duration: 201_000,
    ...over,
  });

  it('searches with the cleaned title + first artist and fetches the closest match', async () => {
    const { calls, http } = fakeNet({
      '/api/search/get': () =>
        json({
          code: 200,
          result: {
            songs: [
              song({ id: 500, duration: 260_000 }), // another recording
              song({ id: 502, name: 'Other Song' }),
              song(),
              { broken: true },
            ],
          },
        }),
      '/api/song/lyric': () => json({ code: 200, lrc: { lyric: SYNCED } }),
    });
    const found = await new NeteaseProvider(http).find(q);
    expect(found).toEqual({ synced: SYNCED, plain: null, instrumental: false });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/search/get', '/api/song/lyric']);
    expect(calls[0]!.url.searchParams.get('s')).toBe('Invented Song Lin Xia');
    expect(calls[1]!.url.searchParams.get('id')).toBe('501');
    expect(calls[0]!.headers['User-Agent']).toBe(UA);
    // names only — nothing that identifies the user or their files
    expect(calls.map((c) => c.url.toString()).join(' ')).not.toMatch(/[A-Z]:\\|\/Users\/|github/i);
  });

  it('understands the newer answer shape, credit lines and instrumentals', async () => {
    expect(
      neteaseLyrics({
        code: 200,
        lrc: { lyric: `{"t":0,"c":[{"tx":"credit"}]}\n${SYNCED}` },
      }),
    ).toEqual({ synced: SYNCED, plain: null, instrumental: false });
    expect(neteaseLyrics({ code: 200, nolyric: true })).toMatchObject({ instrumental: true });
    expect(neteaseLyrics({ code: 200, lrc: { lyric: '' } })).toBeNull();
    const { http } = fakeNet({
      '/api/search/get': () =>
        json({
          code: 200,
          result: {
            songs: [{ id: 7, name: 'X', ar: [{ name: 'Y' }], al: { name: 'Z' }, dt: 9000 }],
          },
        }),
    });
    expect(await new NeteaseProvider(http).search({ text: 'x y' })).toEqual([
      expect.objectContaining({
        provider: 'netease',
        ref: '7',
        trackName: 'X',
        artistName: 'Y',
        albumName: 'Z',
        durationSec: 9,
        synced: null,
      }),
    ]);
  });

  describe('against a service that follows the real version rule', () => {
    const CREDITS = '[00:00.00] 作词 : Invented Writer\n[00:01.00] 作曲 : Invented Composer';
    const catalogue = [
      // Never revised: version 1 — most of the real catalogue.
      { id: 11, name: 'Fresh Song', artists: ['Lin Xia'], durationMs: 200_000, lyric: SYNCED },
      // Revised many times, with credit lines in front.
      {
        id: 12,
        name: 'Fresh Song',
        artists: ['Chen Mo'],
        durationMs: 180_000,
        lyric: `${CREDITS}\n${SYNCED}`,
        lyricVersion: 70,
      },
      {
        id: 13,
        name: 'Fresh Song (Piano)',
        artists: ['Somebody'],
        lyric: `${CREDITS}\n[00:05.00]纯音乐，请欣赏`,
        pureMusic: true,
      },
      { id: 14, name: 'Fresh Song (Cover)', artists: ['Nobody'] }, // no lyrics were ever added
      {
        id: 15,
        name: 'Fresh Song (Demo)',
        artists: ['Credits Only'],
        lyric: '[00:00.00-1] 作词 : Invented Writer\n[00:00.00-1] 作曲 : Invented Composer\n',
      },
    ];
    const provider = () => {
      const net = fakeNetease(catalogue);
      const p = new NeteaseProvider({
        userAgent: UA,
        fetch: net.fetch,
        minIntervalMs: 0,
        sleep: async () => undefined,
      });
      return { net, p };
    };

    it('delivers the lyrics of every listed song that has some, whatever their version', async () => {
      const { net, p } = provider();
      const listed = await p.search({ text: 'Fresh Song' });
      expect(listed.map((c) => c.ref)).toEqual(['11', '12', '13', '14', '15']);
      const picked = new Map<string, Awaited<ReturnType<typeof p.fetch>>>();
      for (const c of listed) picked.set(c.ref, await p.fetch(c.ref));

      // The regression: a version-1 song used to come back empty ("no such lyrics").
      expect(picked.get('11')).toEqual({ synced: SYNCED, plain: null, instrumental: false });
      expect(picked.get('12')?.synced).toContain('second invented line');
      expect(picked.get('13')).toEqual({ synced: null, plain: null, instrumental: true });
      expect(picked.get('14')).toBeNull();
      expect(picked.get('15')).toBeNull(); // credits are not lyrics

      const asked = net.calls.filter((u) => u.pathname === '/api/song/lyric');
      expect(asked.map((u) => Object.fromEntries(u.searchParams))).toEqual(
        listed.map((c) => ({ id: c.ref, lv: '-1', kv: '-1', tv: '-1' })),
      );
    });

    it('finds a never-revised song automatically', async () => {
      const { p } = provider();
      const found = await p.find({
        trackName: 'Fresh Song',
        artistName: 'Lin Xia',
        durationSec: 200,
      });
      expect(found).toEqual({ synced: SYNCED, plain: null, instrumental: false });
    });

    it('the fake really withholds text the caller claims to have (guards the test itself)', async () => {
      const { net } = provider();
      const ask = async (lv: string) =>
        (await (await net.fetch(`https://music.163.com/api/song/lyric?id=11&lv=${lv}`)).json()) as {
          lrc: { version: number; lyric: string };
        };
      expect((await ask('1')).lrc).toEqual({ version: 1, lyric: '' });
      expect((await ask('-1')).lrc.lyric).toBe(SYNCED);
    });
  });

  it('tells lyrics from credits, placeholders and empty answers', () => {
    const credits = '[00:00.00-1] 作词 : Invented Writer\n[00:00.00-1] 作曲 : Invented Composer\n';
    expect(neteaseLyrics({ code: 200, lrc: { version: 1, lyric: credits } })).toBeNull();
    expect(
      neteaseLyrics({ code: 200, uncollected: true, lrc: { version: 1, lyric: '' } }),
    ).toBeNull();
    expect(
      neteaseLyrics({ code: 200, pureMusic: true, lrc: { lyric: '[00:05.00]纯音乐，请欣赏' } }),
    ).toEqual({ synced: null, plain: null, instrumental: true });
    // Credits in front of real lines stay; a sung line with a colon is still a lyric.
    expect(
      neteaseLyrics({ code: 200, lrc: { lyric: `${credits}[00:09.00]She said: stay` } })?.synced,
    ).toContain('She said: stay');
    expect(neteaseLyricParams('42')).toEqual({ id: '42', lv: '-1', kv: '-1', tv: '-1' });
  });

  it('returns null when nothing fits and pauses when the service refuses', async () => {
    const none = fakeNet({ '/api/search/get': () => json({ code: 200, result: {} }) });
    expect(await new NeteaseProvider(none.http).find(q)).toBeNull();
    const refused = fakeNet({ '/api/search/get': () => json({ code: -460, msg: 'no' }) });
    const p = new NeteaseProvider(refused.http);
    await expect(p.find(q)).rejects.toBeInstanceOf(OnlineUnavailableError);
    expect(p.blockedForMs()).toBeGreaterThan(0);
    await expect(p.find(q)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(refused.calls).toHaveLength(1); // nothing sent during the pause
    expect(await p.fetch('not-a-number')).toBeNull();
  });
});

describe('KugouProvider', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    id: '900',
    accesskey: 'ABC123',
    song: 'Invented Song',
    singer: 'Lin Xia',
    duration: 200_500,
    score: 60,
    ...over,
  });
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('asks for "artist - title" with the duration and decodes the downloaded LRC', async () => {
    const { calls, http } = fakeNet({
      '/search': () =>
        json({
          status: 200,
          candidates: [
            candidate({ id: '899', duration: 150_000 }),
            candidate(),
            candidate({ id: 'x', accesskey: '../etc' }),
          ],
        }),
      '/download': () => json({ status: 200, fmt: 'lrc', content: b64(`[ti:x]\n${SYNCED}`) }),
    });
    const found = await new KugouProvider(http).find(q);
    expect(found?.synced).toContain('second invented line');
    expect(calls[0]!.url.searchParams.get('keyword')).toBe('Lin Xia - Invented Song');
    expect(calls[0]!.url.searchParams.get('duration')).toBe('200000');
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toMatchObject({
      id: '900',
      accesskey: 'ABC123',
      fmt: 'lrc',
    });
  });

  it('lists candidates for manual matching and validates references', async () => {
    const { http } = fakeNet({
      '/search': () => json({ status: 200, candidates: [candidate()] }),
      '/download': () => json({ status: 404 }),
    });
    const p = new KugouProvider(http);
    expect(await p.search({ text: 'anything' })).toEqual([
      expect.objectContaining({ provider: 'kugou', ref: '900:ABC123', synced: true }),
    ]);
    expect(await p.fetch('900:ABC123')).toBeNull(); // gone
    expect(await p.fetch('900:../x')).toBeNull(); // not a reference of ours
  });
});

describe('LyricsOvhProvider', () => {
  it('tries the names as tagged, then cleaned, and returns plain lyrics', async () => {
    const { calls, http } = fakeNet({
      '/v1/Lin%20Xia/Invented%20Song%20': () => json({ error: 'No lyrics found' }, 404),
      '/v1/Lin%20Xia/Invented%20Song': () =>
        json({ lyrics: 'Paroles de la chanson X par Y\r\nfirst invented line\r\nsecond' }),
    });
    const found = await new LyricsOvhProvider(http).find({ ...q, artistName: 'Lin Xia' });
    expect(found).toEqual({
      synced: null,
      plain: 'first invented line\nsecond',
      instrumental: false,
    });
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[0]!.url.pathname)).toBe(
      '/v1/Lin Xia/Invented Song (Remastered 2009)',
    );
  });

  it('offers suggestions for manual matching', async () => {
    const { http } = fakeNet({
      '/suggest/': () =>
        json({
          data: [{ title: 'T', artist: { name: 'A' }, album: { title: 'B' }, duration: 12 }],
        }),
      '/v1/A/T': () => json({ lyrics: 'an invented line' }),
    });
    const p = new LyricsOvhProvider(http);
    const [hit] = await p.search({ text: 't a' });
    expect(hit).toMatchObject({ provider: 'lyricsovh', trackName: 'T', synced: false });
    expect((await p.fetch(hit!.ref))?.plain).toBe('an invented line');
    expect(await p.fetch('{"not":"ours"}')).toBeNull();
  });
});

describe('LrclibProvider', () => {
  it('searches once more with the cleaned names when the tagged ones find nothing', async () => {
    const { calls, http } = fakeNet({
      '/api/get': () => json({ code: 404 }, 404),
      '/api/search': (url) =>
        json(
          url.searchParams.get('track_name') === 'Invented Song'
            ? [
                {
                  id: 3,
                  trackName: 'Invented Song',
                  artistName: 'Lin Xia',
                  albumName: 'Other Release',
                  duration: 200,
                  instrumental: false,
                  plainLyrics: null,
                  syncedLyrics: SYNCED,
                },
              ]
            : [],
        ),
    });
    const provider = new LrclibProvider(new LrclibClient(http));
    expect((await provider.find(q))?.synced).toBe(SYNCED);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/get', '/api/search', '/api/search']);
    expect(calls[2]!.url.searchParams.get('artist_name')).toBe('Lin Xia');
  });
});

describe('createOnlineLyricsProviders', () => {
  it('lists the sources in the order they are tried', () => {
    const { http } = fakeNet({});
    expect(createOnlineLyricsProviders(http).map((p) => p.id)).toEqual([
      'lrclib',
      'netease',
      'kugou',
      'lyricsovh',
    ]);
  });
});
