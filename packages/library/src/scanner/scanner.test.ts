import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import { scanRoot } from './scanner';

/** Build a tiny, valid PCM WAV file with RIFF INFO tags (license-safe synthetic test data). */
function makeWav(
  tags: { title?: string; artist?: string; album?: string; track?: string },
  ms = 120,
): Buffer {
  const sampleRate = 44100;
  const channels = 2;
  const bits = 16;
  const dataBytes = Math.floor((sampleRate * ms) / 1000) * channels * (bits / 8);
  const infoChunks: Buffer[] = [];
  const sub = (id: string, value?: string) => {
    if (!value) return;
    let body = Buffer.from(`${value}\0`, 'utf8');
    if (body.length % 2) body = Buffer.concat([body, Buffer.alloc(1)]);
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(Buffer.byteLength(`${value}\0`, 'utf8'), 4);
    infoChunks.push(h, body);
  };
  sub('INAM', tags.title);
  sub('IART', tags.artist);
  sub('IPRD', tags.album);
  sub('ITRK', tags.track);
  const info = Buffer.concat([Buffer.from('INFO', 'ascii'), ...infoChunks]);
  const list = Buffer.alloc(8);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(info.length, 4);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE((sampleRate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataBytes, 4);
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    fmt,
    list,
    info,
    dataHeader,
    Buffer.alloc(dataBytes),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let dir: string;
let musicDir: string;
let ctx: LibraryContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-scan-'));
  musicDir = join(dir, 'Music 音乐');
  const a = join(musicDir, '林夏 - 城市漫游者 (2020)');
  mkdirSync(a, { recursive: true });
  writeFileSync(
    join(a, '01 城市漫游者.wav'),
    makeWav({ title: '城市漫游者', artist: '林夏', album: '城市漫游者', track: '1' }),
  );
  writeFileSync(
    join(a, '02 南方的风.wav'),
    makeWav({ title: '南方的风', artist: '林夏', album: '城市漫游者', track: '2' }),
  );
  writeFileSync(join(a, 'folder.png'), PNG);
  const b1 = join(musicDir, '月見カルテット', '紅葉「Kōyō」', 'CD1');
  const b2 = join(musicDir, '月見カルテット', '紅葉「Kōyō」', 'CD2');
  mkdirSync(b1, { recursive: true });
  mkdirSync(b2, { recursive: true });
  writeFileSync(join(b1, '01 秋の詩.wav'), makeWav({}));
  writeFileSync(join(b2, '01 初雪.wav'), makeWav({}));
  writeFileSync(join(musicDir, 'broken track.flac'), Buffer.from('this is not a flac file'));
  writeFileSync(join(musicDir, 'notes.txt'), 'ignored');
  mkdirSync(join(musicDir, '.hidden'));
  writeFileSync(join(musicDir, '.hidden', 'x.wav'), makeWav({}));
  ctx = openLibrary(join(dir, 'data'));
});

afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scanRoot', () => {
  it('indexes tags, falls back to paths, isolates broken files and finds folder art', async () => {
    const root = ctx.library.addRoot(musicDir);
    const res = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(res.state).toBe('completed');
    expect(res.filesSeen).toBe(5);
    expect(res.added).toBe(5);
    expect(res.errors).toBe(1);

    const tracks = ctx.library.listTracks({ limit: 50 }).items;
    const wind = tracks.find((t) => t.title === '南方的风')!;
    expect(wind.artist).toBe('林夏');
    expect(wind.album).toBe('城市漫游者');
    expect(wind.format.label).toBe('WAV 16/44.1');
    expect(wind.durationMs).toBeGreaterThan(100);
    expect(wind.artworkId).toMatch(/^art_/);

    const autumn = tracks.find((t) => t.title === '秋の詩')!;
    expect(autumn.album).toBe('紅葉「Kōyō」');
    expect(autumn.albumArtist).toBe('月見カルテット');
    expect(autumn.discNumber).toBe(1);
    const koyo = ctx.library.getAlbum(autumn.albumId!);
    expect(koyo.tracks).toHaveLength(2);
    expect(koyo.discCount).toBe(2);

    const broken = tracks.find((t) => t.fileName === 'broken track.flac')!;
    expect(broken.title).toBe('broken track');
    expect(broken.available).toBe(true);
  });

  it('rescans incrementally and marks missing files unavailable without deleting them', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const again = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(again.filesUnchanged).toBe(5);
    expect(again.filesParsed).toBe(0);

    const target = join(musicDir, '林夏 - 城市漫游者 (2020)', '02 南方的风.wav');
    const id = ctx.library.listTracks({ q: '南方的风' }).items[0]!.id;
    const pl = ctx.playlists.create({ name: 'keep', trackIds: [id] });
    unlinkSync(target);
    const third = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(third.markedUnavailable).toBe(1);
    expect(ctx.library.getTrack(id).available).toBe(false);
    expect(ctx.playlists.get(pl.id).items).toHaveLength(1); // playlist untouched
  });

  it('treats an offline root as unavailable, then recovers when it returns', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const parked = `${musicDir}-offline`;
    renameSync(musicDir, parked);
    const offline = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(offline.state).toBe('failed');
    expect(offline.message).toBe('root_offline');
    expect(ctx.library.stats().unavailableTrackCount).toBe(5);
    expect(ctx.library.stats().trackCount).toBe(5);
    expect(ctx.library.listRoots()[0]!.status).toBe('offline');

    renameSync(parked, musicDir);
    const back = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(back.state).toBe('completed');
    expect(ctx.library.stats().unavailableTrackCount).toBe(0);
  });

  it('does not mark anything unavailable when cancelled', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const ac = new AbortController();
    ac.abort();
    const res = await scanRoot({
      library: ctx.library,
      artwork: ctx.artwork,
      rootId: root.id,
      signal: ac.signal,
    });
    expect(res.state).toBe('cancelled');
    expect(ctx.library.stats().unavailableTrackCount).toBe(0);
  });

  it('rejects relative or duplicate roots', () => {
    expect(() => ctx.library.addRoot('relative/music')).toThrow(/absolute/);
    ctx.library.addRoot(musicDir);
    expect(() => ctx.library.addRoot(musicDir)).toThrow(/already/);
  });
});
