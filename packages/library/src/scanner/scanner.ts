import { opendir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { ArtworkStore } from '../artwork/artwork-store';
import { AUDIO_EXTENSIONS } from '../format';
import { albumFolderOf, discNumberFromFolder, pathKey } from '../normalize';
import type { LibraryRepository } from '../repositories/library-repo';
import {
  emptyMetadata,
  metadataFromPath,
  readEmbeddedPicture,
  readWithMusicMetadata,
  type MetadataReader,
  type ParsedMetadata,
} from './metadata';

export interface ScanProgress {
  filesSeen: number;
  filesParsed: number;
  filesUnchanged: number;
  added: number;
  updated: number;
  markedUnavailable: number;
  errors: number;
  currentFolder: string | null;
}

export interface ScanResult extends ScanProgress {
  state: 'completed' | 'failed' | 'cancelled';
  message: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface ScanOptions {
  library: LibraryRepository;
  artwork: ArtworkStore;
  rootId: string;
  /** Parallel metadata reads. Kept low so a scan never competes with DSD512 playback. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  readMetadata?: MetadataReader;
  readPicture?: (file: string) => Promise<{ data: Uint8Array; mime: string } | null>;
  now?: () => number;
}

const SKIP_DIRS = new Set([
  'system volume information',
  '$recycle.bin',
  '@eadir',
  '#recycle',
  'lost+found',
]);
const FOLDER_IMAGES = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'front.jpg',
  'front.png',
  'albumart.jpg',
];

function toRelativeDir(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath);
  const dir = rel.split(sep).slice(0, -1).join('/');
  return dir.normalize('NFC');
}

async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [dir];
  while (stack.length) {
    if (signal?.aborted) return;
    const current = stack.pop() as string;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue; // unreadable folder: skip, keep scanning the rest
    }
    for await (const entry of handle) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase())) continue;
        stack.push(join(current, name));
      } else if (entry.isFile()) {
        if (name.startsWith('._')) continue; // macOS resource forks
        const ext = extname(name).slice(1).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) yield join(current, name);
      }
      // symbolic links are not followed (avoids loops); documented limitation
    }
  }
}

function merge(
  tags: ParsedMetadata,
  fromPath: Partial<ParsedMetadata>,
  relDir: string,
): ParsedMetadata {
  const artist =
    tags.artist ?? tags.albumArtist ?? fromPath.artist ?? fromPath.albumArtist ?? 'Unknown Artist';
  return {
    ...tags,
    title: tags.title ?? fromPath.title ?? 'Untitled',
    artist,
    albumArtist:
      tags.albumArtist ??
      (tags.compilation ? 'Various Artists' : null) ??
      fromPath.albumArtist ??
      artist,
    album: tags.album ?? fromPath.album ?? 'Unknown Album',
    year: tags.year ?? fromPath.year ?? null,
    trackNumber: tags.trackNumber ?? fromPath.trackNumber ?? null,
    discNumber: tags.discNumber ?? fromPath.discNumber ?? discNumberFromFolder(relDir),
    codec: tags.codec ?? fromPath.codec ?? null,
  };
}

/**
 * Scan one library root: walk folders, read metadata for new/changed files, and persist.
 *
 * Safety rules:
 *  - source files are only ever read, never modified or moved;
 *  - a missing/offline root marks its tracks unavailable and stops (nothing is deleted);
 *  - per-file errors are isolated (the track is kept with filename-derived metadata);
 *  - unseen files are marked unavailable only after a scan that completed without cancellation.
 */
export async function scanRoot(opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  const readMeta = opts.readMetadata ?? readWithMusicMetadata;
  const readPic = opts.readPicture ?? readEmbeddedPicture;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 2));
  const { library } = opts;
  const root = library.getRootRow(opts.rootId);
  const startedAt = now();
  const p: ScanProgress = {
    filesSeen: 0,
    filesParsed: 0,
    filesUnchanged: 0,
    added: 0,
    updated: 0,
    markedUnavailable: 0,
    errors: 0,
    currentFolder: null,
  };
  let lastEmit = 0;
  const emit = (force = false) => {
    const t = now();
    if (force || t - lastEmit > 250) {
      lastEmit = t;
      opts.onProgress?.({ ...p });
    }
  };
  const finish = (state: ScanResult['state'], message: string | null): ScanResult => {
    emit(true);
    return { ...p, state, message, startedAt, finishedAt: now() };
  };

  if (root.kind === 'fixture')
    return finish('completed', 'Fixture library — nothing to scan on disk.');

  try {
    const s = await stat(root.path);
    if (!s.isDirectory()) throw new Error('not a directory');
  } catch (err) {
    p.markedUnavailable = library.setRootTracksAvailable(root.id, false);
    library.setRootStatus(
      root.id,
      'offline',
      `Folder not reachable: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    );
    return finish('failed', 'root_offline');
  }
  library.setRootStatus(root.id, 'online', null);

  const queue: string[] = [];
  let walking = true;
  const producer = (async () => {
    for await (const file of walk(root.path, opts.signal)) {
      queue.push(file);
      p.filesSeen++;
    }
    walking = false;
  })();

  const processFile = async (file: string) => {
    const relDir = toRelativeDir(root.path, file);
    const fileName = basename(file).normalize('NFC');
    p.currentFolder = relDir;
    const key = pathKey(file);
    let st;
    try {
      st = await stat(file);
    } catch {
      p.errors++;
      return;
    }
    const identity = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const existing = library.findTrackByPathKey(key);
    if (
      existing &&
      existing.size_bytes === st.size &&
      existing.mtime_ms === Math.floor(st.mtimeMs)
    ) {
      library.touchTrack(existing.id, now());
      p.filesUnchanged++;
      return;
    }
    let tags = emptyMetadata();
    let scanError: string | null = null;
    try {
      tags = await readMeta(file);
      p.filesParsed++;
    } catch (err) {
      scanError = (err as Error).message.slice(0, 500);
      p.errors++;
    }
    const fromPath = metadataFromPath(relDir, fileName);
    const m = merge(tags, fromPath, relDir);
    const seenAt = now();
    const albumId = library.ensureAlbum({
      title: m.album as string,
      albumArtist: m.albumArtist as string,
      year: m.year,
      releaseId: m.releaseId,
      rootId: root.id,
      folder: albumFolderOf(relDir),
      genre: m.genre,
      now: seenAt,
    });
    const { created } = library.upsertTrack({
      rootId: root.id,
      sourcePath: file,
      pathKey: key,
      relativeDir: relDir,
      fileName,
      fileIdentity: identity,
      title: m.title as string,
      artist: m.artist as string,
      albumArtist: m.albumArtist as string,
      album: m.album as string,
      albumId,
      genre: m.genre,
      year: m.year,
      discNumber: m.discNumber,
      discTotal: m.discTotal,
      trackNumber: m.trackNumber,
      trackTotal: m.trackTotal,
      durationMs: m.durationMs,
      sampleRate: m.sampleRate,
      bitDepth: m.bitDepth,
      channels: m.channels,
      codec: m.codec,
      container: m.container,
      lossless: m.lossless,
      isDsd: m.isDsd,
      bitrate: m.bitrate,
      mtimeMs: Math.floor(st.mtimeMs),
      sizeBytes: st.size,
      metadataSource: scanError || (!tags.title && !tags.album) ? 'filename' : 'tags',
      scanError,
      seenAt,
    });
    if (created) p.added++;
    else p.updated++;
  };

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const file = queue.shift();
      if (file === undefined) {
        if (!walking) return;
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      await processFile(file);
      emit();
    }
  });
  await Promise.all([producer, ...workers]);

  if (opts.signal?.aborted) {
    library.setRootStatus(root.id, 'online', null);
    return finish('cancelled', 'Scan cancelled; nothing was marked unavailable.');
  }

  p.markedUnavailable += library.markUnseenUnavailable(root.id, startedAt);

  // Artwork pass: folder image first (cheap), embedded picture second.
  for (const a of library.albumsMissingArtwork(root.id)) {
    if (opts.signal?.aborted) break;
    let artId: string | null = null;
    const dirs = [a.folderPath];
    if (discNumberFromFolder(a.folderPath.replace(/\\/g, '/')) !== null)
      dirs.push(a.folderPath.replace(/[\\/][^\\/]*$/, ''));
    for (const dir of dirs) {
      for (const name of FOLDER_IMAGES) {
        try {
          const bytes = await readFile(join(dir, name));
          artId = opts.artwork.put(
            bytes,
            name.endsWith('.png') ? 'image/png' : 'image/jpeg',
            'folder',
          );
          if (artId) break;
        } catch {
          // not present
        }
      }
      if (artId) break;
    }
    if (!artId) {
      try {
        const pic = await readPic(a.sourcePath);
        if (pic) artId = opts.artwork.put(pic.data, pic.mime, 'embedded');
      } catch {
        // unreadable picture: leave placeholder
      }
    }
    if (artId) library.setAlbumArtwork(a.albumId, artId);
  }

  library.setRootStatus(
    root.id,
    'online',
    p.errors ? `${p.errors} file(s) could not be fully read` : null,
    now(),
  );
  return finish('completed', null);
}
