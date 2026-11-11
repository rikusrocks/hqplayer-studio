import { describe, expect, it } from 'vitest';
import {
  DeezerCoverSource,
  downloadImage,
  ItunesCoverSource,
  MusicBrainzCoverSource,
  rankCovers,
  type CoverSource,
} from './cover-sources';
import { MusicBrainzClient } from './online-albums';

/**
 * Checks against the REAL cover sources: a search for a well-known album lists it, and the
 * listed cover really downloads as a picture. Off by default (third parties, needs the network):
 *
 *   HQPS_LIVE_TESTS=all pnpm vitest run packages/core/src/services/covers.live.test.ts
 *   HQPS_LIVE_TESTS=itunes,deezer pnpm vitest run packages/core/src/services/covers.live.test.ts
 *
 * A run sends a handful of requests per source. Images are only measured, never stored.
 */
const wanted = (process.env.HQPS_LIVE_TESTS ?? '')
  .toLowerCase()
  .split(/[\s,]+/)
  .filter(Boolean);
const on = (id: string) => wanted.includes('all') || wanted.includes('1') || wanted.includes(id);

const UA = 'HQPlayerStudio/dev (unofficial HQPlayer Desktop client)';

const ALBUMS = [
  { album: 'Abbey Road', artist: 'The Beatles', trackCount: 17 },
  { album: 'Kind of Blue', artist: 'Miles Davis', trackCount: 5 },
  { album: '叶惠美', artist: '周杰伦', trackCount: 11 },
];

function liveSuite(make: () => CoverSource, opts: { minFound: number }) {
  const source = make();

  it('lists well-known albums and their covers download as pictures', async () => {
    const report: string[] = [];
    let found = 0;
    for (const a of ALBUMS) {
      const listed = await source.search({ album: a.album, artist: a.artist });
      const best = rankCovers(listed, a)[0];
      let picture = 'no match';
      if (best) {
        picture = 'no image';
        for (const size of ['thumb', 'full'] as const) {
          for (const url of source.imageUrls(best.ref, size) ?? []) {
            const img = await downloadImage(url, {
              fetch: globalThis.fetch,
              userAgent: UA,
              allowsHost: (h) => source.allowsImageHost(h),
            });
            if (!img) continue;
            picture = `${size} ${img.mime} ${Math.round(img.bytes.byteLength / 1024)} kB`;
            if (size === 'full') found += 1;
            break;
          }
        }
      }
      report.push(`${source.id} "${a.album}": ${listed.length} listed → ${picture}`);
    }
    console.info(report.join('\n'));
    expect(found, report.join('\n')).toBeGreaterThanOrEqual(opts.minFound);
  }, 180_000);
}

describe.runIf(on('itunes'))('live: iTunes Search covers', () => {
  liveSuite(() => new ItunesCoverSource({ userAgent: UA }), { minFound: 2 });
});

describe.runIf(on('deezer'))('live: Deezer covers', () => {
  liveSuite(() => new DeezerCoverSource({ userAgent: UA }), { minFound: 2 });
});

describe.runIf(on('musicbrainz'))('live: MusicBrainz + Cover Art Archive', () => {
  liveSuite(() => new MusicBrainzCoverSource(new MusicBrainzClient({ userAgent: UA })), {
    minFound: 1,
  });
});

describe.runIf(wanted.length === 0)('live cover checks', () => {
  it.skip('are off — set HQPS_LIVE_TESTS=all (or a list of sources) to run them', () => undefined);
});
