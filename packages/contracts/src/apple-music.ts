import { z } from 'zod';

/**
 * Apple Music through HQPlayer.
 *
 * Apple Music subscription tracks are copy-protected: HQPlayer cannot open them as files and
 * Studio never tries to. What Studio can do is switch HQPlayer to a *live input* — an `audio:`
 * playlist entry fed by a virtual audio cable that the Apple Music app plays into — and show
 * what Apple Music reports to Windows (title, artist, album, cover) while it plays. Music is
 * still chosen in the Apple Music app itself.
 */

/** An HQPlayer live-input URI, e.g. `audio:default/0/2` (device / rate, 0 = detect / channels). */
export const LiveInputUriSchema = z
  .string()
  .max(200)
  .regex(/^audio:\S.*$/i, 'A live input starts with "audio:"');

export const isLiveInputUri = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^audio:\S/i.test(value);

/** `artworkId` of the cover Apple Music publishes; the number changes with the cover. */
export const LIVE_ARTWORK_ID = /^live-apple-music-\d+$/;
export const liveArtworkId = (version: number): string => `live-apple-music-${version}`;

/**
 * Track id under which the lyrics API serves the song a live source is playing
 * (`/tracks/live-apple-music/lyrics`). Those lyrics are looked up by title and artist and kept
 * in memory only.
 */
export const LIVE_LYRICS_TRACK_ID = 'live-apple-music';

/** A song the live source played since it was started (kept in memory, newest last). */
export const LivePlayedSongSchema = z.object({
  title: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  startedAt: z.number(),
});
export type LivePlayedSong = z.infer<typeof LivePlayedSongSchema>;

/** What another app tells Windows it is playing (Windows media session). */
export const LiveNowPlayingSchema = z.object({
  /** Windows app id of the session, e.g. `AppleInc.AppleMusicWin_…!App`. */
  app: z.string(),
  playback: z.enum(['playing', 'paused', 'stopped', 'other']),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  hasArtwork: z.boolean(),
  /** Increments whenever the published cover changes (cache key for the artwork URL). */
  artworkVersion: z.number().int().nonnegative(),
  /** Position in the app as of `positionAt` (epoch ms); null when the app publishes no timeline. */
  positionMs: z.number().nonnegative().nullable(),
  positionAt: z.number().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  controls: z.object({
    play: z.boolean(),
    pause: z.boolean(),
    next: z.boolean(),
    previous: z.boolean(),
  }),
});
export type LiveNowPlaying = z.infer<typeof LiveNowPlayingSchema>;

/**
 * One line of the set-up check.
 * `ok`      found / in place
 * `missing` not found — the page says what to do and offers a button where one exists
 * `unknown` Studio could not tell (the check itself failed; `detail` carries the reason)
 * `manual`  Studio cannot see this from outside; the user confirms it by listening
 */
export const AppleMusicCheckIdSchema = z.enum([
  'windows',
  'engine',
  'appleMusicApp',
  'virtualCable',
  'cableFormat',
  'microphoneAccess',
  'appRouting',
  'hqplayerInput',
]);
export type AppleMusicCheckId = z.infer<typeof AppleMusicCheckIdSchema>;

export const AppleMusicCheckSchema = z.object({
  id: AppleMusicCheckIdSchema,
  status: z.enum(['ok', 'missing', 'unknown', 'manual']),
  /** Facts for the line: device names, what HQPlayer lists, or why the check failed. */
  detail: z.string().nullable(),
});
export type AppleMusicCheck = z.infer<typeof AppleMusicCheckSchema>;

export const AppleMusicSetupSchema = z.object({
  checkedAt: z.number(),
  checks: z.array(AppleMusicCheckSchema),
  /** Live inputs HQPlayer itself lists (`GetInputs`), if any. */
  listedInputs: z.array(z.string()),
});
export type AppleMusicSetup = z.infer<typeof AppleMusicSetupSchema>;

/** One live-input URI Studio tried when starting, and how far HQPlayer got with it. */
export const LiveInputAttemptSchema = z.object({
  uri: z.string(),
  addAccepted: z.boolean(),
  playAccepted: z.boolean().nullable(),
  reachedPlaying: z.boolean().nullable(),
  /** HQPlayer's own words when it refused. */
  error: z.string().nullable(),
});
export type LiveInputAttempt = z.infer<typeof LiveInputAttemptSchema>;

/** Why "Start" is not available right now (clients translate; null = it is available). */
export const AppleMusicBlockSchema = z.enum([
  'disabled',
  'engine_offline',
  'control_disabled',
  'not_supported',
  'busy',
]);
export type AppleMusicBlock = z.infer<typeof AppleMusicBlockSchema>;

/** Windows' default playback device per role (endpoint ids; null = none / not read). */
export const SoundDefaultsSchema = z.object({
  /** "Default Device": system sounds and most apps. */
  console: z.string().nullable(),
  multimedia: z.string().nullable(),
  /** "Default Communication Device": calls and chat apps. */
  communications: z.string().nullable(),
});
export type SoundDefaults = z.infer<typeof SoundDefaultsSchema>;

/**
 * Keeping other apps' sounds away from the DAC and the cable.
 *
 * HQPlayer drives the DAC through ASIO; when the DAC (or the virtual cable) is also Windows'
 * default output, a message sound from another app collides with the music. Studio can switch
 * Windows' default output to an "everyday" output the user picks — by button, or by itself
 * when the live input starts — and put the previous one back afterwards.
 */
export const SoundGuardSchema = z.object({
  /** Windows' sound outputs can be read and switched on this computer. */
  supported: z.boolean(),
  /** Switch when the live input starts and put Windows back when it ends. */
  auto: z.boolean(),
  /** The everyday output the user picked (endpoint id); null = not chosen yet. */
  outputId: z.string().nullable(),
  /** Windows' active playback outputs; null = not read yet. `cable` = looks like a virtual cable. */
  outputs: z.array(z.object({ id: z.string(), name: z.string(), cable: z.boolean() })).nullable(),
  /** Which output is Windows' default right now; null = not read yet. */
  defaults: SoundDefaultsSchema.nullable(),
  /** What Studio replaced and will put back (null = Studio changed nothing). */
  held: z.object({ at: z.number(), previous: SoundDefaultsSchema }).nullable(),
  /** The last read or switch failed (Windows' own words). */
  error: z.string().nullable(),
});
export type SoundGuard = z.infer<typeof SoundGuardSchema>;

export const UpdateSoundGuardRequestSchema = z
  .object({
    auto: z.boolean().optional(),
    outputId: z.string().max(120).nullable().optional(),
  })
  .refine((v) => v.auto !== undefined || v.outputId !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateSoundGuardRequest = z.infer<typeof UpdateSoundGuardRequestSchema>;

export function idleSoundGuard(): SoundGuard {
  return {
    supported: false,
    auto: false,
    outputId: null,
    outputs: null,
    defaults: null,
    held: null,
    error: null,
  };
}

export const AppleMusicStateSchema = z.object({
  /** Windows media sessions are available on this computer (false on macOS / Linux). */
  supported: z.boolean(),
  /** Demo data from the mock engine — not evidence of anything on a real HQPlayer. */
  simulated: z.boolean(),
  /** The user's switch on the Apple Music page (default off). */
  enabled: z.boolean(),
  /**
   * `idle`     HQPlayer plays the library (or nothing)
   * `starting` Studio is switching HQPlayer to the live input
   * `active`   the live input is HQPlayer's playlist
   * `stopping` Studio is putting the library queue back
   */
  phase: z.enum(['idle', 'starting', 'active', 'stopping']),
  /** The live input in use, or the one that worked last time. */
  liveUri: z.string().nullable(),
  /** The user's own choice of live input, tried before the built-in ones. */
  preferredUri: z.string().nullable(),
  nowPlaying: LiveNowPlayingSchema.nullable(),
  /** The Windows query itself failed (shown on the page; never hidden). */
  mediaError: z.string().nullable(),
  blocked: AppleMusicBlockSchema.nullable(),
  lastStart: z
    .object({
      at: z.number(),
      ok: z.boolean(),
      attempts: z.array(LiveInputAttemptSchema),
      error: z.string().nullable(),
    })
    .nullable(),
  setup: AppleMusicSetupSchema.nullable(),
  /** Where the cover on screen comes from, and why there is none when there is none. */
  artwork: z.object({
    /** `windows` = what Apple Music published; `online` = looked up at a cover source. */
    source: z.enum(['windows', 'online']).nullable(),
    /** Windows published a cover but would not hand it over (the reason, as text). */
    error: z.string().nullable(),
    /** Online covers are switched on (Settings), so a missing cover is looked up. */
    onlineEnabled: z.boolean(),
  }),
  /**
   * Songs played since Start, the current one last. Apple Music's own "Playing Next" list cannot
   * be read from outside the app, so this is what Studio can show instead of a queue.
   */
  history: z.array(LivePlayedSongSchema),
  /** Windows' default output and Studio's hold on it (see `SoundGuardSchema`). */
  guard: SoundGuardSchema,
});
export type AppleMusicState = z.infer<typeof AppleMusicStateSchema>;

export const UpdateAppleMusicSettingsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    preferredUri: LiveInputUriSchema.nullable().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.preferredUri !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateAppleMusicSettingsRequest = z.infer<typeof UpdateAppleMusicSettingsRequestSchema>;

export const AppleMusicControlRequestSchema = z.object({
  action: z.enum(['play', 'pause', 'toggle', 'next', 'previous']),
});
export type AppleMusicControlRequest = z.infer<typeof AppleMusicControlRequestSchema>;
export type AppleMusicControlAction = AppleMusicControlRequest['action'];

export function idleAppleMusicState(): AppleMusicState {
  return {
    supported: false,
    simulated: false,
    enabled: false,
    phase: 'idle',
    liveUri: null,
    preferredUri: null,
    nowPlaying: null,
    mediaError: null,
    blocked: 'disabled',
    lastStart: null,
    setup: null,
    artwork: { source: null, error: null, onlineEnabled: false },
    history: [],
    guard: idleSoundGuard(),
  };
}
