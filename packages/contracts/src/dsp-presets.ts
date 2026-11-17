import { z } from 'zod';

/**
 * A named set of DSP selections. Stored by **name** (rates in Hz), not by list position, so a
 * preset still means the same filter after HQPlayer's lists change order; when an item no
 * longer exists the preset is refused instead of guessing.
 */
export const DspPresetValuesSchema = z.object({
  mode: z.string().nullable(),
  filter1x: z.string().nullable(),
  filterNx: z.string().nullable(),
  /** Modulator (SDM) or noise shaping (PCM), by name. */
  shaper: z.string().nullable(),
  /** Output rate in Hz; 0 = automatic. */
  rate: z.number().int().nonnegative().nullable(),
  invert: z.boolean().nullable(),
  adaptiveVolume: z.boolean().nullable(),
});
export type DspPresetValues = z.infer<typeof DspPresetValuesSchema>;

export const DspPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  values: DspPresetValuesSchema,
});
export type DspPreset = z.infer<typeof DspPresetSchema>;

export const DspPresetListSchema = z.object({ presets: z.array(DspPresetSchema) });
export type DspPresetList = z.infer<typeof DspPresetListSchema>;

export const CreateDspPresetRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type CreateDspPresetRequest = z.infer<typeof CreateDspPresetRequestSchema>;

export const MAX_DSP_PRESETS = 20;
