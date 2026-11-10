import { z } from 'zod';

export const TrackFormatSchema = z.object({
  codec: z.string().nullable(),
  container: z.string().nullable(),
  sampleRate: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  lossless: z.boolean().nullable(),
  isDsd: z.boolean(),
  /** Display label, e.g. "FLAC 24/96" or "DSD64". */
  label: z.string(),
});
export type TrackFormat = z.infer<typeof TrackFormatSchema>;

/**
 * A library track as exposed over the API. Absolute file paths are deliberately NOT part of
 * the public DTO: remote clients only see the file name and the folder relative to its root.
 */
export const TrackSchema = z.object({
  id: z.string(),
  albumId: z.string().nullable(),
  title: z.string(),
  artist: z.string(),
  albumArtist: z.string(),
  album: z.string(),
  genre: z.string().nullable(),
  year: z.number().int().nullable(),
  discNumber: z.number().int().nullable(),
  trackNumber: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  format: TrackFormatSchema,
  fileName: z.string(),
  folder: z.string(),
  rootId: z.string().nullable(),
  available: z.boolean(),
  artworkId: z.string().nullable(),
});
export type Track = z.infer<typeof TrackSchema>;

export const AlbumSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  albumArtist: z.string(),
  albumArtistId: z.string().nullable(),
  year: z.number().int().nullable(),
  genre: z.string().nullable(),
  trackCount: z.number().int(),
  discCount: z.number().int(),
  durationMs: z.number().int(),
  artworkId: z.string().nullable(),
  formatLabel: z.string(),
  /** False when every track of the album is currently unavailable (e.g. NAS offline). */
  available: z.boolean(),
  addedAt: z.number(),
});
export type AlbumSummary = z.infer<typeof AlbumSummarySchema>;

export const AlbumDetailSchema = AlbumSummarySchema.extend({
  folder: z.string().nullable(),
  tracks: z.array(TrackSchema),
});
export type AlbumDetail = z.infer<typeof AlbumDetailSchema>;

export const ArtistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  albumCount: z.number().int(),
  trackCount: z.number().int(),
  artworkId: z.string().nullable(),
});
export type ArtistSummary = z.infer<typeof ArtistSummarySchema>;

export const ArtistDetailSchema = ArtistSummarySchema.extend({
  albums: z.array(AlbumSummarySchema),
});
export type ArtistDetail = z.infer<typeof ArtistDetailSchema>;

export const FolderEntrySchema = z.object({
  rootId: z.string(),
  /** Path relative to the root, "/" separated, "" for the root itself. */
  path: z.string(),
  name: z.string(),
  trackCount: z.number().int(),
});
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

export const FolderListingSchema = z.object({
  rootId: z.string(),
  rootName: z.string(),
  path: z.string(),
  folders: z.array(FolderEntrySchema),
  tracks: z.array(TrackSchema),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

export const LibraryRootKindSchema = z.enum(['local', 'unc', 'fixture']);
export const LibraryRootStatusSchema = z.enum(['online', 'offline', 'unknown']);

export const LibraryRootSchema = z.object({
  id: z.string(),
  /** Local display path — only returned to trusted (loopback) clients. */
  path: z.string(),
  name: z.string(),
  kind: LibraryRootKindSchema,
  enabled: z.boolean(),
  status: LibraryRootStatusSchema,
  lastScannedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  trackCount: z.number().int(),
});
export type LibraryRoot = z.infer<typeof LibraryRootSchema>;

export const ScanJobStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const ScanJobSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  state: ScanJobStateSchema,
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  filesSeen: z.number().int(),
  filesParsed: z.number().int(),
  filesUnchanged: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  markedUnavailable: z.number().int(),
  errors: z.number().int(),
  /** Current folder relative to the root (never an absolute path). */
  currentFolder: z.string().nullable(),
  message: z.string().nullable(),
});
export type ScanJob = z.infer<typeof ScanJobSchema>;

export const LibraryStatsSchema = z.object({
  trackCount: z.number().int(),
  albumCount: z.number().int(),
  artistCount: z.number().int(),
  rootCount: z.number().int(),
  unavailableTrackCount: z.number().int(),
  totalDurationMs: z.number().int(),
});
export type LibraryStats = z.infer<typeof LibraryStatsSchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });
}
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export const AlbumPageSchema = pageSchema(AlbumSummarySchema);
export const TrackPageSchema = pageSchema(TrackSchema);
export const ArtistPageSchema = pageSchema(ArtistSummarySchema);
