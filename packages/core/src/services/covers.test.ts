import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlbumCover, CoverCandidate, CoverSettings, StudioEvent } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWav } from '../../../library/src/testing/synthetic-audio';
import { createStudioServer, type StudioServer } from '../server';
import {
  DeezerCoverSource,
  ItunesCoverSource,
  MusicBrainzCoverSource,
  downloadImage,
  rankCovers,
  sniffImageMime,
  usableAlbumArtist,
} from './cover-sources';
import { MusicBrainzClient } from './online-albums';

// Invented albums and placeholder image bytes only (the cache never decodes images).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const ONLINE_JPEG = Buffer.concat([JPEG, Buffer.from([7, 7, 7])]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const UA = 'HQPlayerStudio/test (unofficial HQPlayer Desktop client)';
const ITUNES_ART =
  'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/invented.jpg/100x100bb.jpg';
const DEEZER_REF = '0123456789abcdef0123456789abcdef';
const MBID = '11111111-2222-4333-8444-555555555555';

let dir: string;
let music: string;
let ctx: LibraryContext;
let adapter: MockHQPlayerAdapter;
let server: StudioServer;
let calls: URL[];
const events: StudioEvent[] = [];

/** What the fake internet knows. Tests change it. */
let net: {
  itunes: unknown[];
  deezer: unknown[];
  musicbrainz: unknown[];
  /** Where the Cover Art Archive redirects to. */
  caaLocation: string | null;
  down: Set<string>;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const image = (bytes: Buffer, type: string) =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });

const fakeFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  calls.push(url);
  if (net.down.has(url.hostname)) throw new TypeError('fetch failed');
  switch (url.hostname) {
    case 'itunes.apple.com':
      return json({ resultCount: net.itunes.length, results: net.itunes });
    case 'api.deezer.com':
      return json({ data: net.deezer, total: net.deezer.length });
    case 'musicbrainz.org':
      return json({ releases: net.musicbrainz });
    case 'is1-ssl.mzstatic.com':
    case 'cdn-images.dzcdn.net':
      return image(ONLINE_JPEG, 'image/jpeg');
    case 'coverartarchive.org':
      return net.caaLocation
        ? new Response(null, { status: 307, headers: { location: net.caaLocation } })
        : new Response('', { status: 404 });
    case 'ia800000.us.archive.org':
      return image(PNG, 'image/png');
    default:
      return image(JPEG, 'image/jpeg'); // a host nobody should ever be sent to
  }
}) as typeof fetch;

const HOOK_TIMEOUT_MS = 30_000;

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
  const type = String(res.headers['content-type'] ?? '');
  return {
    status: res.statusCode,
    type,
    raw: res.rawPayload,
    body: (type.includes('json') ? res.json() : null) as T,
  };
}

const track = (title: string) =>
  ctx.library.listTracks({ limit: 100 }).items.find((t) => t.title === title)!;
const albumOf = (title: string) => track(title).albumId!;
const artworkOf = (albumId: string) => ctx.library.getAlbumCoverTarget(albumId).artworkId;

/** Play a track and wait until the cover lookup it may have started is over. */
async function play(title: string): Promise<void> {
  const res = await api('POST', '/queue/replace', { trackIds: [track(title).id], autoplay: true });
  expect(res.status).toBe(200);
  await server.covers.idle();
}

const itunesHit = (over: Record<string, unknown> = {}) => ({
  collectionName: 'Bare Album (Deluxe Edition)',
  artistName: 'Invented Artist',
  artworkUrl100: ITUNES_ART,
  trackCount: 2,
  releaseDate: '2019-03-01T08:00:00Z',
  ...over,
});
const deezerHit = (over: Record<string, unknown> = {}) => ({
  title: 'Bare Album',
  artist: { name: 'Invented Artist' },
  md5_image: DEEZER_REF,
  nb_tracks: 2,
  ...over,
});
const mbHit = (over: Record<string, unknown> = {}) => ({
  id: MBID,
  title: 'Bare Album',
  date: '2019-03-01',
  'track-count': 2,
  'artist-credit': [{ name: 'Invented Artist' }],
  ...over,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-covers-'));
  music = join(dir, 'Music', 'Invented Artist');
  const bare = join(music, 'Bare Album');
  const covered = join(music, 'Covered Album');
  const other = join(music, 'Other Album');
  for (const d of [bare, covered, other]) mkdirSync(d, { recursive: true });
  const tags = (album: string) => ({ artist: 'Invented Artist', album });
  writeFileSync(join(bare, '01 One.wav'), makeWav({ ...tags('Bare Album'), title: 'One' }, 500));
  writeFileSync(join(bare, '02 Two.wav'), makeWav({ ...tags('Bare Album'), title: 'Two' }, 500));
  writeFileSync(
    join(covered, '01 Three.wav'),
    makeWav({ ...tags('Covered Album'), title: 'Three' }, 500),
  );
  writeFileSync(join(covered, 'cover.jpg'), JPEG);
  writeFileSync(
    join(other, '01 Four.wav'),
    makeWav({ ...tags('Other Album'), title: 'Four' }, 500),
  );

  ctx = openLibrary(join(dir, 'data'));
  adapter = new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 50 });
  calls = [];
  events.length = 0;
  net = { itunes: [], deezer: [], musicbrainz: [], caaLocation: null, down: new Set() };
  const http = { userAgent: UA, fetch: fakeFetch, minIntervalMs: 0 };
  const musicbrainz = new MusicBrainzClient({ userAgent: UA, fetch: fakeFetch, minIntervalMs: 0 });
  server = await createStudioServer({
    adapter,
    ctx,
    appVersion: 'test',
    port: 0,
    engine: { commandTimeoutMs: 2000, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    library: { watch: false },
    covers: {
      fetch: fakeFetch,
      musicbrainz,
      sources: [
        new ItunesCoverSource(http),
        new DeezerCoverSource(http),
        new MusicBrainzCoverSource(musicbrainz),
      ],
    },
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

describe('online covers', () => {
  it('are off by default: nothing is ever sent, searching needs the opt-in', async () => {
    const settings = await api<CoverSettings>('GET', '/settings/covers');
    expect(settings.body).toMatchObject({
      online: false,
      missing: 2,
      fill: { running: false },
      providers: [
        { id: 'itunes', enabled: true },
        { id: 'deezer', enabled: true },
        { id: 'musicbrainz', enabled: true },
      ],
    });
    net.itunes = [itunesHit()];
    await play('One');
    const bare = albumOf('One');
    expect(artworkOf(bare)).toBeNull();
    expect((await api('GET', `/library/albums/${bare}/cover/search`)).status).toBe(409);
    expect((await api('POST', '/settings/covers/fill')).status).toBe(409);
    expect((await api('GET', `/covers/preview?provider=deezer&ref=${DEEZER_REF}`)).status).toBe(
      409,
    );
    expect(
      (
        await api('POST', `/library/albums/${bare}/cover/select`, {
          provider: 'deezer',
          ref: DEEZER_REF,
        })
      ).status,
    ).toBe(409);
    expect(calls).toHaveLength(0);
    expect((await api('POST', '/settings/covers', {})).status).toBe(400);
  });

  it('looks up the playing album when it has no cover, sending names only', async () => {
    await api('POST', '/settings/covers', { online: true });
    net.itunes = [itunesHit({ artistName: 'Somebody Else' }), itunesHit()];
    await play('One');
    const bare = albumOf('One');
    const artworkId = artworkOf(bare);
    expect(artworkId).toMatch(/^art_/);
    expect(ctx.library.getAlbumCoverTarget(bare).artworkSource).toBe('online');
    expect(events.some((e) => e.type === 'library.changed')).toBe(true);
    // one search, then the full-size image from the source's own image host
    expect(calls.map((u) => u.hostname)).toEqual(['itunes.apple.com', 'is1-ssl.mzstatic.com']);
    expect(calls[0]!.searchParams.get('term')).toBe('Invented Artist Bare Album');
    expect(calls[1]!.pathname.endsWith('/1000x1000bb.jpg')).toBe(true);
    expect(calls.map(String).join(' ')).not.toContain(dir);
    // the stored cover is served like any other
    const served = await api('GET', `/artwork/${artworkId}`);
    expect(served.type).toBe('image/jpeg');
    expect(Buffer.compare(served.raw, ONLINE_JPEG)).toBe(0);

    // an album that has a cover on disk is never looked up, nor is the same album twice
    await play('Three');
    await play('Two');
    expect(calls).toHaveLength(2);
    expect(ctx.library.getAlbumCoverTarget(albumOf('Three')).artworkSource).toBe('folder');
  });

  it('falls through the sources in order and remembers "nothing found"', async () => {
    await api('POST', '/settings/covers', { online: true });
    net.deezer = [deezerHit({ title: 'Unrelated' })];
    net.musicbrainz = [mbHit()];
    net.caaLocation = 'https://ia800000.us.archive.org/1/items/mbid/front_thumb1200.png';
    await play('One');
    const bare = albumOf('One');
    expect(artworkOf(bare)).toMatch(/^art_/);
    expect(calls.map((u) => u.hostname)).toEqual([
      'itunes.apple.com',
      'api.deezer.com',
      'musicbrainz.org',
      'coverartarchive.org',
      'ia800000.us.archive.org',
    ]);
    expect(ctx.artwork.resolve(artworkOf(bare)!)?.mime).toBe('image/png'); // judged by the bytes

    // nobody knows "Other Album": asked once, then left alone
    calls.length = 0;
    await play('Four');
    expect(artworkOf(albumOf('Four'))).toBeNull();
    expect(calls).toHaveLength(3);
    await play('One');
    await play('Four');
    expect(calls).toHaveLength(3);
  });

  it('does not conclude "no cover" while a source is unreachable', async () => {
    await api('POST', '/settings/covers', { online: true, providers: ['itunes'] });
    net.down.add('itunes.apple.com');
    await play('One');
    const bare = albumOf('One');
    expect(artworkOf(bare)).toBeNull();
    expect(ctx.library.getOnlineLookup(`cover:${bare}`)).toBeNull();
    const settings = await api<CoverSettings>('GET', '/settings/covers');
    expect(settings.body.providers[0]).toMatchObject({ id: 'itunes', enabled: true });
    expect(settings.body.providers[0]!.pausedForMs).toBeGreaterThan(0);
    expect(settings.body.providers[1]).toMatchObject({ id: 'deezer', enabled: false });
    expect(server.engine.getStatus().transport).toBe('playing'); // playback is unaffected
    // manual search says so instead of pretending there is nothing
    const search = await api('GET', `/library/albums/${bare}/cover/search`);
    expect(search.status).toBe(503);
  });

  it('lets the user pick a cover by hand, preview it, and go back to the local one', async () => {
    await api('POST', '/settings/covers', { online: true });
    net.itunes = [itunesHit({ collectionName: 'Something Else Entirely' })];
    net.deezer = [deezerHit({ title: 'Also Different' })];
    const covered = albumOf('Three');
    const local = artworkOf(covered);

    const found = await api<CoverCandidate[]>(
      'GET',
      `/library/albums/${covered}/cover/search?q=anything%20at%20all`,
    );
    expect(found.body).toEqual([
      {
        provider: 'itunes',
        ref: ITUNES_ART,
        title: 'Something Else Entirely',
        artist: 'Invented Artist',
        year: 2019,
        trackCount: 2,
      },
      {
        provider: 'deezer',
        ref: DEEZER_REF,
        title: 'Also Different',
        artist: 'Invented Artist',
        year: null,
        trackCount: 2,
      },
    ]);
    expect(calls[0]!.searchParams.get('term')).toBe('anything at all');

    // thumbnails come through Core; the host is derived from the validated reference
    calls.length = 0;
    const preview = await api(
      'GET',
      `/covers/preview?provider=deezer&ref=${encodeURIComponent(DEEZER_REF)}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.type).toBe('image/jpeg');
    expect(calls.map(String)).toEqual([
      `https://cdn-images.dzcdn.net/images/cover/${DEEZER_REF}/250x250-000000-80-0-0.jpg`,
    ]);
    await api('GET', `/covers/preview?provider=deezer&ref=${DEEZER_REF}`);
    expect(calls).toHaveLength(1); // cached
    for (const ref of [
      'https://evil.example/100x100bb.jpg',
      'https://evil.example/x.mzstatic.com/100x100bb.jpg',
      'http://is1-ssl.mzstatic.com/a/100x100bb.jpg',
    ]) {
      const bad = await api(
        'GET',
        `/covers/preview?provider=itunes&ref=${encodeURIComponent(ref)}`,
      );
      expect(bad.status, ref).toBe(400);
    }
    expect(calls).toHaveLength(1);

    const picked = await api<AlbumCover>('POST', `/library/albums/${covered}/cover/select`, {
      provider: 'itunes',
      ref: ITUNES_ART,
    });
    expect(picked.body).toMatchObject({ albumId: covered, origin: 'online' });
    expect(picked.body.artworkId).not.toBe(local);
    expect(artworkOf(covered)).toBe(picked.body.artworkId);

    const reset = await api<AlbumCover>('POST', `/library/albums/${covered}/cover/reset`);
    expect(reset.body).toEqual({ albumId: covered, artworkId: local, origin: 'local' });
    expect((await api('POST', '/library/albums/nope/cover/reset')).status).toBe(404);
  });

  it('removing an online cover sticks, and a cover added to the folder is picked up', async () => {
    await api('POST', '/settings/covers', { online: true });
    net.itunes = [itunesHit()];
    await play('One');
    const bare = albumOf('One');
    expect(artworkOf(bare)).toMatch(/^art_/);

    const removed = await api<AlbumCover>('POST', `/library/albums/${bare}/cover/reset`);
    expect(removed.body).toEqual({ albumId: bare, artworkId: null, origin: null });
    calls.length = 0;
    await play('Three');
    await play('One'); // playing it again must not bring the unwanted cover back
    expect(artworkOf(bare)).toBeNull();
    expect(calls).toHaveLength(0);

    writeFileSync(join(music, 'Bare Album', 'Folder.PNG'), PNG);
    const local = await api<AlbumCover>('POST', `/library/albums/${bare}/cover/reset`);
    expect(local.body).toMatchObject({ origin: 'local' });
    expect(ctx.artwork.resolve(local.body.artworkId!)?.mime).toBe('image/png');
    expect(calls).toHaveLength(0);
  });

  it('never follows a redirect to a host that is not the source’s', async () => {
    await api('POST', '/settings/covers', { online: true });
    net.musicbrainz = [mbHit()];
    net.caaLocation = 'https://evil.example/front.jpg';
    const bare = albumOf('One');
    const res = await api('POST', `/library/albums/${bare}/cover/select`, {
      provider: 'musicbrainz',
      ref: MBID,
    });
    expect(res.status).toBe(404);
    expect(artworkOf(bare)).toBeNull();
    expect(calls.map((u) => u.hostname)).not.toContain('evil.example');
  });

  it('finds covers for every album without one when the user starts the job', async () => {
    await api('POST', '/settings/covers', { online: true, providers: ['deezer'] });
    net.deezer = [deezerHit()];
    const started = await api<CoverSettings>('POST', '/settings/covers/fill');
    expect(started.body.fill).toMatchObject({ total: 2 });
    await server.covers.fillIdle();
    const done = await api<CoverSettings>('GET', '/settings/covers');
    expect(done.body.fill).toMatchObject({ running: false, done: 2, total: 2, found: 1 });
    expect(done.body.missing).toBe(1);
    expect(artworkOf(albumOf('One'))).toMatch(/^art_/);
    expect(artworkOf(albumOf('Four'))).toBeNull();
    // only the two albums without a cover were asked about
    expect(
      calls.filter((u) => u.hostname === 'api.deezer.com').map((u) => u.searchParams.get('q')),
    ).toEqual(['Invented Artist Bare Album', 'Invented Artist Other Album']);
  });

  it('leaves the fictional demo library alone', async () => {
    seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
    await api('POST', '/settings/covers', { online: true });
    const demo = ctx.library
      .getTrackSources(ctx.library.listTracks({ limit: 500 }).items.map((t) => t.id))
      .find((s) => s.isFixture)!;
    await api('POST', '/queue/replace', { trackIds: [demo.id], autoplay: true });
    await server.covers.idle();
    expect(calls).toHaveLength(0);
  });
});

describe('cover matching', () => {
  const hit = (over: Partial<CoverCandidate>): CoverCandidate => ({
    provider: 'itunes',
    ref: 'r',
    title: 'Bare Album',
    artist: 'Invented Artist',
    year: null,
    trackCount: 10,
    ...over,
  });
  const wanted = { album: 'Bare Album', artist: 'Invented Artist', trackCount: 10 };

  it('needs the same title and artist; an equal track count ranks first', () => {
    const ranked = rankCovers(
      [
        hit({ ref: 'far', trackCount: 22 }),
        hit({ ref: 'other', artist: 'Somebody Else' }),
        hit({ ref: 'close', title: 'BARE ALBUM (Remastered 2009)', trackCount: 11 }),
        hit({ ref: 'exact', title: 'Bare Album [Deluxe Edition]' }),
        hit({ ref: 'title', title: 'Bare Album II' }),
      ],
      wanted,
    );
    expect(ranked.map((c) => c.ref)).toEqual(['exact', 'close', 'far']);
  });

  it('wants the same track count for compilations without a usable artist', () => {
    expect(usableAlbumArtist('Various Artists')).toBeNull();
    expect(usableAlbumArtist('群星')).toBeNull();
    expect(usableAlbumArtist('Invented Artist')).toBe('Invented Artist');
    const compilation = { ...wanted, artist: null };
    expect(rankCovers([hit({ artist: 'Whoever', trackCount: 9 })], compilation)).toEqual([]);
    expect(rankCovers([hit({ artist: 'Whoever' })], compilation)).toHaveLength(1);
  });
});

describe('image downloads', () => {
  it('recognises images by their bytes', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('<svg onload="x"/>'))).toBeNull();
  });

  it('refuses plain HTTP, foreign hosts, oversized and non-image answers', async () => {
    const seen: string[] = [];
    const opts = (
      body: string | Uint8Array<ArrayBuffer>,
      headers: Record<string, string> = {},
    ) => ({
      userAgent: UA,
      allowsHost: (h: string) => h === 'img.example',
      maxBytes: 64,
      fetch: (async (input: URL | string) => {
        seen.push(String(input));
        return new Response(body, { headers });
      }) as typeof fetch,
    });
    const jpeg = new Uint8Array(JPEG);
    expect(await downloadImage('http://img.example/a.jpg', opts(jpeg))).toBeNull();
    expect(await downloadImage('https://other.example/a.jpg', opts(jpeg))).toBeNull();
    expect(await downloadImage('https://user@img.example/a.jpg', opts(jpeg))).toBeNull();
    expect(seen).toHaveLength(0);
    expect((await downloadImage('https://img.example/a.jpg', opts(jpeg)))?.mime).toBe('image/jpeg');
    expect(
      await downloadImage('https://img.example/a.jpg', opts('<html>not an image</html>')),
    ).toBeNull();
    expect(
      await downloadImage('https://img.example/a.jpg', opts(new Uint8Array(200).fill(0xff))),
    ).toBeNull();
  });
});
