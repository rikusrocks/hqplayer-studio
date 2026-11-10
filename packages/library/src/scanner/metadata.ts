import { basename, dirname, extname } from 'node:path';
import { codecFromExtension } from '../format';
import { discNumberFromFolder } from '../normalize';
import { decodeLegacy, detectLegacyEncoding, languageHint } from './legacy-encoding';

export interface ParsedMetadata {
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  discNumber: number | null;
  discTotal: number | null;
  trackNumber: number | null;
  trackTotal: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  lossless: boolean | null;
  isDsd: boolean;
  bitrate: number | null;
  releaseId: string | null;
  compilation: boolean;
}

export type MetadataReader = (filePath: string) => Promise<ParsedMetadata>;

export function emptyMetadata(): ParsedMetadata {
  return {
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    genre: null,
    year: null,
    discNumber: null,
    discTotal: null,
    trackNumber: null,
    trackTotal: null,
    durationMs: null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    codec: null,
    container: null,
    lossless: null,
    isDsd: false,
    bitrate: null,
    releaseId: null,
    compilation: false,
  };
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * Some tag formats (RIFF INFO in WAV, ID3v1, old AIFF) are decoded as Latin-1, but Windows
 * taggers often write UTF-8 there — CJK titles then arrive as mojibake ("åæ¹çé£").
 * If a string only contains Latin-1 code points AND its bytes form valid UTF-8 with non-ASCII
 * characters, use the UTF-8 reading. Genuine Latin-1 text ("Café") is not valid UTF-8, so it is
 * left untouched.
 */
export function repairMojibake(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || /[^\p{ASCII}\u0080-\u00ff]/u.test(value)) return value;
  try {
    const decoded = utf8Strict.decode(Buffer.from(value, 'latin1'));
    return /[^\p{ASCII}]/u.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = repairMojibake(v.replace(/\0/g, '')).trim();
  return s || null;
};

/** Read tags + stream info with music-metadata (never writes to the file). */
export const readWithMusicMetadata: MetadataReader = async (filePath) => {
  const { parseFile } = await import('music-metadata');
  const mm = await parseFile(filePath, {
    duration: false,
    skipCovers: true,
    skipPostHeaders: true,
  });
  const c = mm.common;
  const f = mm.format;
  const container = clean(f.container);
  const codec = clean(f.codec);
  const isDsd =
    /dsd|dsf|dsdiff|dff/i.test(`${container ?? ''} ${codec ?? ''}`) ||
    (f.bitsPerSample === 1 && (f.sampleRate ?? 0) >= 2_822_400);
  const year = c.year ?? (c.date ? Number.parseInt(String(c.date).slice(0, 4), 10) : null);
  const text = {
    title: clean(c.title),
    artist: clean(c.artist) ?? clean(c.artists?.join(', ')),
    albumArtist: clean(c.albumartist),
    album: clean(c.album),
    genre: clean(c.genre?.[0]),
  };
  // GBK / Shift-JIS tags read as Latin-1: judge all fields of the file together, with the
  // album folder + file name (real Unicode) as a language hint.
  const legacy = detectLegacyEncoding(
    Object.values(text).filter((v): v is string => v !== null),
    languageHint(`${basename(dirname(filePath))}/${basename(filePath)}`),
  );
  if (legacy) {
    for (const key of Object.keys(text) as (keyof typeof text)[]) {
      const v = text[key];
      if (v) text[key] = decodeLegacy(v, legacy);
    }
  }
  return {
    ...text,
    year: Number.isFinite(year) ? (year as number) : null,
    discNumber: c.disk?.no ?? null,
    discTotal: c.disk?.of ?? null,
    trackNumber: c.track?.no ?? null,
    trackTotal: c.track?.of ?? null,
    durationMs: f.duration ? Math.round(f.duration * 1000) : null,
    sampleRate: f.sampleRate ?? null,
    bitDepth: isDsd ? 1 : (f.bitsPerSample ?? null),
    channels: f.numberOfChannels ?? null,
    codec,
    container,
    lossless: f.lossless ?? null,
    isDsd,
    bitrate: f.bitrate ? Math.round(f.bitrate) : null,
    releaseId: clean(c.musicbrainz_albumid),
    compilation: Boolean(c.compilation),
  };
};

export async function readEmbeddedPicture(
  filePath: string,
): Promise<{ data: Uint8Array; mime: string } | null> {
  const { parseFile, selectCover } = await import('music-metadata');
  const mm = await parseFile(filePath, {
    duration: false,
    skipCovers: false,
    skipPostHeaders: true,
  });
  const pic = selectCover(mm.common.picture);
  if (!pic) return null;
  return { data: pic.data, mime: pic.format };
}

/**
 * Best-effort metadata from the file and folder names, used when tags are missing or the file
 * cannot be parsed. Handles "01 - Title", "1-01 Title", "01. Artist - Title" and album folders
 * like "Artist - Album (2019)".
 */
export function metadataFromPath(relativeDir: string, fileName: string): Partial<ParsedMetadata> {
  const ext = extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length).trim();
  const out: Partial<ParsedMetadata> = { codec: codecFromExtension(ext) };

  let rest = base;
  const discTrack = base.match(/^(\d{1,2})[-.](\d{1,3})[\s._-]+(.+)$/);
  const trackOnly = base.match(/^(\d{1,3})(?:\s*[-._)]\s*|\s+)(.+)$/);
  if (discTrack) {
    out.discNumber = Number.parseInt(discTrack[1] as string, 10);
    out.trackNumber = Number.parseInt(discTrack[2] as string, 10);
    rest = discTrack[3] as string;
  } else if (trackOnly) {
    out.trackNumber = Number.parseInt(trackOnly[1] as string, 10);
    rest = trackOnly[2] as string;
  }
  const dash = rest.split(/\s+-\s+/);
  if (dash.length >= 2) {
    out.artist = (dash[0] as string).trim();
    out.title = dash.slice(1).join(' - ').trim();
  } else {
    out.title = rest.trim();
  }

  const dirs = relativeDir.split('/').filter(Boolean);
  const discFromFolder = discNumberFromFolder(relativeDir);
  if (discFromFolder !== null) {
    out.discNumber ??= discFromFolder;
    dirs.pop();
  }
  const albumDir = dirs.at(-1);
  if (albumDir) {
    const m = albumDir.match(/^(.+?)\s+-\s+(.+?)(?:\s*[([](\d{4})[)\]])?(?:\s*[([][^)\]]*[)\]])*$/);
    if (m) {
      out.albumArtist = (m[1] as string).trim();
      out.album = (m[2] as string).trim();
      if (m[3]) out.year = Number.parseInt(m[3], 10);
    } else {
      out.album = albumDir.replace(/\s*[([](\d{4})[)\]]\s*$/, '').trim();
      const artistDir = dirs.at(-2);
      if (artistDir) out.albumArtist = artistDir;
    }
  }
  return out;
}
