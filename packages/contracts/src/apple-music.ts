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
  };
}
