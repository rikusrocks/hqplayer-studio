import { z } from 'zod';

/**
 * Online lyric sources, in the order they are tried. Each is a separate third party the user
 * switches on by itself: `lrclib` = LRCLIB, `netease` = NetEase Cloud Music (网易云音乐),
 * `kugou` = Kugou Music (酷狗音乐), `lyricsovh` = lyrics.ovh (plain lyrics only).
 */
export const ONLINE_LYRICS_PROVIDERS = ['lrclib', 'netease', 'kugou', 'lyricsovh'] as const;
export const OnlineLyricsProviderSchema = z.enum(ONLINE_LYRICS_PROVIDERS);
export type OnlineLyricsProviderId = z.infer<typeof OnlineLyricsProviderSchema>;

/**
 * Where a track's lyrics came from. `local` = a lyrics file next to the audio file,
 * `embedded` = lyrics stored in the file's tags, an online source (opt-in) or
 * `demo` = invented lyrics for the fictional demo library.
 */
export const LyricsSourceSchema = z.enum(['local', 'embedded', ...ONLINE_LYRICS_PROVIDERS, 'demo']);
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
 *    `instrumental` = the source says the track has no vocals.
 *  - `not_found`: nothing in the enabled places (local file, tags, cache, online sources if on).
 *  - `unavailable`: an online source could not be asked right now (offline, 429…) and none of
 *    the others had the lyrics; playback is unaffected.
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
    /** When the online sources were last asked about this track (epoch ms). */
    checkedAt: z.number().nullable(),
    /** When `unavailable`: ms until Studio may ask the paused source again. */
    retryAfterMs: z.number().nullable(),
  }),
});
export type TrackLyrics = z.infer<typeof TrackLyricsSchema>;

export const LyricsOffsetRequestSchema = z.object({
  offsetMs: z.number().int().min(-MAX_LYRICS_OFFSET_MS).max(MAX_LYRICS_OFFSET_MS),
});
export type LyricsOffsetRequest = z.infer<typeof LyricsOffsetRequestSchema>;

/** One search result of an online source, offered for manual matching (desktop only). */
export const LyricsCandidateSchema = z.object({
  provider: OnlineLyricsProviderSchema,
  /** Opaque reference: send it back with `provider` to use these lyrics. */
  ref: z.string().min(1).max(300),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string(),
  durationMs: z.number().int().nullable(),
  /** Null when the source does not say before the lyrics are fetched. */
  synced: z.boolean().nullable(),
  instrumental: z.boolean(),
  /** First few lines, so the user can recognise the right lyrics (empty when not known yet). */
  preview: z.array(z.string()).max(4),
});
export type LyricsCandidate = z.infer<typeof LyricsCandidateSchema>;

export const LyricsSearchQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

export const LyricsSelectRequestSchema = z.object({
  provider: OnlineLyricsProviderSchema,
  ref: z.string().min(1).max(300),
});
export type LyricsSelectRequest = z.infer<typeof LyricsSelectRequestSchema>;

export const LyricsSettingsSchema = z.object({
  /**
   * Ask the enabled online sources when no local lyrics exist (sends title/artist/album/
   * duration of the playing track). Default off.
   */
  online: z.boolean(),
  /** Every known source in the order it is tried; only enabled ones are ever contacted. */
  providers: z.array(
    z.object({
      id: OnlineLyricsProviderSchema,
      enabled: z.boolean(),
      /** ms until this source may be asked again (after 429/outage), else 0. */
      pausedForMs: z.number().int(),
    }),
  ),
  /** Number of tracks with stored lyrics, by source (no lyric text). */
  cached: z.object({
    local: z.number().int(),
    embedded: z.number().int(),
    lrclib: z.number().int(),
    netease: z.number().int(),
    kugou: z.number().int(),
    lyricsovh: z.number().int(),
    demo: z.number().int(),
    notFound: z.number().int(),
  }),
  /** ms until an enabled source may be asked again; 0 while at least one can be asked now. */
  onlinePausedForMs: z.number().int(),
});
export type LyricsSettings = z.infer<typeof LyricsSettingsSchema>;

export const UpdateLyricsSettingsRequestSchema = z
  .object({
    online: z.boolean().optional(),
    /** The sources to use (the order is fixed; duplicates are ignored). */
    providers: z.array(OnlineLyricsProviderSchema).max(ONLINE_LYRICS_PROVIDERS.length).optional(),
  })
  .refine((v) => v.online !== undefined || v.providers !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateLyricsSettingsRequest = z.infer<typeof UpdateLyricsSettingsRequestSchema>;
