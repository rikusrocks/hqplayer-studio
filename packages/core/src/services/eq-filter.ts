import { EQ_SAMPLE_RATE, biquadFor, eqHeadroom, type Biquad, type EqConfig } from '@hqps/contracts';

/** Shortest and longest impulse Studio writes (2^12 … 2^19 samples ≈ 23 ms … 3 s at 176.4 kHz). */
const MIN_TAPS = 4096;
const MAX_TAPS = 524_288;
/** The impulse is long enough for every band to ring down to this level (−100 dB). */
const DECAY_TO = 1e-5;

export interface EqImpulse {
  samples: Float32Array;
  sampleRate: number;
  taps: number;
  preampDb: number;
  /** Loudest point of the curve including the preamp (≤ 0 dB). */
  peakDb: number;
  /** Energy cut off by the end of the file, dB relative to the whole impulse. */
  tailDb: number;
}

/** Largest pole radius of a biquad: how slowly its impulse response dies away. */
function poleRadius(c: Biquad): number {
  const disc = c.a1 * c.a1 - 4 * c.a2;
  if (disc < 0) return Math.sqrt(Math.max(0, c.a2));
  const r = Math.sqrt(disc);
  return Math.max(Math.abs((-c.a1 + r) / 2), Math.abs((-c.a1 - r) / 2));
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * The EQ as a minimum-phase FIR: the impulse response of the band biquads in series (exactly the
 * phase an analogue-style parametric EQ has, no pre-ringing, no added latency), scaled by the
 * preamp. Long enough for the slowest band to decay; a short fade at the very end hides the cut.
 */
export function buildEqImpulse(config: EqConfig, fs: number = EQ_SAMPLE_RATE): EqImpulse {
  const { preampDb, curvePeakDb } = eqHeadroom(config, fs);
  const bands = config.bands
    .filter((b) => b.enabled && (b.type === 'lowPass' || b.type === 'highPass' || b.gainDb !== 0))
    .map((b) => biquadFor(b, fs));

  let needed = MIN_TAPS;
  for (const c of bands) {
    const r = poleRadius(c);
    if (r > 0 && r < 1) needed = Math.max(needed, (Math.log(DECAY_TO) / Math.log(r)) * 1.5);
  }
  const taps = Math.min(MAX_TAPS, Math.max(MIN_TAPS, nextPow2(Math.ceil(needed))));

  // run twice the length so the energy beyond the end can be measured
  const total = taps * 2;
  const buf = new Float64Array(total);
  buf[0] = 10 ** (preampDb / 20);
  for (const c of bands) {
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let n = 0; n < total; n += 1) {
      const x = buf[n]!;
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      buf[n] = y;
    }
  }
  let inside = 0;
  let beyond = 0;
  for (let n = 0; n < total; n += 1) {
    const e = buf[n]! * buf[n]!;
    if (n < taps) inside += e;
    else beyond += e;
  }
  const tailDb = beyond > 0 && inside > 0 ? 10 * Math.log10(beyond / inside) : -200;

  const samples = new Float32Array(taps);
  const fade = Math.max(64, Math.floor(taps / 32));
  for (let n = 0; n < taps; n += 1) {
    let v = buf[n]!;
    const k = n - (taps - fade);
    if (k > 0) v *= 0.5 * (1 + Math.cos((Math.PI * k) / fade));
    samples[n] = v;
  }
  return {
    samples,
    sampleRate: fs,
    taps,
    preampDb,
    peakDb: Math.round((curvePeakDb + preampDb) * 100) / 100,
    tailDb: Math.round(tailDb * 10) / 10,
  };
}

/** Mono 32-bit IEEE-float WAV (WAVE_FORMAT_IEEE_FLOAT with the `fact` chunk). */
export function encodeFloatWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 4;
  const buf = Buffer.alloc(12 + 26 + 12 + 8 + dataBytes);
  let o = 0;
  const str = (s: string) => {
    buf.write(s, o, 'ascii');
    o += 4;
  };
  const u32 = (v: number) => {
    buf.writeUInt32LE(v, o);
    o += 4;
  };
  const u16 = (v: number) => {
    buf.writeUInt16LE(v, o);
    o += 2;
  };
  str('RIFF');
  u32(buf.length - 8);
  str('WAVE');
  str('fmt ');
  u32(18);
  u16(3); // IEEE float
  u16(1); // mono
  u32(sampleRate);
  u32(sampleRate * 4);
  u16(4);
  u16(32);
  u16(0); // cbSize
  str('fact');
  u32(4);
  u32(samples.length);
  str('data');
  u32(dataBytes);
  for (let i = 0; i < samples.length; i += 1) {
    buf.writeFloatLE(samples[i]!, o);
    o += 4;
  }
  return buf;
}

/** The filter used by the listening check: a strong treble cut that only ever lowers the level. */
export const EQ_CHECK_CONFIG: EqConfig = {
  preampDb: 0,
  bands: [
    { type: 'lowPass', enabled: true, freq: 900, gainDb: 0, q: 0.707 },
    { type: 'lowPass', enabled: true, freq: 900, gainDb: 0, q: 0.707 },
  ],
};
