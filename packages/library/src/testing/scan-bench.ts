/**
 * Library scan benchmark on a synthetic tree (no real music involved).
 *
 *   pnpm bench:scan                      # 20,000 files (100 artists × 10 albums × 20 tracks)
 *   pnpm bench:scan -- --artists 300     # bigger
 *
 * Reports: first scan, unchanged rescan, and an incremental rescan after editing / deleting /
 * adding files and moving one artist folder.
 */
import { mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openLibrary } from '../index';
import { emptyMetadata } from '../scanner/metadata';
import { scanRoot, type ScanResult } from '../scanner/scanner';
import { makeWav, writeSyntheticTree } from './synthetic-audio';

const { values } = parseArgs({
  options: {
    artists: { type: 'string', default: '100' },
    albums: { type: 'string', default: '10' },
    tracks: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '2' },
    keep: { type: 'boolean', default: false },
    /** Skip tag parsing to isolate filesystem + database cost. */
    'stub-metadata': { type: 'boolean', default: false },
  },
});

const dir = mkdtempSync(join(tmpdir(), 'hqps-bench-'));
const music = join(dir, 'Music');
const t0 = performance.now();
const files = writeSyntheticTree(music, {
  artists: Number(values.artists),
  albumsPerArtist: Number(values.albums),
  tracksPerAlbum: Number(values.tracks),
});
console.log(`generated ${files.length} files in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const ctx = openLibrary(join(dir, 'data'));
const root = ctx.library.addRoot(music);
const concurrency = Number(values.concurrency);

async function timed(label: string): Promise<ScanResult> {
  const start = performance.now();
  const rss0 = process.memoryUsage().rss;
  const res = await scanRoot({
    library: ctx.library,
    artwork: ctx.artwork,
    rootId: root.id,
    concurrency,
    ...(values['stub-metadata'] ? { readMetadata: async () => emptyMetadata() } : {}),
  });
  const s = (performance.now() - start) / 1000;
  const rate = Math.round(res.filesSeen / s);
  console.log(
    `${label.padEnd(22)} ${s.toFixed(2).padStart(7)} s  ${String(rate).padStart(6)} files/s  ` +
      `seen ${res.filesSeen} parsed ${res.filesParsed} unchanged ${res.filesUnchanged} ` +
      `added ${res.added} updated ${res.updated} moved ${res.moved} unavailable ${res.markedUnavailable} errors ${res.errors}  ` +
      `rss +${Math.round((process.memoryUsage().rss - rss0) / 1048576)} MB`,
  );
  return res;
}

try {
  await timed('first scan');
  await timed('unchanged rescan');

  // 1 % edited (new tags → new size), 1 % deleted, 1 % added, one artist folder moved
  const step = 100;
  let edited = 0;
  let deleted = 0;
  for (let i = 0; i < files.length; i += step) {
    const f = files[i] as string;
    writeFileSync(f, makeWav({ title: `edited ${i}`, artist: 'Edited', album: 'Edited' }, 3));
    edited += 1;
    const g = files[i + 1];
    if (g) {
      unlinkSync(g);
      deleted += 1;
    }
    const h = join(dirname(f), `99 added ${i}.wav`);
    writeFileSync(h, makeWav({ title: `added ${i}` }, 2));
  }
  const artistDir = dirname(dirname(files[files.length - 1] as string));
  renameSync(artistDir, `${artistDir} (moved)`);
  console.log(
    `changes: ${edited} edited, ${deleted} deleted, ${edited} added, 1 artist folder moved`,
  );
  await timed('incremental rescan');

  const db = statSync(join(dir, 'data', 'studio.sqlite')).size;
  const stats = ctx.library.stats();
  console.log(
    `library: ${stats.trackCount} tracks (${stats.unavailableTrackCount} unavailable), ` +
      `${stats.albumCount} albums; db ${(db / 1048576).toFixed(1)} MB`,
  );
} finally {
  ctx.close();
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
