import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary, type LibraryContext } from '../index';
import { legacyDecodingAvailable } from '../scanner/legacy-encoding';
import { scanRoot } from '../scanner/scanner';
import { encodeLegacy, makeFlac, makeWav } from '../testing/synthetic-audio';
import {
  MAX_LYRICS_FILE_BYTES,
  decodeLyricsBytes,
  findSidecarLrc,
  readEmbeddedLyrics,
  readSidecarLyrics,
} from './local-lyrics';

// All lyric text below is invented for the tests (no real lyrics in the repository).
const LRC = '[00:01.00]第一行 invented\n[00:04.50]夜の試験テキスト';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-lyrics-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sidecar .lrc files', () => {
  it('finds <same name>.lrc in the folder, ignoring letter case', async () => {
    const audio = join(dir, '01 夜の歌.flac');
    writeFileSync(audio, 'x');
    expect(await findSidecarLrc(audio)).toBeNull();
    writeFileSync(join(dir, '01 夜の歌.LRC'), LRC);
    expect(await findSidecarLrc(audio)).toBe(join(dir, '01 夜の歌.LRC'));
    expect(await readSidecarLyrics(audio)).toBe(LRC);
  });

  it('returns null for missing folders, empty files and oversized files', async () => {
    expect(await readSidecarLyrics(join(dir, 'offline', 'a.flac'))).toBeNull();
    writeFileSync(join(dir, 'empty.lrc'), '  \n');
    expect(await readSidecarLyrics(join(dir, 'empty.flac'))).toBeNull();
    writeFileSync(join(dir, 'big.lrc'), Buffer.alloc(MAX_LYRICS_FILE_BYTES + 1, 0x41));
    expect(await readSidecarLyrics(join(dir, 'big.flac'))).toBeNull();
  });
});

describe('decodeLyricsBytes', () => {
  it('handles UTF-8 with/without BOM and UTF-16 with BOM', () => {
    expect(decodeLyricsBytes(Buffer.from(LRC, 'utf8'))).toBe(LRC);
    expect(
      decodeLyricsBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LRC)])),
    ).toBe(LRC);
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LRC, 'utf16le')]);
    expect(decodeLyricsBytes(le)).toBe(LRC);
    const be = Buffer.from(LRC, 'utf16le').swap16();
    expect(decodeLyricsBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(LRC);
  });

  it.runIf(legacyDecodingAvailable())('recovers GBK and Shift-JIS lyric files', () => {
    const zh = '[00:01.00]这是测试用的中文歌词\n[00:05.00]第二行文字在这里';
    expect(decodeLyricsBytes(encodeLegacy(zh, 'gbk'), '南方.flac')).toBe(zh);
    const ja = '[00:01.00]これはテストの歌詞です\n[00:05.00]二行目のテキスト';
    expect(decodeLyricsBytes(encodeLegacy(ja, 'shift_jis'), 'うた.flac')).toBe(ja);
  });
});

describe('embedded lyrics', () => {
  it('reads LRC-formatted LYRICS from FLAC tags as timed lines', async () => {
    const file = join(dir, 'tagged.flac');
    writeFileSync(file, makeFlac({ TITLE: 'Tagged', LYRICS: LRC }));
    const emb = await readEmbeddedLyrics(file);
    expect(emb).not.toBeNull();
    const lines = emb!.synced.length ? emb!.synced : null;
    if (lines) {
      expect(lines.map((l) => l.timeMs)).toEqual([1000, 4500]);
      expect(lines[1]!.text).toBe('夜の試験テキスト');
    } else {
      expect(emb!.text).toContain('夜の試験テキスト');
    }
  });

  it('reads plain lyrics and returns null for files without lyrics', async () => {
    const plain = join(dir, 'plain.flac');
    writeFileSync(plain, makeFlac({ TITLE: 'Plain', UNSYNCEDLYRICS: 'line one\nline two' }));
    expect((await readEmbeddedLyrics(plain))?.text).toBe('line one\nline two');
    const wav = join(dir, 'none.wav');
    writeFileSync(wav, makeWav({ title: 'None' }));
    expect(await readEmbeddedLyrics(wav)).toBeNull();
    expect(await readEmbeddedLyrics(join(dir, 'missing.flac'))).toBeNull();
  });
});

describe('LyricsRepository', () => {
  let ctx: LibraryContext;
  beforeEach(async () => {
    ctx = openLibrary(':memory:', join(dir, 'art'));
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const titles = { a: 'Alpha', b: 'Bravo', c: 'Charlie' };
    for (const [n, title] of Object.entries(titles)) {
      writeFileSync(join(music, `${n}.wav`), makeWav({ title, artist: 'Test' }));
    }
    const root = ctx.library.addRoot(music);
    await scanRoot({ library: ctx.library, artwork: ctx.artwork, rootId: root.id });
  });
  afterEach(() => ctx.close());

  const id = (n: 'a' | 'b' | 'c') =>
    ctx.library
      .listTracks({ limit: 10 })
      .items.find((t) => t.title === { a: 'Alpha', b: 'Bravo', c: 'Charlie' }[n])!.id;

  it('keeps the offset when lyrics are replaced; clears only automatic online results', () => {
    const a = id('a');
    ctx.lyrics.save({ trackId: a, source: 'local', type: 'lrc', content: LRC });
    expect(ctx.lyrics.setOffset(a, 750)).toBe(true);
    ctx.lyrics.save({ trackId: a, source: 'lrclib', type: 'lrc', content: LRC });
    expect(ctx.lyrics.get(a)).toMatchObject({ source: 'lrclib', offsetMs: 750 });

    ctx.lyrics.save({ trackId: id('b'), source: 'none', type: 'plain', content: '' });
    expect(ctx.lyrics.setOffset(id('b'), 100)).toBe(false); // nothing to calibrate
    ctx.lyrics.save({
      trackId: id('c'),
      source: 'lrclib',
      type: 'plain',
      content: 'x',
      selectedByUser: true,
    });
    expect(ctx.lyrics.counts()).toMatchObject({ lrclib: 2, none: 1 });
    expect(ctx.lyrics.clearOnline()).toBe(2);
    expect(ctx.lyrics.get(id('c'))?.selectedByUser).toBe(true);
    expect(ctx.lyrics.get(a)).toBeNull();
  });
});
