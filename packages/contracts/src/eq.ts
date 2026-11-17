import { z } from 'zod';

/**
 * Studio EQ (D-041): Studio turns an EQ curve into an impulse-response WAV file that HQPlayer's
 * own convolution engine plays through. HQPlayer has no EQ commands; Studio never touches the
 * audio. The maths here is shared by Core (the file) and the UI (the curve it draws), so both
 * always describe the same filter.
 */

/** Rate of the impulse file. HQPlayer rescales a convolution filter to the source rate itself. */
export const EQ_SAMPLE_RATE = 176_400;
export const EQ_MAX_BANDS = 20;
export const EQ_MAX_PROFILES = 30;
export const EQ_MIN_FREQ = 10;
export const EQ_MAX_FREQ = 40_000;
/** Largest boost a band may ask for; the preamp makes room for it anyway. */
export const EQ_MAX_BOOST_DB = 15;
export const EQ_MIN_GAIN_DB = -30;

export const EqBandTypeSchema = z.enum(['peak', 'lowShelf', 'highShelf', 'lowPass', 'highPass']);
export type EqBandType = z.infer<typeof EqBandTypeSchema>;

export const EqBandSchema = z.object({
  type: EqBandTypeSchema,
  enabled: z.boolean(),
  /** Centre / corner frequency in Hz. */
  freq: z.number().min(EQ_MIN_FREQ).max(EQ_MAX_FREQ),
  /** dB; ignored by low-pass / high-pass. */
  gainDb: z.number().min(EQ_MIN_GAIN_DB).max(EQ_MAX_BOOST_DB),
  q: z.number().min(0.1).max(10),
});
export type EqBand = z.infer<typeof EqBandSchema>;

export const EqConfigSchema = z.object({
  bands: z.array(EqBandSchema).max(EQ_MAX_BANDS),
  /**
   * The user's preamp (≤ 0 dB). Studio lowers it further when the curve would boost above
   * 0 dB, so the filter can never push the signal into clipping (see `eqHeadroom`).
   */
  preampDb: z.number().min(-30).max(0),
});
export type EqConfig = z.infer<typeof EqConfigSchema>;

export const FLAT_EQ: EqConfig = { bands: [], preampDb: 0 };

export const EqProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  config: EqConfigSchema,
});
export type EqProfile = z.infer<typeof EqProfileSchema>;

/** What the in-Studio listening check found out about HQPlayer reloading the file. */
export const EqReloadCheckSchema = z.object({
  /**
   * `reloads`: turning convolution off and on makes HQPlayer use the rewritten file;
   * `no-reload`: it kept the old filter (changes need HQPlayer restarted);
   * `not-configured`: HQPlayer would not turn convolution on (no filter set up in HQPlayer).
   */
  result: z.enum(['reloads', 'no-reload', 'not-configured']),
  at: z.number(),
});
export type EqReloadCheck = z.infer<typeof EqReloadCheckSchema>;

export const EqFileInfoSchema = z.object({
  path: z.string(),
  writtenAt: z.number(),
  sampleRate: z.number().int(),
  taps: z.number().int(),
  /** Preamp actually written into the file (dB). */
  preampDb: z.number(),
  /** Loudest point of the curve after the preamp (≤ 0). */
  peakDb: z.number(),
  /** Energy left after the end of the file, dB below the impulse (lower is better). */
  tailDb: z.number(),
});
export type EqFileInfo = z.infer<typeof EqFileInfoSchema>;

export const EqStatusSchema = z.object({
  config: EqConfigSchema,
  profiles: z.array(EqProfileSchema),
  /** The file Studio writes (also when it has not been written yet). */
  filePath: z.string().nullable(),
  file: EqFileInfoSchema.nullable(),
  /** HQPlayer's convolution switch as State reports it (null: unknown / not connected). */
  convolution: z.boolean().nullable(),
  /** Studio may switch convolution (live engine, both control switches on). */
  canSwitch: z.boolean(),
  /** HQPlayer runs on another computer: it must be able to open `filePath` itself. */
  hqplayerRemote: z.boolean(),
  reloadCheck: EqReloadCheckSchema.nullable(),
  /** A listening check is waiting for the user's answer. */
  checkRunning: z.boolean(),
});
export type EqStatus = z.infer<typeof EqStatusSchema>;

export const SaveEqRequestSchema = z.object({ config: EqConfigSchema });
export const EqConvolutionRequestSchema = z.object({ enabled: z.boolean() });
export const CreateEqProfileRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  config: EqConfigSchema,
});
export const EqCheckAnswerSchema = z.object({ heard: z.boolean() });

/** Result of starting the listening check. */
export const EqCheckStartSchema = z.object({
  /** The test filter is in place and convolution is on: ask the user what they hear. */
  started: z.boolean(),
  status: EqStatusSchema,
});
export type EqCheckStart = z.infer<typeof EqCheckStartSchema>;

// --- filter maths -------------------------------------------------------------------------------

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ “Audio EQ Cookbook” biquad, normalised to a0 = 1. */
export function biquadFor(band: EqBand, fs: number = EQ_SAMPLE_RATE): Biquad {
  const f = Math.min(band.freq, fs * 0.49);
  const w0 = (2 * Math.PI * f) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * band.q);
  const A = 10 ** (band.gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (band.type) {
    case 'peak':
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case 'lowShelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highShelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
    case 'lowPass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highPass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadDb(c: Biquad, freq: number, fs: number): number {
  const w = (2 * Math.PI * freq) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) || 1e-30);
}

const activeBands = (config: EqConfig) =>
  config.bands.filter(
    (b) => b.enabled && (b.type === 'lowPass' || b.type === 'highPass' || b.gainDb !== 0),
  );

/** The curve without the preamp, in dB, at each frequency. */
export function eqCurveDb(
  config: EqConfig,
  freqs: readonly number[],
  fs: number = EQ_SAMPLE_RATE,
): number[] {
  const coeffs = activeBands(config).map((b) => biquadFor(b, fs));
  return freqs.map((f) => coeffs.reduce((sum, c) => sum + biquadDb(c, f, fs), 0));
}

/** `count` frequencies spaced evenly on a log scale. */
export function logFrequencies(count: number, from = 10, to = 24_000): number[] {
  const out: number[] = [];
  const ratio = Math.log(to / from);
  for (let i = 0; i < count; i += 1) out.push(from * Math.exp((ratio * i) / (count - 1)));
  return out;
}

/**
 * The clipping guard: the preamp written into the file is the user's preamp, lowered further
 * when the curve's loudest point would end up above 0 dB.
 */
export function eqHeadroom(
  config: EqConfig,
  fs: number = EQ_SAMPLE_RATE,
): { curvePeakDb: number; preampDb: number; autoLowered: boolean } {
  const freqs = logFrequencies(1200, EQ_MIN_FREQ, fs * 0.49);
  for (const b of activeBands(config)) freqs.push(Math.min(b.freq, fs * 0.49));
  const curvePeakDb = Math.max(0, ...eqCurveDb(config, freqs, fs));
  // a little margin for the peak falling between grid points
  const needed = curvePeakDb > 0 ? -(Math.ceil((curvePeakDb + 0.05) * 10) / 10) : 0;
  const preampDb = Math.min(config.preampDb, needed);
  return { curvePeakDb, preampDb, autoLowered: preampDb < config.preampDb };
}

/** Is the curve flat (no band changes anything)? */
export function isFlatEq(config: EqConfig): boolean {
  return activeBands(config).length === 0 && config.preampDb === 0;
}

// --- AutoEQ / Equalizer APO text ----------------------------------------------------------------

const TYPE_CODES: Record<string, EqBandType> = {
  PK: 'peak',
  PEQ: 'peak',
  LS: 'lowShelf',
  LSC: 'lowShelf',
  LSQ: 'lowShelf',
  HS: 'highShelf',
  HSC: 'highShelf',
  HSQ: 'highShelf',
  LP: 'lowPass',
  LPQ: 'lowPass',
  HP: 'highPass',
  HPQ: 'highPass',
};

/**
 * Read a “ParametricEQ.txt” as AutoEQ and Equalizer APO write it:
 * `Preamp: -6.2 dB` and `Filter 1: ON PK Fc 105 Hz Gain -2.4 dB Q 0.70`.
 * Lines Studio cannot use are listed in `skipped` instead of being guessed.
 */
export function parseParametricEq(text: string): {
  config: EqConfig;
  skipped: string[];
} {
  const bands: EqBand[] = [];
  const skipped: string[] = [];
  let preampDb = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const pre = /^preamp\s*:\s*(-?\d+(?:\.\d+)?)\s*db/i.exec(line);
    if (pre) {
      preampDb = Math.max(-30, Math.min(0, Number(pre[1])));
      continue;
    }
    const m =
      /^filter(?:\s*\d+)?\s*:\s*(on|off)\s+([a-z]+)\s+fc\s+(\d+(?:\.\d+)?)\s*hz(?:\s+gain\s+(-?\d+(?:\.\d+)?)\s*db)?(?:\s+q\s+(\d+(?:\.\d+)?))?/i.exec(
        line,
      );
    const type = m ? TYPE_CODES[m[2]!.toUpperCase()] : undefined;
    if (!m || !type) {
      skipped.push(line);
      continue;
    }
    if (bands.length >= EQ_MAX_BANDS) {
      skipped.push(line);
      continue;
    }
    const parsed = EqBandSchema.safeParse({
      type,
      enabled: m[1]!.toLowerCase() === 'on',
      freq: Number(m[3]),
      gainDb: m[4] !== undefined ? Number(m[4]) : 0,
      q: m[5] !== undefined ? Number(m[5]) : 0.707,
    });
    if (parsed.success) bands.push(parsed.data);
    else skipped.push(line);
  }
  return { config: { bands, preampDb }, skipped };
}

/** The same format back, so a curve can be copied into other tools. */
export function formatParametricEq(config: EqConfig): string {
  const code: Record<EqBandType, string> = {
    peak: 'PK',
    lowShelf: 'LSC',
    highShelf: 'HSC',
    lowPass: 'LPQ',
    highPass: 'HPQ',
  };
  const lines = [`Preamp: ${config.preampDb.toFixed(1)} dB`];
  config.bands.forEach((b, i) => {
    lines.push(
      `Filter ${i + 1}: ${b.enabled ? 'ON' : 'OFF'} ${code[b.type]} Fc ${round(b.freq, 1)} Hz Gain ${b.gainDb.toFixed(1)} dB Q ${b.q.toFixed(2)}`,
    );
  });
  return lines.join('\n');
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** Starting points offered on the EQ page (the user's own curves are saved as profiles). */
export const EQ_BUILTIN_PRESETS: Array<{ id: string; config: EqConfig }> = [
  { id: 'flat', config: FLAT_EQ },
  {
    id: 'bass',
    config: {
      preampDb: 0,
      bands: [{ type: 'lowShelf', enabled: true, freq: 105, gainDb: 4, q: 0.7 }],
    },
  },
  {
    id: 'warm',
    config: {
      preampDb: 0,
      bands: [
        { type: 'lowShelf', enabled: true, freq: 150, gainDb: 2, q: 0.7 },
        { type: 'highShelf', enabled: true, freq: 6000, gainDb: -2.5, q: 0.7 },
      ],
    },
  },
  {
    id: 'loudness',
    config: {
      preampDb: 0,
      bands: [
        { type: 'lowShelf', enabled: true, freq: 90, gainDb: 5, q: 0.7 },
        { type: 'highShelf', enabled: true, freq: 9000, gainDb: 3, q: 0.7 },
      ],
    },
  },
  {
    id: 'vocal',
    config: {
      preampDb: 0,
      bands: [
        { type: 'peak', enabled: true, freq: 250, gainDb: -1.5, q: 1 },
        { type: 'peak', enabled: true, freq: 2500, gainDb: 2, q: 0.9 },
      ],
    },
  },
];
