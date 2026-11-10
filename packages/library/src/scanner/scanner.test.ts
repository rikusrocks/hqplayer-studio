import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import { encodeLegacy, makeWav, writeSyntheticTree } from '../testing/synthetic-audio';
import { normalizeSubtrees, scanRoot } from './scanner';

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

  it("keeps a moved file's identity, so playlists keep pointing at it", async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const id = ctx.library.listTracks({ q: '南方的风' }).items[0]!.id;
    const pl = ctx.playlists.create({ name: 'keep', trackIds: [id] });
    renameSync(
      join(musicDir, '林夏 - 城市漫游者 (2020)'),
      join(musicDir, '林夏 - 城市漫游者 [FLAC]'),
    );

    const res = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(res).toMatchObject({ moved: 2, added: 0, markedUnavailable: 0 });
    const track = ctx.library.getTrack(id);
    expect(track.available).toBe(true);
    expect(track.folder).toBe('林夏 - 城市漫游者 [FLAC]');
    expect(ctx.playlists.get(pl.id).items[0]!.track).toMatchObject({ id, available: true });
    expect(ctx.library.stats().trackCount).toBe(5);
  });

  it('treats a copy (old file still present) as a new track, not a move', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const src = join(musicDir, '林夏 - 城市漫游者 (2020)', '01 城市漫游者.wav');
    mkdirSync(join(musicDir, 'Copies'));
    copyFileSync(src, join(musicDir, 'Copies', '01 城市漫游者.wav'));
    const res = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(res).toMatchObject({ moved: 0, added: 1 });
    expect(ctx.library.stats().trackCount).toBe(6);
  });

  it('handles 1,200 files with incremental add / edit / delete / move', async () => {
    const big = join(dir, 'Big Library');
    const files = writeSyntheticTree(big, { artists: 12, albumsPerArtist: 10, tracksPerAlbum: 10 });
    const root = ctx.library.addRoot(big);
    const first = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(first).toMatchObject({ state: 'completed', added: 1200, errors: 0 });
    const albums = ctx.library.stats().albumCount;
    expect(albums).toBe(120);

    writeFileSync(files[0]!, makeWav({ title: 'edited', artist: 'Edited', album: 'Edited' }, 3));
    unlinkSync(files[1]!);
    writeFileSync(join(big, 'new single.wav'), makeWav({ title: 'new single' }, 2));
    const lastArtist = join(files.at(-1)!, '..', '..');
    renameSync(lastArtist, `${lastArtist} (moved)`);
    const inc = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    expect(inc).toMatchObject({
      state: 'completed',
      filesSeen: 1200,
      added: 1,
      updated: 1,
      moved: 100,
      markedUnavailable: 1,
      errors: 0,
    });
    expect(ctx.library.stats()).toMatchObject({ trackCount: 1201, unavailableTrackCount: 1 });
  }, 60_000); // Windows runners are ~10× slower creating small files

  it('rescans only the given folders and leaves the rest of the root alone', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const scannedAt = ctx.library.listRoots()[0]!.lastScannedAt;
    unlinkSync(join(musicDir, '林夏 - 城市漫游者 (2020)', '02 南方的风.wav'));
    unlinkSync(join(musicDir, 'broken track.flac')); // outside the subtree: not noticed yet
    writeFileSync(
      join(musicDir, '林夏 - 城市漫游者 (2020)', '03 午夜地铁.wav'),
      makeWav({ title: '午夜地铁', artist: '林夏', album: '城市漫游者', track: '3' }),
    );
    const res = await scanRoot({
      library: ctx.library,
      artwork: ctx.artwork,
      rootId: root.id,
      subtrees: ['林夏 - 城市漫游者 (2020)'],
    });
    expect(res).toMatchObject({ filesSeen: 2, added: 1, markedUnavailable: 1 });
    expect(ctx.library.stats().unavailableTrackCount).toBe(1);
    expect(ctx.library.listRoots()[0]!.lastScannedAt).toBe(scannedAt); // not a full scan
  });

  it('normalizes subtree lists', () => {
    expect(normalizeSubtrees(undefined)).toBeNull();
    expect(normalizeSubtrees(['a\\b', 'a', 'c/', './d'])).toEqual(['a', 'c', 'd']);
    expect(normalizeSubtrees(['a', ''])).toBeNull(); // root itself → whole root
    expect(normalizeSubtrees(['../escape'])).toBeNull();
  });

  it('recovers GBK and Shift-JIS tags written by old Windows taggers', async () => {
    const zh = join(musicDir, '老歌');
    const ja = join(musicDir, '古い曲');
    mkdirSync(zh);
    mkdirSync(ja);
    writeFileSync(
      join(zh, '01.wav'),
      makeWav({
        title: encodeLegacy('南方的风', 'gbk'),
        artist: encodeLegacy('林夏', 'gbk'),
        album: encodeLegacy('城市漫游者', 'gbk'),
      }),
    );
    writeFileSync(
      join(ja, '01.wav'),
      makeWav({
        title: encodeLegacy('初雪のワルツ', 'shift_jis'),
        artist: encodeLegacy('月見カルテット', 'shift_jis'),
        album: encodeLegacy('冬の歌', 'shift_jis'),
      }),
    );
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const byFolder = (folder: string) =>
      ctx.library.listTracks({ limit: 50 }).items.find((t) => t.folder === folder)!;
    expect(byFolder('老歌')).toMatchObject({
      title: '南方的风',
      artist: '林夏',
      album: '城市漫游者',
    });
    expect(byFolder('古い曲')).toMatchObject({
      title: '初雪のワルツ',
      artist: '月見カルテット',
      album: '冬の歌',
    });
  });

  it('groups a folder whose tracks carry album titles in two languages into one album', async () => {
    const dir2 = join(musicDir, 'Lin Xia - City');
    mkdirSync(dir2);
    const tags = (title: string, album: string, track: string) =>
      makeWav({ title, artist: '林夏', album, track });
    writeFileSync(join(dir2, '01.wav'), tags('一', '城市漫游者', '1'));
    writeFileSync(join(dir2, '02.wav'), tags('二', '城市漫游者', '2'));
    writeFileSync(join(dir2, '03.wav'), tags('Three', 'City Wanderer', '3'));
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const inFolder = ctx.library
      .listTracks({ limit: 50 })
      .items.filter((x) => x.folder === 'Lin Xia - City');
    expect(new Set(inFolder.map((x) => x.albumId)).size).toBe(1);
    const album = ctx.library.getAlbum(inFolder[0]!.albumId!);
    expect(album.title).toBe('城市漫游者');
    expect(album.tracks.map((x) => x.title)).toEqual(['一', '二', 'Three']);
  });

  it('automatic rescans still find artwork for albums that are new', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const fresh = join(musicDir, 'New Artist - New Album');
    mkdirSync(fresh);
    writeFileSync(
      join(fresh, '01.wav'),
      makeWav({ title: 'n', artist: 'New Artist', album: 'New Album', track: '1' }),
    );
    writeFileSync(join(fresh, 'cover.png'), PNG);
    await scanRoot({
      library: ctx.library,
      artwork: ctx.artwork,
      rootId: root.id,
      subtrees: ['New Artist - New Album'],
      artworkScope: 'changed',
    });
    const t = ctx.library.listTracks({ q: 'New Album' }).items[0]!;
    expect(t.artworkId).toMatch(/^art_/);
  });

  it('removes a folder with its tracks, playlist entries and empty albums (files untouched)', async () => {
    const root = ctx.library.addRoot(musicDir);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const id = ctx.library.listTracks({ q: '南方的风' }).items[0]!.id;
    const pl = ctx.playlists.create({ name: 'mine', trackIds: [id] });
    const removed = ctx.library.removeRoot(root.id);
    expect(removed).toMatchObject({ tracks: 5, playlistItems: 1, playlistsRemoved: 0 });
    expect(ctx.library.stats()).toMatchObject({ trackCount: 0, albumCount: 0, rootCount: 0 });
    expect(ctx.playlists.get(pl.id).items).toEqual([]); // the user's playlist stays, emptied
    expect(ctx.library.listArtists({ limit: 10 }).total).toBe(0);
    // files are still on disk: adding the folder again finds them
    const again = ctx.library.addRoot(musicDir);
    const res = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: again.id });
    expect(res.added).toBe(5);
  });

  it('refuses a folder inside a library folder, and absorbs folders inside a new parent', async () => {
    const inner = join(musicDir, '林夏 - 城市漫游者 (2020)');
    const child = ctx.library.addRoot(inner);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: child.id });
    const id = ctx.library.listTracks({ q: '南方的风' }).items[0]!.id;
    const pl = ctx.playlists.create({ name: 'keep', trackIds: [id] });

    const parent = ctx.library.addRoot(musicDir); // contains the child: absorbs it
    expect(ctx.library.listRoots().map((r) => r.id)).toEqual([parent.id]);
    expect(() => ctx.library.addRoot(inner)).toThrow(/already part of/);

    const res = await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: parent.id });
    expect(res).toMatchObject({ added: 3, updated: 2 }); // the 2 absorbed files are re-read
    const track = ctx.library.getTrack(id);
    expect(track.folder).toBe('林夏 - 城市漫游者 (2020)');
    expect(ctx.playlists.get(pl.id).items[0]!.track.id).toBe(id);
    expect(ctx.library.stats().trackCount).toBe(5);
  });

  it('rejects relative or duplicate roots', () => {
    expect(() => ctx.library.addRoot('relative/music')).toThrow(/absolute/);
    ctx.library.addRoot(musicDir);
    expect(() => ctx.library.addRoot(musicDir)).toThrow(/already/);
  });
});
