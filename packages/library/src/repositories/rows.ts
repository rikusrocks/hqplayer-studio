import type { AlbumSummary, LibraryRoot, Track } from '@hqps/contracts';
import { trackFormatLabel } from '../format';

export interface TrackRow {
  id: string;
  root_id: string | null;
  source_path: string;
  path_key: string;
  relative_dir: string;
  file_name: string;
  file_identity: string | null;
  title: string;
  artist: string;
  album_artist: string;
  album: string;
  album_id: string | null;
  genre: string | null;
  year: number | null;
  disc_number: number | null;
  disc_total: number | null;
  track_number: number | null;
  track_total: number | null;
  duration_ms: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  lossless: number | null;
  is_dsd: number;
  bitrate: number | null;
  mtime_ms: number | null;
  size_bytes: number | null;
  available: number;
  last_seen_at: number | null;
  metadata_source: 'tags' | 'filename' | 'fixture';
  scan_error: string | null;
  created_at: number;
  updated_at: number;
  /** joined from albums */
  artwork_id?: string | null;
}

export interface AlbumAggRow {
  id: string;
  title: string;
  album_artist: string;
  album_artist_id: string | null;
  year: number | null;
  artwork_id: string | null;
  folder: string | null;
  created_at: number;
  track_count: number;
  disc_count: number;
  duration_ms: number | null;
  available: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  is_dsd: number | null;
  codec: string | null;
  container: string | null;
  bitrate: number | null;
  genre: string | null;
}

export interface RootRow {
  id: string;
  path: string;
  path_key: string;
  name: string;
  kind: 'local' | 'unc' | 'fixture';
  enabled: number;
  status: 'online' | 'offline' | 'unknown';
  last_scanned_at: number | null;
  last_error: string | null;
  created_at: number;
  track_count?: number;
}

export const TRACK_SELECT = `SELECT t.*, al.artwork_id AS artwork_id FROM tracks t LEFT JOIN albums al ON al.id = t.album_id`;

export function rowToTrack(r: TrackRow): Track {
  const isDsd = r.is_dsd === 1;
  return {
    id: r.id,
    albumId: r.album_id,
    title: r.title,
    artist: r.artist,
    albumArtist: r.album_artist,
    album: r.album,
    genre: r.genre,
    year: r.year,
    discNumber: r.disc_number,
    trackNumber: r.track_number,
    durationMs: r.duration_ms,
    format: {
      codec: r.codec,
      container: r.container,
      sampleRate: r.sample_rate,
      bitDepth: isDsd ? 1 : r.bit_depth,
      channels: r.channels,
      lossless: r.lossless === null ? null : r.lossless === 1,
      isDsd,
      label: trackFormatLabel({
        codec: r.codec,
        container: r.container,
        sampleRate: r.sample_rate,
        bitDepth: r.bit_depth,
        isDsd,
        bitrate: r.bitrate,
      }),
    },
    fileName: r.file_name,
    folder: r.relative_dir,
    rootId: r.root_id,
    available: r.available === 1,
    artworkId: r.artwork_id ?? null,
  };
}

export function rowToAlbum(r: AlbumAggRow): AlbumSummary {
  return {
    id: r.id,
    title: r.title,
    albumArtist: r.album_artist,
    albumArtistId: r.album_artist_id,
    year: r.year,
    genre: r.genre,
    trackCount: r.track_count,
    discCount: Math.max(1, r.disc_count),
    durationMs: r.duration_ms ?? 0,
    artworkId: r.artwork_id,
    formatLabel: trackFormatLabel({
      codec: r.codec,
      container: r.container,
      sampleRate: r.sample_rate,
      bitDepth: r.bit_depth,
      isDsd: r.is_dsd === 1,
      bitrate: r.bitrate,
    }),
    available: r.available === 1,
    addedAt: r.created_at,
  };
}

export function rowToRoot(r: RootRow): LibraryRoot {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled === 1,
    status: r.status,
    lastScannedAt: r.last_scanned_at,
    lastError: r.last_error,
    trackCount: r.track_count ?? 0,
  };
}
