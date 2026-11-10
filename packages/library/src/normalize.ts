import { createHash, randomUUID } from 'node:crypto';

/**
 * Normalise text for search and identity keys:
 * - NFKC folds full-width ASCII/digits and half-width katakana (ＡＢＣ → abc, ｶﾀｶﾅ → カタカナ)
 * - lower-case
 * - katakana → hiragana so 「ヨル」 matches 「よる」
 * - brackets/punctuation (incl. CJK 「」『』【】〈〉《》・、。) become spaces
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.normalize('NFKC').toLowerCase();
  s = s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  s = s.replace(/['’‘`]/g, '');
  s = s.replace(/[\p{P}\p{S}]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function searchTokens(query: string | null | undefined): string[] {
  const n = normalizeText(query);
  if (!n) return [];
  return [...new Set(n.split(' '))].slice(0, 8);
}

export function buildSearchText(...parts: (string | number | null | undefined)[]): string {
  return normalizeText(parts.filter((p) => p !== null && p !== undefined && p !== '').join(' '));
}

export type PathPlatform = 'win32' | 'posix' | 'darwin';

export function hostPlatform(): PathPlatform {
  return process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'posix';
}

/**
 * Identity key for a file path. Windows (and default macOS volumes) are case-insensitive, and
 * macOS may hand back NFD file names, so keys are NFC (+ lower-case where appropriate) with
 * forward slashes. The original path is always kept separately for opening the file.
 */
export function pathKey(p: string, platform: PathPlatform = hostPlatform()): string {
  let s = p.normalize('NFC');
  if (platform === 'win32') {
    const unc = s.startsWith('\\\\') || s.startsWith('//');
    s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (unc) s = `/${s}`;
  }
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return platform === 'posix' ? s : s.toLowerCase();
}

/** Deterministic id from a key, e.g. tracks keep their id across a full DB rebuild. */
export function stableId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

const DISC_FOLDER = /^(cd|disc|disk|dvd|sacd)\s*[-_.]?\s*\d+\b/i;

/** For multi-disc albums stored as "Album/CD1", "Album/Disc 2" … the album folder is the parent. */
export function albumFolderOf(relativeDir: string): string {
  const parts = relativeDir.split('/').filter(Boolean);
  const last = parts.at(-1);
  if (last && DISC_FOLDER.test(last) && parts.length > 1) parts.pop();
  return parts.join('/');
}

export function discNumberFromFolder(relativeDir: string): number | null {
  const last = relativeDir.split('/').filter(Boolean).at(-1);
  const m = last?.match(/^(?:cd|disc|disk|dvd|sacd)\s*[-_.]?\s*(\d+)/i);
  return m ? Number.parseInt(m[1] as string, 10) : null;
}

export function albumGroupKey(
  albumArtist: string,
  album: string,
  rootId: string | null,
  albumFolder: string,
  releaseId: string | null,
): string {
  const scope = releaseId ? `mb:${releaseId}` : `${rootId ?? '-'}:${normalizeText(albumFolder)}`;
  return [normalizeText(albumArtist), normalizeText(album), scope].join('|');
}

/** Split "A; B", "A / B", "A feat. B", "A & B" into individual artist names. */
export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:;|\/|,|＆|、|\b(?:feat|ft|featuring)\b\.?)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}
