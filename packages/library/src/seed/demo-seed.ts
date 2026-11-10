import demo from '../../../../fixtures/library/demo-library.json' with { type: 'json' };
import { generateCoverSvg } from '../artwork/generated-cover';
import type { ArtworkStore } from '../artwork/artwork-store';
import { pathKey } from '../normalize';
import type { LibraryRepository } from '../repositories/library-repo';
import type { PlaylistRepository } from '../repositories/playlist-repo';

interface DemoTrack {
  title: string;
  duration: number;
  disc?: number;
  artist?: string;
}
interface DemoAlbum {
  title: string;
  albumArtist: string;
  year: number;
  genre: string;
  folder: string;
  format: {
    codec: string;
    container: string;
    ext: string;
    sampleRate: number;
    bitDepth: number | null;
    isDsd?: boolean;
    bitrate?: number;
    lossless?: boolean;
  };
  tracks: DemoTrack[];
}
interface DemoFixture {
  rootPath: string;
  albums: DemoAlbum[];
  playlists: { name: string; description: string; tracks: [string, string][] }[];
}

const fixture = demo as unknown as DemoFixture;

/** Characters Windows does not allow in file names. */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, ' -')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DemoSeedResult {
  skipped: boolean;
  rootId: string | null;
  albums: number;
  tracks: number;
  playlists: number;
}

/**
 * Load the fictional demo library (fixtures/library/demo-library.json). Idempotent: does
 * nothing if the fixture root already exists. Source paths are fictional Windows paths; the
 * Mock engine "plays" them without touching any file.
 */
export function seedDemoLibrary(
  library: LibraryRepository,
  playlists: PlaylistRepository,
  artwork: ArtworkStore,
  now = Date.now(),
): DemoSeedResult {
  const rootKey = pathKey(fixture.rootPath, 'win32');
  if (library.listRoots().some((r) => pathKey(r.path, 'win32') === rootKey)) {
    return { skipped: true, rootId: null, albums: 0, tracks: 0, playlists: 0 };
  }
  const root = library.addRoot(fixture.rootPath, {
    kind: 'fixture',
    name: 'Demo Library (fixture)',
    now,
  });
  const ids = new Map<string, string>();
  let trackCount = 0;

  fixture.albums.forEach((album, albumIndex) => {
    // Stagger "added" times so the "recently added" view has a stable order.
    const addedAt = now - (fixture.albums.length - albumIndex) * 3_600_000;
    const albumId = library.ensureAlbum({
      title: album.title,
      albumArtist: album.albumArtist,
      year: album.year,
      releaseId: null,
      rootId: root.id,
      folder: album.folder,
      genre: album.genre,
      now: addedAt,
    });
    const svg = generateCoverSvg(
      `${album.albumArtist}|${album.title}|${album.folder}`,
      album.title,
      album.albumArtist,
    );
    const artId = artwork.put(Buffer.from(svg, 'utf8'), 'image/svg+xml', 'generated');
    if (artId) library.setAlbumArtwork(albumId, artId);

    const multiDisc = album.tracks.some((t) => (t.disc ?? 1) > 1);
    const perDisc = new Map<number, number>();
    for (const t of album.tracks) {
      const disc = t.disc ?? 1;
      const n = (perDisc.get(disc) ?? 0) + 1;
      perDisc.set(disc, n);
      const relDir = multiDisc ? `${album.folder}/CD${disc}` : album.folder;
      const fileName = `${String(n).padStart(2, '0')} ${sanitizeFileName(t.title)}.${album.format.ext}`;
      const sourcePath = `${fixture.rootPath}\\${relDir.replace(/\//g, '\\')}\\${fileName}`;
      const { id } = library.upsertTrack({
        rootId: root.id,
        sourcePath,
        pathKey: pathKey(sourcePath, 'win32'),
        relativeDir: relDir,
        fileName,
        fileIdentity: null,
        title: t.title,
        artist: t.artist ?? album.albumArtist,
        albumArtist: album.albumArtist,
        album: album.title,
        albumId,
        genre: album.genre,
        year: album.year,
        discNumber: multiDisc ? disc : 1,
        discTotal: multiDisc ? Math.max(...album.tracks.map((x) => x.disc ?? 1)) : 1,
        trackNumber: n,
        trackTotal: album.tracks.filter((x) => (x.disc ?? 1) === disc).length,
        durationMs: t.duration * 1000,
        sampleRate: album.format.sampleRate,
        bitDepth: album.format.bitDepth,
        channels: 2,
        codec: album.format.codec,
        container: album.format.container,
        lossless: album.format.lossless ?? true,
        isDsd: Boolean(album.format.isDsd),
        bitrate: album.format.bitrate ?? null,
        mtimeMs: null,
        sizeBytes: null,
        metadataSource: 'fixture',
        scanError: null,
        seenAt: addedAt,
      });
      const key = `${album.title}\u0000${t.title}`;
      if (!ids.has(key)) ids.set(key, id);
      trackCount++;
    }
  });

  let playlistCount = 0;
  if (playlists.list().length === 0) {
    for (const pl of fixture.playlists) {
      const trackIds = pl.tracks
        .map(([album, title]) => ids.get(`${album}\u0000${title}`))
        .filter((x): x is string => Boolean(x));
      playlists.create({ name: pl.name, description: pl.description, trackIds }, now);
      playlistCount++;
    }
  }

  return {
    skipped: false,
    rootId: root.id,
    albums: fixture.albums.length,
    tracks: trackCount,
    playlists: playlistCount,
  };
}

export const DEMO_ROOT_PATH = fixture.rootPath;
