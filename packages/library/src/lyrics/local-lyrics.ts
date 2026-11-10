import { open, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { decodeLegacy, detectLegacyEncoding, languageHint } from '../scanner/legacy-encoding';

/**
 * Lyrics that live with the music: a lyrics file next to the audio file or lyrics stored in the
 * file's tags. Read-only — files are never changed.
 *
 * Where a lyrics file is looked for, in this order (letter case never matters):
 *  1. `<audio file name>.lrc` in the audio file's folder;
 *  2. the same name without a leading track number (`01 Song.flac` → `Song.lrc`), the track's
 *     title (`Song.lrc`), `Artist - Song.lrc` and `Song - Artist.lrc` — the names lyric
 *     downloaders write;
 *  3. `<audio file name>.txt` (plain lyrics);
 *  4. all of the above in a `Lyrics` / `Lyric` / `LRC` / `歌词` sub-folder.
 */

/** Larger "lyrics" files are not lyrics. */
export const MAX_LYRICS_FILE_BYTES = 1024 * 1024;

/** What the tags say about the track; used to recognise lyric files named after the song. */
export interface SidecarHints {
  title?: string;
  artist?: string;
}

const LYRICS_DIRS = new Set(['lyrics', 'lyric', 'lrc', '歌词', '歌詞']);

/** File-name comparison key: case, Unicode form, characters Windows forbids and spacing. */
const nameKey = (name: string): string =>
  name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** File names (with extension) a track's lyrics may have, best first. */
export function sidecarNameCandidates(audioPath: string, hints: SidecarHints = {}): string[] {
  const base = basename(audioPath, extname(audioPath));
  const unnumbered = base.replace(/^\d{1,3}(?:[-.]\d{1,3})?[\s._-]+/, '');
  const title = hints.title?.trim() ?? '';
  const artist = hints.artist?.trim() ?? '';
  const names = [
    `${base}.lrc`,
    unnumbered && `${unnumbered}.lrc`,
    title && `${title}.lrc`,
    title && artist && `${artist} - ${title}.lrc`,
    title && artist && `${title} - ${artist}.lrc`,
    `${base}.txt`,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n ? nameKey(n) : '';
    if (!key || key.startsWith('.') || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function listDir(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null; // folder offline (NAS / USB) or unreadable
  }
}

/** Path of the track's lyrics file (see the search order above), or null. */
export async function findSidecarLyrics(
  audioPath: string,
  hints: SidecarHints = {},
): Promise<string | null> {
  const dir = dirname(audioPath);
  const names = await listDir(dir);
  if (!names) return null;
  const wanted = sidecarNameCandidates(audioPath, hints);
  const pick = (entries: string[]): string | null => {
    const byKey = new Map<string, string>();
    for (const e of entries) if (!byKey.has(nameKey(e))) byKey.set(nameKey(e), e);
    for (const w of wanted) {
      const hit = byKey.get(w);
      if (hit) return hit;
    }
    return null;
  };
  const here = pick(names);
  if (here) return join(dir, here);
  for (const sub of names.filter((n) => LYRICS_DIRS.has(n.normalize('NFC').toLowerCase()))) {
    const hit = pick((await listDir(join(dir, sub))) ?? []);
    if (hit) return join(dir, sub, hit);
  }
  return null;
}

/** Path of `<same name>.lrc` in the audio file's folder (or another known lyrics file), or null. */
export const findSidecarLrc = findSidecarLyrics;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode a lyrics file: UTF-8 (with or without BOM), UTF-16 LE/BE with BOM (Windows Notepad
 * "Unicode"), else GBK / Shift-JIS as written by older Chinese/Japanese tools (same conservative
 * detection as for tags; the file name is the language hint). Undecidable bytes fall back to
 * UTF-8 with replacement characters.
 */
export function decodeLyricsBytes(bytes: Uint8Array, nameHint = ''): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return utf8Strict.decode(b);
  } catch {
    // not UTF-8: maybe a legacy code page
  }
  const latin1Lines = b.toString('latin1').split(/\r\n|\r|\n/);
  const enc = detectLegacyEncoding(latin1Lines, languageHint(nameHint));
  if (enc) return latin1Lines.map((l) => decodeLegacy(l, enc)).join('\n');
  return b.toString('utf8');
}

async function readSmallFile(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (size > MAX_LYRICS_FILE_BYTES) return null;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    return buf;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Text of the track's lyrics file, or null when there is none (or it cannot be read). */
export async function readSidecarLyrics(
  audioPath: string,
  hints: SidecarHints = {},
): Promise<string | null> {
  const file = await findSidecarLyrics(audioPath, hints);
  if (!file) return null;
  const bytes = await readSmallFile(file);
  if (!bytes) return null;
  const text = decodeLyricsBytes(bytes, basename(audioPath)).replace(/^\uFEFF/, '');
  return text.trim() ? text : null;
}

export interface EmbeddedLyrics {
  /** Time-coded lines (ms), when the tag is synchronised. */
  synced: { timeMs: number; text: string }[];
  /** Unsynchronised text (may itself be LRC-formatted). */
  text: string | null;
}

/**
 * Lyrics from the file's tags (ID3 USLT/SYLT, Vorbis/FLAC `LYRICS`, MP4 ©lyr …) via
 * music-metadata. Pictures are skipped; only the tag area is read.
 */
export async function readEmbeddedLyrics(audioPath: string): Promise<EmbeddedLyrics | null> {
  try {
    const { parseFile } = await import('music-metadata');
    const mm = await parseFile(audioPath, { duration: false, skipCovers: true });
    for (const tag of mm.common.lyrics ?? []) {
      const timed = (tag.syncText ?? []).filter(
        (l) => typeof l.timestamp === 'number' && Number.isFinite(l.timestamp),
      );
      // timeStampFormat 2 = milliseconds (1 = MPEG frames, which we cannot convert reliably)
      if (timed.length > 0 && tag.timeStampFormat === 2) {
        return {
          synced: timed.map((l) => ({
            timeMs: Math.max(0, Math.round(l.timestamp as number)),
            text: (l.text ?? '').trim(),
          })),
          text: null,
        };
      }
      const text =
        tag.text?.trim() ||
        (tag.syncText ?? [])
          .map((l) => l.text ?? '')
          .join('\n')
          .trim();
      if (text) return { synced: [], text };
    }
    return null;
  } catch {
    return null; // unreadable / unsupported file: no embedded lyrics
  }
}
