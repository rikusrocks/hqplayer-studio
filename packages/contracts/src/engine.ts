import { z } from 'zod';

export const ConnectionStateSchema = z.enum(['connected', 'connecting', 'disconnected', 'error']);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const TransportStateSchema = z.enum(['playing', 'paused', 'stopped', 'stopping', 'unknown']);
export type TransportState = z.infer<typeof TransportStateSchema>;

export const AudioFormatSchema = z.object({
  kind: z.enum(['PCM', 'DSD']),
  /** Hz. For DSD this is the 1-bit rate, e.g. 2822400 for DSD64. */
  sampleRate: z.number().int().nonnegative().nullable(),
  bits: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  /** Display label, e.g. "PCM 96 kHz / 24-bit" or "DSD512". */
  label: z.string(),
});
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const DspSummarySchema = z.object({
  mode: z.string().nullable(),
  filter: z.string().nullable(),
  shaper: z.string().nullable(),
  /** Output rate in Hz, when reported. */
  outputRate: z.number().nullable(),
});
export type DspSummary = z.infer<typeof DspSummarySchema>;

export const EngineTrackSchema = z.object({
  /** Engine-side playlist index of the track, if reported. */
  index: z.number().int().nullable(),
  /** URI or native path as reported by the engine (may be absent). */
  uri: z.string().nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  /** Studio track id when the engine track could be matched to the library. */
  studioTrackId: z.string().nullable(),
});
export type EngineTrack = z.infer<typeof EngineTrackSchema>;

export const RepeatModeSchema = z.enum(['none', 'single', 'all']);
export type RepeatMode = z.infer<typeof RepeatModeSchema>;

/**
 * The engine's *reported* playback state. HQPlayer is the authority for everything here;
 * Studio never fabricates these values from button clicks (no optimistic transport state).
 */
export const EngineStatusSchema = z.object({
  connection: ConnectionStateSchema,
  transport: TransportStateSchema,
  positionMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative().nullable(),
  track: EngineTrackSchema.nullable(),
  trackIndex: z.number().int().nullable(),
  trackCount: z.number().int().nullable(),
  volumeDb: z.number().nullable(),
  volumeRange: z.object({ min: z.number(), max: z.number() }).nullable(),
  input: AudioFormatSchema.nullable(),
  output: AudioFormatSchema.nullable(),
  dsp: DspSummarySchema.nullable(),
  repeat: RepeatModeSchema.nullable(),
  random: z.boolean().nullable(),
  albumMode: z.boolean().nullable(),
  /** Epoch ms when the engine last reported this state. */
  observedAt: z.number(),
  /** Increments every time Studio publishes a new status. */
  serial: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const DspOptionSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  value: z.number().int().nullable(),
});
export type DspOption = z.infer<typeof DspOptionSchema>;

export const DspStateSchema = z.object({
  modes: z.array(DspOptionSchema),
  filters: z.array(DspOptionSchema),
  shapers: z.array(DspOptionSchema),
  rates: z.array(z.object({ index: z.number().int(), rate: z.number().int() })),
  current: z.object({
    mode: z.string().nullable(),
    filter: z.string().nullable(),
    shaper: z.string().nullable(),
    rate: z.number().nullable(),
  }),
  writable: z.boolean(),
});
export type DspState = z.infer<typeof DspStateSchema>;

export function disconnectedStatus(serial = 0, lastError: string | null = null): EngineStatus {
  return {
    connection: 'disconnected',
    transport: 'unknown',
    positionMs: 0,
    durationMs: null,
    track: null,
    trackIndex: null,
    trackCount: null,
    volumeDb: null,
    volumeRange: null,
    input: null,
    output: null,
    dsp: null,
    repeat: null,
    random: null,
    albumMode: null,
    observedAt: Date.now(),
    serial,
    lastError,
  };
}

const DSD_BASE_44K = 2_822_400;
const DSD_BASE_48K = 3_072_000;

/** Human label for a sample format, e.g. "DSD512", "PCM 44.1 kHz / 16-bit". */
export function formatLabel(
  kind: 'PCM' | 'DSD',
  sampleRate: number | null,
  bits: number | null,
): string {
  if (kind === 'DSD') {
    if (!sampleRate) return 'DSD';
    for (const base of [DSD_BASE_44K, DSD_BASE_48K]) {
      const ratio = sampleRate / base;
      if (Number.isInteger(ratio) && ratio >= 1) {
        return `DSD${64 * ratio}${base === DSD_BASE_48K ? ' (48k)' : ''}`;
      }
    }
    return `DSD ${(sampleRate / 1_000_000).toFixed(2)} MHz`;
  }
  if (!sampleRate) return 'PCM';
  const khz = sampleRate / 1000;
  const rate = Number.isInteger(khz) ? `${khz}` : khz.toFixed(1);
  return bits ? `PCM ${rate} kHz / ${bits}-bit` : `PCM ${rate} kHz`;
}
