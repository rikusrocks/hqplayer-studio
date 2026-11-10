import { open, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { decodeLegacy, detectLegacyEncoding, languageHint } from '../scanner/legacy-encoding';

/**
 * Lyrics that live with the music: a `.lrc` file next to the audio file (same base name,
 * any letter case) or lyrics stored in the file's tags. Read-only — files are never changed.
 */

/** Larger "lyrics" files are not lyrics. */
export const MAX_LYRICS_FILE_BYTES = 1024 * 1024;

/** Path of `<same name>.lrc` in the audio file's folder, or null. */
export async function findSidecarLrc(audioPath: string): Promise<string | null> {
  const dir = dirname(audioPath);
  const want = `${basename(audioPath, extname(audioPath))}.lrc`.normalize('NFC').toLowerCase();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // folder offline (NAS / USB) or unreadable
  }
  const hit = names.find((n) => n.normalize('NFC').toLowerCase() === want);
  return hit ? join(dir, hit) : null;
}

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

/** Text of the sidecar `.lrc` file, or null when there is none (or it cannot be read). */
export async function readSidecarLyrics(audioPath: string): Promise<string | null> {
  const file = await findSidecarLrc(audioPath);
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
