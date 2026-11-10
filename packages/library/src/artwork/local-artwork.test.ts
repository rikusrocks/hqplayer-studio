import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import { scanRoot } from '../scanner/scanner';
import { makeWav } from '../testing/synthetic-audio';
import { findFolderCover, findLocalArtwork, pickCoverFile } from './local-artwork';

// 1×1 PNG and a JPEG signature: enough for a cache that never decodes images.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

let dir: string;
let ctx: LibraryContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-art-'));
  ctx = openLibrary(join(dir, 'data'));
});
afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pickCoverFile', () => {
  it('prefers well-known names, any letter case, over other images', () => {
    expect(pickCoverFile(['01.flac', 'Back.jpg', 'FOLDER.JPG', 'Cover.png'])).toBe('Cover.png');
    expect(pickCoverFile(['back.jpg', 'Folder.jpeg', 'x.png'])).toBe('Folder.jpeg');
    expect(pickCoverFile(['AlbumArt.webp', 'booklet-01.jpg'])).toBe('AlbumArt.webp');
  });

  it('falls back to names that mention the cover, then to the only image', () => {
    expect(pickCoverFile(['Album - Back.jpg', 'Album - Front.jpg', 'Album - CD.jpg'])).toBe(
      'Album - Front.jpg',
    );
    expect(pickCoverFile(['00-invented-cover.png', 'photo.jpg'])).toBe('00-invented-cover.png');
    expect(pickCoverFile(['01.flac', 'scan0001.jpg'])).toBe('scan0001.jpg');
    expect(pickCoverFile(['scan0001.jpg', 'scan0002.jpg'])).toBeNull(); // which one? unknown
    expect(pickCoverFile(['scan0001.jpg'], false)).toBeNull();
    expect(pickCoverFile(['back cover.jpg', 'notes.txt', 'cover.bmp'])).toBeNull();
  });
});

describe('findFolderCover', () => {
  it('looks into artwork sub-folders when the album folder has no cover', async () => {
    const album = join(dir, 'Album');
    mkdirSync(join(album, 'Scans'), { recursive: true });
    writeFileSync(join(album, 'Scans', 'booklet-01.jpg'), JPEG);
    writeFileSync(join(album, 'Scans', 'Front.JPG'), JPEG);
    expect(await findFolderCover(album)).toEqual({
      file: join(album, 'Scans', 'Front.JPG'),
      mime: 'image/jpeg',
    });
    expect(await findFolderCover(join(dir, 'missing'))).toBeNull();
  });
});

describe('findLocalArtwork', () => {
  const readPicture = async () => null;

  it('uses the parent folder for disc folders and the embedded picture last', async () => {
    const disc = join(dir, 'Album', 'CD1');
    mkdirSync(disc, { recursive: true });
    const track = join(disc, '01.wav');
    writeFileSync(track, makeWav({}));
    const base = { folderPath: disc, sourcePath: track, artwork: ctx.artwork };
    expect(await findLocalArtwork({ ...base, readPicture })).toBeNull();
    const embedded = await findLocalArtwork({
      ...base,
      readPicture: async () => ({ data: JPEG, mime: 'image/jpeg' }),
    });
    expect(embedded).toMatch(/^art_/);
    writeFileSync(join(dir, 'Album', 'folder.png'), PNG);
    const folder = await findLocalArtwork({ ...base, readPicture });
    expect(folder).toMatch(/^art_/);
    expect(folder).not.toBe(embedded);
    expect(ctx.artwork.resolve(folder!)?.mime).toBe('image/png');
  });

  it('gives a scanned album the cover found by the wider rules', async () => {
    const album = join(dir, 'Music', 'Lin Xia', 'City Wanderer');
    mkdirSync(join(album, 'Artwork'), { recursive: true });
    writeFileSync(join(album, '01 One.wav'), makeWav({ title: 'One', album: 'City Wanderer' }));
    writeFileSync(join(album, 'Artwork', 'City Wanderer - Front.png'), PNG);
    const root = ctx.library.addRoot(join(dir, 'Music'));
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
    const [track] = ctx.library.listTracks({ limit: 5 }).items;
    expect(track?.artworkId).toMatch(/^art_/);
    const target = ctx.library.getAlbumCoverTarget(track!.albumId!);
    expect(target).toMatchObject({
      title: 'City Wanderer',
      artworkSource: 'folder',
      trackCount: 1,
      isFixture: false,
    });
    expect(ctx.library.albumIdsWithoutArtwork()).toEqual([]);
    expect(ctx.library.albumIdOfTrack(track!.id)).toBe(track!.albumId);
  });
});
