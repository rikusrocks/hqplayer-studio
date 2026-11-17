import {
  EQ_SAMPLE_RATE,
  eqCurveDb,
  eqHeadroom,
  formatParametricEq,
  parseParametricEq,
  type EqConfig,
} from '@hqps/contracts';
import { describe, expect, it } from 'vitest';
import { EQ_CHECK_CONFIG, buildEqImpulse, encodeFloatWav } from './eq-filter';

/** Magnitude (dB) of an impulse at one frequency, by direct DFT. */
function responseDb(samples: Float32Array, fs: number, freq: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / fs;
  for (let n = 0; n < samples.length; n += 1) {
    re += samples[n]! * Math.cos(w * n);
    im -= samples[n]! * Math.sin(w * n);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

const BASS: EqConfig = {
  preampDb: 0,
  bands: [
    { type: 'peak', enabled: true, freq: 1000, gainDb: -6, q: 1.4 },
    { type: 'lowShelf', enabled: true, freq: 100, gainDb: 4, q: 0.7 },
  ],
};

describe('EQ curve maths (shared with the UI)', () => {
  it('gives the requested gain at a peak band centre and nothing far away', () => {
    const [atCentre, far] = eqCurveDb(
      { preampDb: 0, bands: [{ type: 'peak', enabled: true, freq: 1000, gainDb: -6, q: 1 }] },
      [1000, 15000],
    );
    expect(atCentre).toBeCloseTo(-6, 2);
    expect(Math.abs(far!)).toBeLessThan(0.1);
  });

  it('ignores switched-off bands', () => {
    const [db] = eqCurveDb(
      { preampDb: 0, bands: [{ type: 'peak', enabled: false, freq: 1000, gainDb: 6, q: 1 }] },
      [1000],
    );
    expect(db).toBeCloseTo(0, 6);
  });

  it('lowers the preamp so a boost can never clip', () => {
    const h = eqHeadroom(BASS);
    expect(h.curvePeakDb).toBeGreaterThan(3.9);
    expect(h.preampDb).toBeLessThanOrEqual(-h.curvePeakDb);
    expect(h.autoLowered).toBe(true);
    // a quieter user preamp is kept
    expect(eqHeadroom({ ...BASS, preampDb: -8 }).preampDb).toBe(-8);
    // a cut-only curve needs no headroom
    expect(eqHeadroom({ preampDb: 0, bands: [BASS.bands[0]!] }).preampDb).toBe(0);
  });
});

describe('EQ impulse file', () => {
  it('measures like the curve, with the preamp, never above 0 dB', () => {
    const imp = buildEqImpulse(BASS);
    expect(imp.sampleRate).toBe(EQ_SAMPLE_RATE);
    expect(imp.peakDb).toBeLessThanOrEqual(0);
    expect(imp.tailDb).toBeLessThan(-90);
    for (const f of [30, 100, 1000, 5000]) {
      const want = eqCurveDb(BASS, [f])[0]! + imp.preampDb;
      expect(responseDb(imp.samples, imp.sampleRate, f)).toBeCloseTo(want, 1);
    }
  });

  it('is a plain (attenuated) impulse for a flat curve', () => {
    const imp = buildEqImpulse({ preampDb: -3, bands: [] });
    expect(imp.taps).toBe(4096);
    expect(imp.samples[0]).toBeCloseTo(10 ** (-3 / 20), 6);
    expect(imp.samples.slice(1).every((v) => v === 0)).toBe(true);
  });

  it('makes a long enough file for a narrow low band', () => {
    const imp = buildEqImpulse({
      preampDb: 0,
      bands: [{ type: 'peak', enabled: true, freq: 25, gainDb: -8, q: 6 }],
    });
    expect(imp.taps).toBeGreaterThan(65_536);
    expect(imp.tailDb).toBeLessThan(-60);
    expect(responseDb(imp.samples, imp.sampleRate, 25)).toBeCloseTo(-8, 0);
  });

  it('check filter only ever lowers the level', () => {
    const imp = buildEqImpulse(EQ_CHECK_CONFIG);
    expect(imp.preampDb).toBe(0);
    expect(responseDb(imp.samples, imp.sampleRate, 100)).toBeLessThan(0.1);
    expect(responseDb(imp.samples, imp.sampleRate, 5000)).toBeLessThan(-30);
  });

  it('writes a valid mono IEEE-float WAV', () => {
    const imp = buildEqImpulse(BASS);
    const wav = encodeFloatWav(imp.samples, imp.sampleRate);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(3);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(EQ_SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(32);
    const dataAt = wav.indexOf('data', 36, 'ascii');
    expect(wav.readUInt32LE(dataAt + 4)).toBe(imp.taps * 4);
    expect(wav.readFloatLE(dataAt + 8)).toBeCloseTo(imp.samples[0]!, 6);
  });
});

describe('AutoEQ / Equalizer APO text', () => {
  it('reads a ParametricEQ.txt', () => {
    const { config, skipped } = parseParametricEq(
      [
        'Preamp: -6.4 dB',
        'Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70',
        'Filter 2: ON PK Fc 2771 Hz Gain -3.2 dB Q 2.15',
        'Filter 3: OFF HSC Fc 10000 Hz Gain -1.0 dB Q 0.70',
        'Filter 4: ON XYZ Fc 10 Hz Gain 1 dB Q 1',
      ].join('\n'),
    );
    expect(config.preampDb).toBe(-6.4);
    expect(config.bands).toEqual([
      { type: 'lowShelf', enabled: true, freq: 105, gainDb: 6.5, q: 0.7 },
      { type: 'peak', enabled: true, freq: 2771, gainDb: -3.2, q: 2.15 },
      { type: 'highShelf', enabled: false, freq: 10000, gainDb: -1, q: 0.7 },
    ]);
    expect(skipped).toHaveLength(1);
  });

  it('round-trips through the text format', () => {
    expect(parseParametricEq(formatParametricEq(BASS)).config).toEqual(BASS);
  });
});
