import { describe, expect, it } from 'vitest';
import {
  clamp,
  formatDuration,
  formatLongDuration,
  formatVolume,
  interpolatePosition,
  signalPathLabel,
} from './format';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(187_000)).toBe('3:07');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
  it('handles missing values', () => {
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(undefined)).toBe('--:--');
    expect(formatDuration(-5)).toBe('--:--');
    expect(formatDuration(Number.NaN)).toBe('--:--');
  });
});

describe('formatLongDuration', () => {
  it('localises totals', () => {
    expect(formatLongDuration(72 * 60_000, 'zh-CN')).toBe('1 小时 12 分钟');
    expect(formatLongDuration(72 * 60_000, 'en')).toBe('1 hr 12 min');
    expect(formatLongDuration(20_000, 'en')).toBe('1 min');
    expect(formatLongDuration(120 * 60_000, 'zh-CN')).toBe('2 小时');
  });
});

describe('formatVolume / signal path', () => {
  it('formats dB with sign', () => {
    expect(formatVolume(-12)).toBe('-12.0 dB');
    expect(formatVolume(1.5)).toBe('+1.5 dB');
    expect(formatVolume(null)).toBe('— dB');
  });
  it('joins input and output labels', () => {
    const out = {
      kind: 'DSD' as const,
      sampleRate: 22_579_200,
      bits: 1,
      channels: 2,
      label: 'DSD512',
    };
    expect(signalPathLabel('FLAC 24/96', out)).toBe('FLAC 24/96 → DSD512');
    expect(signalPathLabel(null, out)).toBe('DSD512');
    expect(signalPathLabel('FLAC 16/44.1', null)).toBe('FLAC 16/44.1');
    expect(signalPathLabel(null, null)).toBeNull();
  });
});

describe('interpolatePosition', () => {
  it('extrapolates only while playing and clamps to duration', () => {
    expect(interpolatePosition(10_000, 1_000, 3_500, true, 60_000)).toBe(12_500);
    expect(interpolatePosition(10_000, 1_000, 3_500, false, 60_000)).toBe(10_000);
    expect(interpolatePosition(59_000, 0, 10_000, true, 60_000)).toBe(60_000);
    expect(interpolatePosition(5_000, 2_000, 1_000, true, null)).toBe(5_000);
  });
  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(Number.NaN, 0, 3)).toBe(0);
  });
});
