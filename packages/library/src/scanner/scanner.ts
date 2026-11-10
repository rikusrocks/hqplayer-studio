import { opendir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { ArtworkStore } from '../artwork/artwork-store';
import { findLocalArtwork } from '../artwork/local-artwork';
import { AUDIO_EXTENSIONS } from '../format';
import { albumFolderOf, discNumberFromFolder, pathKey } from '../normalize';
import type { LibraryRepository } from '../repositories/library-repo';
import { planFolderAlbum } from './album-grouping';
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
  moved: number;
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
  /**
   * Only rescan these folders (relative to the root, "/"-separated), e.g. the ones a file
   * watcher reported. Files that vanished under them become unavailable; the rest of the root
   * is untouched. Omitted/empty = the whole root.
   */
  subtrees?: string[];
  /**
   * Which albums without artwork to look at: `all` (manual full scan) or only albums whose
   * tracks changed in this scan / live under `subtrees` (`changed`, automatic scans).
   */
  artworkScope?: 'all' | 'changed';
  /** Awaited before each file; lets the caller slow a scan down (e.g. while HQPlayer plays). */
  pace?: () => Promise<void>;
}

const SKIP_DIRS = new Set([
  'system volume information',
  '$recycle.bin',
  '@eadir',
  '#recycle',
  'lost+found',
]);
/** Paths the scanner never indexes: hidden entries, recycle bins, NAS metadata folders. */
export function isIgnoredLibraryPath(relPath: string): boolean {
  return relPath
    .split('/')
    .some((part) => part.startsWith('.') || SKIP_DIRS.has(part.toLowerCase()));
}

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
    moved: 0,
    markedUnavailable: 0,
    errors: 0,
    currentFolder: null,
  };

  // Database writes are queued and committed in batches (one transaction per ~200 files or
  // 200 ms) instead of one commit per file. Each write is isolated: a failing one is counted
  // and skipped without rolling back the rest of the batch.
  const pending: Array<() => void> = [];
  let lastFlush = now();
  const flush = () => {
    lastFlush = now();
    if (pending.length === 0) return;
    const ops = pending.splice(0);
    library.batch(() => {
      for (const op of ops) {
        try {
          op();
        } catch {
          p.errors++;
        }
      }
    });
  };
  const claimedMoves = new Set<string>();
  /** The file at a new path may be an old track whose file was moved or renamed by folder. */
  const movedFrom = async (identity: string, fileName: string, key: string) => {
    for (const c of library.findMoveCandidates(identity, fileName, key)) {
      if (claimedMoves.has(c.id) || (c.last_seen_at ?? 0) >= startedAt) continue;
      try {
        await stat(c.source_path);
        continue; // the old file is still there: this is a copy, not a move
      } catch {
        claimedMoves.add(c.id);
        return c.id;
      }
    }
    return null;
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
  const subtrees = normalizeSubtrees(opts.subtrees);
  const producer = (async () => {
    for (const start of subtrees ?? ['']) {
      const abs = start ? join(root.path, ...start.split('/')) : root.path;
      let isDir: boolean;
      try {
        const st = await stat(abs);
        isDir = st.isDirectory();
        if (!isDir && AUDIO_EXTENSIONS.has(extname(abs).slice(1).toLowerCase())) {
          queue.push(abs);
          p.filesSeen++;
        }
      } catch {
        continue; // gone: whatever was indexed under it becomes unavailable below
      }
      if (!isDir) continue;
      for await (const file of walk(abs, opts.signal)) {
        queue.push(file);
        p.filesSeen++;
      }
    }
    walking = false;
  })();

  const touchedAlbums = new Set<string>();
  const touchedFolders = new Set<string>();
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
      const seen = now();
      pending.push(() => library.touchTrack(existing.id, seen));
      p.filesUnchanged++;
      return;
    }
    const moveSource = existing ? null : await movedFrom(identity, fileName, key);
    await opts.pace?.(); // only real reads are slowed down; unchanged files cost one stat
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
    pending.push(() => {
      if (moveSource) {
        library.relocateTrack(moveSource, {
          rootId: root.id,
          sourcePath: file,
          pathKey: key,
          relativeDir: relDir,
          fileName,
        });
      }
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
      touchedAlbums.add(albumId);
      touchedFolders.add(albumFolderOf(relDir));
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
      if (moveSource) p.moved++;
      else if (created) p.added++;
      else p.updated++;
    });
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
      if (pending.length >= 200 || now() - lastFlush >= 200) flush();
      emit();
    }
  });
  try {
    await Promise.all([producer, ...workers]);
  } finally {
    flush();
  }

  if (opts.signal?.aborted) {
    library.setRootStatus(root.id, 'online', null);
    return finish('cancelled', 'Scan cancelled; nothing was marked unavailable.');
  }

  // One folder = one album when the tags disagree (other language, edition suffix…) but the
  // track numbering says it is a single album.
  library.batch(() => {
    for (const folder of touchedFolders) {
      const tracks = library.folderTracks(root.id, folder);
      const plan = planFolderAlbum(tracks);
      if (!plan) continue;
      const move = tracks.filter((t) => t.albumId !== plan.albumId).map((t) => t.id);
      if (move.length === 0) continue;
      library.moveTracksToAlbum(move, plan.albumId, plan.title);
      touchedAlbums.add(plan.albumId);
    }
  });

  p.markedUnavailable += subtrees
    ? library.markUnseenUnavailableUnder(root.id, startedAt, subtrees)
    : library.markUnseenUnavailable(root.id, startedAt);

  // Artwork pass: cover image in the album folder first (cheap), embedded picture second.
  const underSubtrees = subtrees ? library.albumIdsUnder(root.id, subtrees) : new Set<string>();
  const artworkCandidates = library
    .albumsMissingArtwork(root.id)
    .filter(
      (a) =>
        opts.artworkScope !== 'changed' ||
        touchedAlbums.has(a.albumId) ||
        underSubtrees.has(a.albumId),
    );
  for (const a of artworkCandidates) {
    if (opts.signal?.aborted) break;
    const artId = await findLocalArtwork({
      folderPath: a.folderPath,
      sourcePath: a.sourcePath,
      artwork: opts.artwork,
      readPicture: readPic,
      pace: opts.pace,
    });
    if (artId) library.setAlbumArtwork(a.albumId, artId);
  }

  library.setRootStatus(
    root.id,
    'online',
    p.errors ? `${p.errors} file(s) could not be fully read` : null,
    subtrees ? undefined : now(),
  );
  return finish('completed', null);
}

/** "/"-separated, NFC, no leading/trailing slashes; drops folders inside other listed folders. */
export function normalizeSubtrees(subtrees: string[] | undefined): string[] | null {
  if (!subtrees || subtrees.length === 0) return null;
  const clean = [
    ...new Set(
      subtrees.map((d) =>
        d
          .replace(/\\/g, '/')
          .split('/')
          .filter((part) => part && part !== '.')
          .join('/')
          .normalize('NFC'),
      ),
    ),
  ];
  if (clean.some((d) => d === '' || d.split('/').includes('..'))) return null; // whole root
  clean.sort();
  const out: string[] = [];
  for (const d of clean) {
    if (!out.some((parent) => d.startsWith(`${parent}/`))) out.push(d);
  }
  return out;
}
