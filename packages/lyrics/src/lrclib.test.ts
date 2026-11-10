import { describe, expect, it } from 'vitest';
import {
  LrclibClient,
  LrclibUnavailableError,
  parseRetryAfter,
  pickBestRecord,
  type LrclibRecord,
} from './lrclib';

// Invented records; no real lyrics in the repository.
const RECORD = {
  id: 42,
  trackName: '测试之歌',
  artistName: 'Invented Band',
  albumName: 'Fictional Album',
  duration: 201,
  instrumental: false,
  plainLyrics: 'first invented line\nsecond invented line',
  syncedLyrics: '[00:01.00]first invented line\n[00:03.00]second invented line',
};

interface Call {
  url: URL;
  headers: Record<string, string>;
  at: number;
}

function fakeFetch(responses: Array<() => Response>, clock: { t: number }) {
  const calls: Call[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      at: clock.t,
    });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(responses: Array<() => Response>, over: Record<string, unknown> = {}) {
  const clock = { t: 1_000_000 };
  const { fn, calls } = fakeFetch(responses, clock);
  const c = new LrclibClient({
    userAgent: 'HQPlayerStudio/9.9.9 (unofficial HQPlayer Desktop client)',
    fetch: fn,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...over,
  });
  return { c, calls, clock };
}

describe('LrclibClient', () => {
  it('sends the signature query with a User-Agent and returns the record', async () => {
    const { c, calls } = client([() => json(RECORD)]);
    const rec = await c.get({
      trackName: '测试之歌',
      artistName: 'Invented Band',
      albumName: 'Fictional Album',
      durationSec: 200.6,
    });
    expect(rec?.syncedLyrics).toContain('first invented line');
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      track_name: '测试之歌',
      artist_name: 'Invented Band',
      album_name: 'Fictional Album',
      duration: '201',
    });
    expect(headers['User-Agent']).toBe('HQPlayerStudio/9.9.9 (unofficial HQPlayer Desktop client)');
    // nothing personal: no paths, no homepage/account link
    expect(url.toString()).not.toMatch(/[A-Z]:\\|\/Users\/|github/i);
  });

  it('maps 404 to null and validates search results', async () => {
    const { c } = client([
      () =>
        json({ code: 404, name: 'TrackNotFound', message: 'Failed to find specified track' }, 404),
      () => json([RECORD, { nope: true }, { ...RECORD, id: 43, syncedLyrics: null }]),
    ]);
    expect(await c.get({ trackName: 'x', artistName: 'y' })).toBeNull();
    const list = await c.search({ trackName: 'x', artistName: 'y' });
    expect(list.map((r) => r.id)).toEqual([42, 43]);
  });

  it('sends one request at a time, at least minIntervalMs apart', async () => {
    const { c, calls } = client([() => json(RECORD), () => json(RECORD), () => json(RECORD)], {
      minIntervalMs: 1500,
    });
    await Promise.all([c.getById(1), c.getById(2), c.getById(3)]);
    expect(calls.map((x) => x.url.pathname)).toEqual(['/api/get/1', '/api/get/2', '/api/get/3']);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1500);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(1500);
  });

  it('honours 429 + Retry-After: no traffic until it has passed', async () => {
    const { c, calls, clock } = client([
      () => new Response('BODY-SENTINEL-7f3', { status: 429, headers: { 'retry-after': '120' } }),
      () => json(RECORD),
    ]);
    const err = await c.getById(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LrclibUnavailableError);
    expect(err).toMatchObject({ reason: 'rate_limited', retryAfterMs: 120_000 });
    expect((err as Error).message).not.toContain('BODY-SENTINEL'); // bodies never surface
    clock.t += 60_000;
    await expect(c.getById(1)).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(calls).toHaveLength(1);
    expect(c.blockedForMs()).toBe(60_000);
    clock.t += 60_000;
    expect((await c.getById(1))?.id).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('backs off after network errors and 5xx, and caps hostile Retry-After values', async () => {
    const { c, calls, clock } = client([
      () => {
        throw new TypeError('fetch failed');
      },
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
    ]);
    await expect(c.getById(1)).rejects.toMatchObject({
      reason: 'unavailable',
      retryAfterMs: 30_000,
    });
    clock.t += 30_000;
    await expect(c.getById(1)).rejects.toMatchObject({ reason: 'unavailable' });
    clock.t += 30_000;
    await expect(c.getById(1)).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
    expect(calls).toHaveLength(3);
  });

  it('rejects malformed answers without leaking them', async () => {
    const { c } = client([() => new Response('<html>oops</html>', { status: 200 })]);
    await expect(c.getById(1)).rejects.toMatchObject({ reason: 'bad_response' });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe('pickBestRecord', () => {
  const rec = (over: Partial<LrclibRecord>): LrclibRecord => ({ ...RECORD, ...over });
  it('requires the same title, a compatible artist and duration within ±2 s; prefers synced', () => {
    const q = { trackName: '测试之歌', artistName: 'Invented Band', durationSec: 200 };
    expect(
      pickBestRecord(
        [
          rec({ id: 1, duration: 230 }),
          rec({ id: 2, trackName: 'Other' }),
          rec({ id: 3, syncedLyrics: null }),
          rec({ id: 4, duration: 201.5 }),
        ],
        q,
      )?.id,
    ).toBe(4);
    expect(pickBestRecord([rec({ id: 5, artistName: 'Somebody Else' })], q)).toBeNull();
    expect(pickBestRecord([rec({ id: 6, trackName: '测试之歌 ' })], q)?.id).toBe(6);
  });
});
