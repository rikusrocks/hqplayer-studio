import { z } from 'zod';

/**
 * Where a track's lyrics came from. `local` = a `.lrc` file next to the audio file,
 * `embedded` = lyrics stored in the file's tags, `lrclib` = LRCLIB (online, opt-in),
 * `demo` = invented lyrics for the fictional demo library.
 */
export const LyricsSourceSchema = z.enum(['local', 'embedded', 'lrclib', 'demo']);
export type LyricsSource = z.infer<typeof LyricsSourceSchema>;

export const LyricLineSchema = z.object({
  /** Start time in ms of the audio file (the file's own `[offset:]` already applied). */
  timeMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type LyricLineDto = z.infer<typeof LyricLineSchema>;

/** Largest per-track calibration, either way. */
export const MAX_LYRICS_OFFSET_MS = 30_000;

/**
 * Lyrics of one library track.
 *  - `found`: `kind` says synced (time-coded `lines`) or plain (static `plain` lines);
 *    `instrumental` = LRCLIB says the track has no vocals.
 *  - `not_found`: nothing in the enabled places (local file, tags, cache, LRCLIB if on).
 *  - `unavailable`: LRCLIB could not be asked right now (offline, 429…); playback is unaffected.
 */
export const TrackLyricsSchema = z.object({
  trackId: z.string(),
  state: z.enum(['found', 'not_found', 'unavailable']),
  source: LyricsSourceSchema.nullable(),
  kind: z.enum(['synced', 'plain']).nullable(),
  lines: z.array(LyricLineSchema),
  plain: z.array(z.string()),
  instrumental: z.boolean(),
  /** Per-track calibration chosen by the user: positive = lyrics later, negative = earlier. */
  offsetMs: z.number().int(),
  /** The user picked these lyrics by hand (they win over every automatic source). */
  selectedByUser: z.boolean(),
  online: z.object({
    /** Settings → 歌词 → online lookups (off by default). */
    enabled: z.boolean(),
    /** Online lookups happen only for the track that is playing. */
    eligible: z.boolean(),
    /** When LRCLIB was last asked about this track (epoch ms). */
    checkedAt: z.number().nullable(),
    /** When `unavailable`: ms until Studio may ask LRCLIB again. */
    retryAfterMs: z.number().nullable(),
  }),
});
export type TrackLyrics = z.infer<typeof TrackLyricsSchema>;

export const LyricsOffsetRequestSchema = z.object({
  offsetMs: z.number().int().min(-MAX_LYRICS_OFFSET_MS).max(MAX_LYRICS_OFFSET_MS),
});
export type LyricsOffsetRequest = z.infer<typeof LyricsOffsetRequestSchema>;

/** One LRCLIB search result offered for manual matching (desktop only). */
export const LyricsCandidateSchema = z.object({
  lrclibId: z.number().int(),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string(),
  durationMs: z.number().int().nullable(),
  synced: z.boolean(),
  instrumental: z.boolean(),
  /** First few lines, so the user can recognise the right lyrics. */
  preview: z.array(z.string()).max(4),
});
export type LyricsCandidate = z.infer<typeof LyricsCandidateSchema>;

export const LyricsSearchQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

export const LyricsSelectRequestSchema = z.object({ lrclibId: z.number().int().positive() });
export type LyricsSelectRequest = z.infer<typeof LyricsSelectRequestSchema>;

export const LyricsSettingsSchema = z.object({
  /** Ask LRCLIB when no local lyrics exist (sends title/artist/album/duration). Default off. */
  online: z.boolean(),
  /** Number of tracks with stored lyrics, by source (no lyric text). */
  cached: z.object({
    local: z.number().int(),
    embedded: z.number().int(),
    lrclib: z.number().int(),
    demo: z.number().int(),
    notFound: z.number().int(),
  }),
  /** ms until LRCLIB may be asked again (after 429/outage), else 0. */
  onlinePausedForMs: z.number().int(),
});
export type LyricsSettings = z.infer<typeof LyricsSettingsSchema>;

export const UpdateLyricsSettingsRequestSchema = z.object({ online: z.boolean() });
export type UpdateLyricsSettingsRequest = z.infer<typeof UpdateLyricsSettingsRequestSchema>;
