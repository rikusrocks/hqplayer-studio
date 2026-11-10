import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLibrary, scanRoot, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWav } from '../../../library/src/testing/synthetic-audio';
import { matchShare, MusicBrainzClient, OnlineAlbumChecker } from './online-albums';

let dir: string;
let ctx: LibraryContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-mb-'));
  ctx = openLibrary(join(dir, 'data'));
});
afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A folder the local rules cannot settle: two album names, no track numbers. */
async function ambiguousFolder() {
  const folder = join(dir, 'Music', 'Lin Xia');
  mkdirSync(folder, { recursive: true });
  const songs: [string, string, string][] = [
    ['a.wav', 'One', 'City Wanderer'],
    ['b.wav', 'Two', '城市漫游者'],
    ['c.wav', 'Three', 'City Wanderer'],
    ['d.wav', 'Four', '城市漫游者'],
  ];
  for (const [file, title, album] of songs) {
    writeFileSync(join(folder, file), makeWav({ title, artist: 'Lin Xia', album }, 2));
  }
  const root = ctx.library.addRoot(join(dir, 'Music'));
  await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
  return root.id;
}

/** Fake musicbrainz.org: records requests, answers from a table. */
function fakeMusicBrainz(release: { id: string; tracks: string[] } | null) {
  const requests: { url: string; ua: string | null }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/release/?query=')) {
      return json({
        releases: release ? [{ id: release.id, title: 'City Wanderer', 'track-count': 4 }] : [],
      });
    }
    return json({
      media: [
        {
          position: 1,
          tracks: (release?.tracks ?? []).map((title, i) => ({
            position: i + 1,
            title,
            length: 2,
          })),
        },
      ],
    });
  }) as typeof fetch;
  const client = new MusicBrainzClient({
    userAgent: 'HQPlayerStudio/test',
    fetch: fetchFn,
    minIntervalMs: 0,
  });
  return { client, requests };
}

const albumsOf = () =>
  ctx.library
    .listAlbums({ limit: 50 })
    .items.map((a) => a.title)
    .sort();

describe('opt-in MusicBrainz album check', () => {
  it('joins an unclear folder when MusicBrainz knows the release, and caches the answer', async () => {
    const rootId = await ambiguousFolder();
    expect(ctx.library.ambiguousFolders(rootId)).toHaveLength(1);
    expect(albumsOf()).toEqual(['City Wanderer', '城市漫游者']);

    const mb = fakeMusicBrainz({ id: 'rel-1', tracks: ['One', 'Two', 'Three', 'Four'] });
    const checker = new OnlineAlbumChecker(ctx, mb.client);
    expect(await checker.run()).toMatchObject({ checked: 1, merged: 1 });
    expect(albumsOf()).toHaveLength(1);
    // only album/artist names go out — never file paths
    expect(mb.requests.map((r) => decodeURIComponent(r.url)).join(' ')).not.toMatch(
      /Music|\.wav|hqps-mb/,
    );
    expect(mb.requests.every((r) => r.ua === 'HQPlayerStudio/test')).toBe(true);

    const again = await checker.run();
    expect(again.checked).toBe(0); // settled folders are not asked about again
  });

  it('changes nothing when MusicBrainz has no matching release (e.g. indie releases)', async () => {
    const rootId = await ambiguousFolder();
    const mb = fakeMusicBrainz(null);
    const checker = new OnlineAlbumChecker(ctx, mb.client);
    expect(await checker.run(rootId)).toMatchObject({ checked: 1, merged: 0, unmatched: 1 });
    expect(albumsOf()).toEqual(['City Wanderer', '城市漫游者']);
    const asked = mb.requests.length;
    await checker.run(rootId); // cached "no match": no new requests for 30 days
    expect(mb.requests.length).toBe(asked);
  });

  it('matches tracks across languages by position and length', () => {
    const ours = [
      { title: '一', track: 1, disc: 1, durationMs: 200_000 },
      { title: '二', track: 2, disc: 1, durationMs: 185_500 },
      { title: '三', track: null, disc: null, durationMs: 241_000 },
    ].map((t, i) => ({ id: String(i), albumId: 'a', album: 'x', albumArtist: 'y', ...t }));
    const theirs = [
      { disc: 1, position: 1, title: 'One', lengthMs: 201_000 },
      { disc: 1, position: 2, title: 'Two', lengthMs: 184_000 },
      { disc: 1, position: 3, title: 'Three', lengthMs: 240_500 },
    ];
    expect(matchShare(ours, theirs)).toBe(1);
    expect(matchShare(ours, theirs.slice(0, 1))).toBeCloseTo(1 / 3);
  });
});
