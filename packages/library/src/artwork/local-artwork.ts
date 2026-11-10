import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { discNumberFromFolder } from '../normalize';
import type { ArtworkStore } from './artwork-store';

/**
 * Cover art that lives with the music. Where an album's cover is looked for, in this order
 * (letter case never matters; JPEG, PNG and WebP):
 *  1. a well-known file name in the album folder: `cover`, `folder`, `front`, `albumart`,
 *     `album`, `artwork`, `albumartsmall`, `thumb`;
 *  2. any image whose name contains "cover" or "front" (`Album - Front.jpg`, `00-cover.png`,
 *     `AlbumArt_{…}_Large.jpg`), or the album folder's only image;
 *  3. the same in an `Artwork` / `Covers` / `Scans` / `Art` / `Images` / `封面` sub-folder;
 *  4. for a disc folder (`CD1`, `Disc 2`), the same in the parent album folder;
 *  5. the picture embedded in one of the album's audio files.
 */

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
/** Exact base names, best first. */
const COVER_NAMES = [
  'cover',
  'folder',
  'front',
  'albumart',
  'album',
  'artwork',
  'albumartsmall',
  'thumb',
];
const COVER_HINT = /cover|front|albumart|封面/;
/** Booklet pages and backs are not the cover. */
const NOT_COVER = /back|inlay|booklet|tray|disc|cd\d|matrix|spine|背面|封底/;
const ART_DIRS = new Set([
  'artwork',
  'art',
  'covers',
  'cover',
  'scans',
  'scan',
  'images',
  'image',
  '封面',
]);
/** Same cap as the artwork cache: larger files are scans, not covers. */
const MAX_COVER_FILE_BYTES = 12 * 1024 * 1024;

const lower = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * The cover among a folder's entries, or null. `allowOnlyImage`: accept the folder's single
 * image even when its name says nothing (off for scan sub-folders full of booklet pages).
 */
export function pickCoverFile(entries: readonly string[], allowOnlyImage = true): string | null {
  const images = entries.filter((e) => IMAGE_MIME[extname(lower(e))] !== undefined);
  if (images.length === 0) return null;
  const base = (e: string) => lower(e).slice(0, -extname(e).length);
  for (const name of COVER_NAMES) {
    const hit = images.find((e) => base(e) === name);
    if (hit) return hit;
  }
  const hinted = images
    .filter((e) => COVER_HINT.test(base(e)) && !NOT_COVER.test(base(e)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (hinted[0]) return hinted[0];
  const only = images.length === 1 ? images[0]! : null;
  return allowOnlyImage && only && !NOT_COVER.test(base(only)) ? only : null;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return []; // folder offline or unreadable
  }
}

/** The cover image file of an album folder (sub-folders for artwork included), or null. */
export async function findFolderCover(dir: string): Promise<{ file: string; mime: string } | null> {
  const entries = await listDir(dir);
  const found = (folder: string, name: string) => ({
    file: join(folder, name),
    mime: IMAGE_MIME[extname(lower(name))] as string,
  });
  const here = pickCoverFile(entries);
  if (here) return found(dir, here);
  for (const sub of entries.filter((e) => ART_DIRS.has(lower(e)))) {
    const inner = pickCoverFile(await listDir(join(dir, sub)), false);
    if (inner) return found(join(dir, sub), inner);
  }
  return null;
}

export interface LocalArtworkOptions {
  /** Folder of one of the album's tracks. */
  folderPath: string;
  /** One of the album's audio files (for the embedded picture). */
  sourcePath: string;
  artwork: ArtworkStore;
  readPicture: (file: string) => Promise<{ data: Uint8Array; mime: string } | null>;
  /** Awaited before the audio file is opened (scans slow down while HQPlayer plays). */
  pace?: () => Promise<void>;
}

/**
 * Find an album's cover among its files and put it into the artwork cache. Returns the artwork
 * id, or null when the album has no usable cover on disk.
 */
export async function findLocalArtwork(opts: LocalArtworkOptions): Promise<string | null> {
  const dirs = [opts.folderPath];
  if (discNumberFromFolder(opts.folderPath.replace(/\\/g, '/')) !== null) {
    dirs.push(opts.folderPath.replace(/[\\/][^\\/]*$/, ''));
  }
  for (const dir of dirs) {
    const cover = await findFolderCover(dir);
    if (!cover) continue;
    try {
      if ((await stat(cover.file)).size > MAX_COVER_FILE_BYTES) continue;
      const id = opts.artwork.put(await readFile(cover.file), cover.mime, 'folder');
      if (id) return id;
    } catch {
      // vanished or unreadable: try the next place
    }
  }
  try {
    await opts.pace?.();
    const pic = await opts.readPicture(opts.sourcePath);
    if (pic) return opts.artwork.put(pic.data, pic.mime, 'embedded');
  } catch {
    // unreadable picture: leave the placeholder
  }
  return null;
}
