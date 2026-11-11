import { describe, expect, it } from 'vitest';
import { parseLrc } from './lrc';
import { LrclibClient } from './lrclib';
import {
  KugouProvider,
  LrclibProvider,
  LyricsOvhProvider,
  NeteaseProvider,
  type OnlineLyrics,
  type OnlineLyricsProvider,
  type OnlineLyricsProviderId,
} from './providers';

/**
 * Checks against the REAL lyric services: what a search lists, and whether choosing a listed
 * result really delivers lyrics. The ordinary tests use stand-ins, which can only be as right as
 * our idea of the service — this is how to find out when that idea is wrong.
 *
 * Off by default (third parties, needs the network). Run by hand:
 *
 *   HQPS_LIVE_TESTS=all pnpm vitest run packages/lyrics/src/live.test.ts
 *   HQPS_LIVE_TESTS=netease,kugou pnpm vitest run packages/lyrics/src/live.test.ts
 *
 * `HQPS_LIVE_NETEASE_URL` replaces NetEase's address (e.g. `http://music.163.com` on a network
 * that resets its HTTPS). A run sends a few dozen requests per source, one per second. Lyric
 * text is never printed — only names and line counts.
 */
const wanted = (process.env.HQPS_LIVE_TESTS ?? '')
  .toLowerCase()
  .split(/[\s,]+/)
  .filter(Boolean);
const on = (id: OnlineLyricsProviderId) =>
  wanted.includes('all') || wanted.includes('1') || wanted.includes(id);

const UA = 'HQPlayerStudio/dev (unofficial HQPlayer Desktop client)';

// Well-known recordings; the durations are those of the usual album versions.
const TRACKS = [
  { trackName: 'Yesterday', artistName: 'The Beatles', albumName: 'Help!', durationSec: 125 },
  {
    trackName: 'Hotel California',
    artistName: 'Eagles',
    albumName: 'Hotel California',
    durationSec: 391,
  },
  { trackName: '可惜不是你', artistName: '梁静茹', albumName: '丝路', durationSec: 286 },
];

/** How many lyric lines an answer holds (0 for "nothing" and for instrumentals). */
function lineCount(l: OnlineLyrics | null): number {
  if (!l) return 0;
  if (l.synced) return parseLrc(l.synced).lines.filter((x) => x.text.trim()).length;
  return (l.plain ?? '').split(/\r\n|\r|\n/).filter((x) => x.trim()).length;
}

function liveSuite(make: () => OnlineLyricsProvider, opts: { minFound: number }) {
  const provider = make();
  const report: string[] = [];

  it('lists results, and choosing a listed result delivers its lyrics', async () => {
    let tracksWithLyrics = 0;
    for (const t of TRACKS) {
      const listed = await provider.search({ trackName: t.trackName, artistName: t.artistName });
      const counts: number[] = [];
      for (const c of listed.slice(0, 4))
        counts.push(lineCount(c.lyrics ?? (await provider.fetch(c.ref))));
      report.push(
        `${provider.id} "${t.trackName}": ${listed.length} listed; first ${counts.length} chosen → lines ${counts.join(', ') || '—'}`,
      );
      // A real song text, not a stub: at least one of the first results has several lines.
      if (counts.some((n) => n >= 5)) tracksWithLyrics += 1;
    }
    console.info(report.join('\n'));
    expect(tracksWithLyrics, report.join('\n')).toBeGreaterThanOrEqual(opts.minFound);
  }, 180_000);

  it('matches well-known tracks by itself', async () => {
    const lines: string[] = [];
    let found = 0;
    for (const t of TRACKS) {
      const n = lineCount(await provider.find(t));
      lines.push(`${provider.id} find "${t.trackName}" → ${n} lines`);
      if (n >= 5) found += 1;
    }
    console.info(lines.join('\n'));
    expect(found, lines.join('\n')).toBeGreaterThanOrEqual(opts.minFound);
  }, 180_000);
}

describe.runIf(on('netease'))('live: NetEase Cloud Music', () => {
  liveSuite(
    () => new NeteaseProvider({ userAgent: UA, baseUrl: process.env.HQPS_LIVE_NETEASE_URL }),
    { minFound: 2 },
  );
});

describe.runIf(on('kugou'))('live: Kugou', () => {
  liveSuite(() => new KugouProvider({ userAgent: UA }), { minFound: 2 });
});

describe.runIf(on('lyricsovh'))('live: lyrics.ovh', () => {
  liveSuite(() => new LyricsOvhProvider({ userAgent: UA }), { minFound: 1 });
});

describe.runIf(on('lrclib'))('live: LRCLIB', () => {
  liveSuite(() => new LrclibProvider(new LrclibClient({ userAgent: UA })), { minFound: 2 });
});

describe.runIf(wanted.length === 0)('live lyric checks', () => {
  it.skip('are off — set HQPS_LIVE_TESTS=all (or a list of sources) to run them', () => undefined);
});
