import { describe, expect, it } from 'vitest';
import { trackFormatLabel } from './format';
import { metadataFromPath, repairMojibake } from './scanner/metadata';
import {
  albumFolderOf,
  albumGroupKey,
  engineUriToPath,
  normalizeText,
  pathKey,
  searchTokens,
  splitArtists,
} from './normalize';

describe('normalizeText', () => {
  it('folds full-width characters, case, katakana and CJK brackets', () => {
    expect(normalizeText('ＡＢＣ　１２３')).toBe('abc 123');
    expect(normalizeText('ネオンの海')).toBe(normalizeText('ねおんの海'));
    expect(normalizeText('「ひかり」をさがして')).toBe('ひかり をさがして');
    expect(normalizeText('第一楽章『秋の詩』')).toBe('第一楽章 秋の詩');
    expect(normalizeText("The Keeper's Daughter")).toBe('the keepers daughter');
    expect(normalizeText('ｶﾀｶﾅ')).toBe('かたかな');
  });

  it('produces de-duplicated search tokens', () => {
    expect(searchTokens('  Blue  blue HOUR ')).toEqual(['blue', 'hour']);
    expect(searchTokens('')).toEqual([]);
  });
});

describe('pathKey', () => {
  it('is case-insensitive with normalised separators on Windows', () => {
    expect(pathKey('D:\\Music\\Album\\01.flac', 'win32')).toBe(
      pathKey('d:/music/ALBUM/01.FLAC', 'win32'),
    );
  });
  it('keeps UNC paths distinct from drive paths', () => {
    expect(pathKey('\\\\NAS\\music\\a.flac', 'win32')).toBe('//nas/music/a.flac');
  });
  it('normalises Unicode (NFD file names from macOS) to NFC', () => {
    const nfd = '/Music/が.flac'.normalize('NFD');
    expect(pathKey(nfd, 'posix')).toBe('/Music/が.flac'.normalize('NFC'));
  });
});

describe('album grouping helpers', () => {
  it('treats CD1/Disc 2 sub-folders as the parent album folder', () => {
    expect(albumFolderOf('Artist - Album/CD1')).toBe('Artist - Album');
    expect(albumFolderOf('Artist - Album/Disc 2')).toBe('Artist - Album');
    expect(albumFolderOf('Artist - Album')).toBe('Artist - Album');
  });
  it('separates same-titled releases in different folders', () => {
    const a = albumGroupKey('Aurora', 'Suite', 'r1', 'Aurora - Suite [FLAC]', null);
    const b = albumGroupKey('Aurora', 'Suite', 'r1', 'Aurora - Suite [DSD]', null);
    expect(a).not.toBe(b);
  });
  it('splits multi-artist credits', () => {
    expect(splitArtists('Lumen Drift feat. 林夏')).toEqual(['Lumen Drift', '林夏']);
    expect(splitArtists('A; B / C')).toEqual(['A', 'B', 'C']);
  });
});

describe('trackFormatLabel', () => {
  it('formats common sources', () => {
    expect(
      trackFormatLabel({
        codec: 'FLAC',
        container: 'FLAC',
        sampleRate: 96000,
        bitDepth: 24,
        isDsd: false,
      }),
    ).toBe('FLAC 24/96');
    expect(
      trackFormatLabel({
        codec: 'PCM',
        container: 'WAVE',
        sampleRate: 44100,
        bitDepth: 16,
        isDsd: false,
      }),
    ).toBe('WAV 16/44.1');
    expect(
      trackFormatLabel({
        codec: 'DSD',
        container: 'DSF',
        sampleRate: 2822400,
        bitDepth: 1,
        isDsd: true,
      }),
    ).toBe('DSD64');
    expect(
      trackFormatLabel({
        codec: 'DSD',
        container: 'DSF',
        sampleRate: 11289600,
        bitDepth: 1,
        isDsd: true,
      }),
    ).toBe('DSD256');
    expect(
      trackFormatLabel({
        codec: 'MPEG 1 Layer 3',
        container: 'MPEG',
        sampleRate: 44100,
        bitDepth: null,
        isDsd: false,
        bitrate: 320000,
      }),
    ).toBe('MP3 320k');
  });
});

describe('metadataFromPath', () => {
  it('parses track numbers, titles and album folders', () => {
    expect(metadataFromPath('林夏 - 城市漫游者 (2020)', '03 午夜地铁.flac')).toMatchObject({
      trackNumber: 3,
      title: '午夜地铁',
      album: '城市漫游者',
      albumArtist: '林夏',
      year: 2020,
    });
  });
  it('handles disc-track prefixes and disc folders', () => {
    expect(metadataFromPath('Pianist/Album/CD2', '2-05 Fugue.dff')).toMatchObject({
      discNumber: 2,
      trackNumber: 5,
      title: 'Fugue',
      album: 'Album',
      albumArtist: 'Pianist',
      codec: 'DFF',
    });
  });
  it('splits "Artist - Title" file names', () => {
    expect(metadataFromPath('', '07 - Nodal - Idle State.wav')).toMatchObject({
      artist: 'Nodal',
      title: 'Idle State',
    });
  });
});

describe('repairMojibake', () => {
  it('recovers UTF-8 text that was decoded as Latin-1', () => {
    const garbled = Buffer.from('南方的风', 'utf8').toString('latin1');
    expect(repairMojibake(garbled)).toBe('南方的风');
  });
  it('leaves genuine Latin-1 and normal Unicode alone', () => {
    expect(repairMojibake('Café Noir')).toBe('Café Noir');
    expect(repairMojibake('夜の終わりに')).toBe('夜の終わりに');
    expect(repairMojibake('plain ascii')).toBe('plain ascii');
  });
});

describe('engineUriToPath', () => {
  it('handles the raw form observed on HQPlayer 6.1.0 ("file:" + Windows path, unencoded)', () => {
    expect(engineUriToPath('file:D:\\音乐\\林夏 - 城市漫游者\\01 城市漫游者.flac')).toBe(
      'D:\\音乐\\林夏 - 城市漫游者\\01 城市漫游者.flac',
    );
    expect(engineUriToPath('file:D:\\Music\\100% Pure.flac')).toBe('D:\\Music\\100% Pure.flac');
    expect(engineUriToPath('file://D:\\Music\\a.flac')).toBe('D:\\Music\\a.flac');
  });
  it('decodes proper RFC 8089 file URIs', () => {
    expect(engineUriToPath('file:///D:/a%20b/%E9%9F%B3.flac')).toBe('D:/a b/音.flac');
    expect(engineUriToPath('file:///Users/me/a%20b.flac')).toBe('/Users/me/a b.flac');
    expect(engineUriToPath('file://nas/music/x.flac')).toBe('\\\\nas\\music\\x.flac');
  });
  it('passes native paths through and rejects garbage', () => {
    expect(engineUriToPath('D:\\x.flac')).toBe('D:\\x.flac');
    expect(engineUriToPath('file:///D:/bad%E9')).toBeNull();
    expect(engineUriToPath('')).toBeNull();
  });
});
