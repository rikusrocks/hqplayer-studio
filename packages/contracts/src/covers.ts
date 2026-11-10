import { z } from 'zod';

/**
 * Online cover sources, in the order they are tried. Each is a separate third party:
 * `itunes` = Apple's iTunes Search API, `deezer` = the Deezer API, `musicbrainz` = MusicBrainz
 * release search + the Cover Art Archive.
 */
export const COVER_PROVIDERS = ['itunes', 'deezer', 'musicbrainz'] as const;
export const CoverProviderSchema = z.enum(COVER_PROVIDERS);
export type CoverProviderId = z.infer<typeof CoverProviderSchema>;

/** One album found by a cover source, offered for manual matching (desktop only). */
export const CoverCandidateSchema = z.object({
  provider: CoverProviderSchema,
  /** Opaque reference: send it back with `provider` to preview or use this cover. */
  ref: z.string().min(1).max(400),
  title: z.string(),
  artist: z.string(),
  year: z.number().int().nullable(),
  trackCount: z.number().int().nullable(),
});
export type CoverCandidate = z.infer<typeof CoverCandidateSchema>;

export const CoverSearchQuerySchema = z.object({ q: z.string().trim().max(200).optional() });

export const CoverRefSchema = z.object({
  provider: CoverProviderSchema,
  ref: z.string().min(1).max(400),
});
export type CoverRef = z.infer<typeof CoverRefSchema>;

/**
 * An album's cover after a change. `origin`: `local` = image file in the album folder or a
 * picture in the tags, `online` = fetched from a cover source, null = no cover.
 */
export const AlbumCoverSchema = z.object({
  albumId: z.string(),
  artworkId: z.string().nullable(),
  origin: z.enum(['local', 'online']).nullable(),
});
export type AlbumCover = z.infer<typeof AlbumCoverSchema>;

export const CoverSettingsSchema = z.object({
  /**
   * Look for missing covers online (sends album title + album artist). Default off. When on,
   * Studio looks up the album that is playing if it has no cover; everything else is manual.
   */
  online: z.boolean(),
  /** Every known source in the order it is tried; only enabled ones are ever contacted. */
  providers: z.array(
    z.object({
      id: CoverProviderSchema,
      enabled: z.boolean(),
      /** ms until this source may be asked again (after 429/outage), else 0. */
      pausedForMs: z.number().int(),
    }),
  ),
  /** Albums in the library that have no cover at all. */
  missing: z.number().int(),
  /** "Find covers for all albums without one" — a background job the user starts by hand. */
  fill: z.object({
    running: z.boolean(),
    done: z.number().int(),
    total: z.number().int(),
    found: z.number().int(),
    finishedAt: z.number().nullable(),
  }),
});
export type CoverSettings = z.infer<typeof CoverSettingsSchema>;

export const UpdateCoverSettingsRequestSchema = z
  .object({
    online: z.boolean().optional(),
    /** The sources to use (the order is fixed; duplicates are ignored). */
    providers: z.array(CoverProviderSchema).max(COVER_PROVIDERS.length).optional(),
  })
  .refine((v) => v.online !== undefined || v.providers !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateCoverSettingsRequest = z.infer<typeof UpdateCoverSettingsRequestSchema>;
