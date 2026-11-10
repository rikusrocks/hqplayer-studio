import { describe, expect, it } from 'vitest';
import { activeLineIndex, parseLrc } from './lrc';

// Fictional lyric lines written for tests (no copyrighted lyrics in the repository).
const SAMPLE = `\uFEFF[ti:城市漫游者]
[ar:林夏]
[offset:+200]
[00:01.00]第一行 — the first line
[00:05.50][00:20.25]夜の終わりに、ひかりを
[00:10.123]<00:10.123>Word <00:11.000>timed
[00:15]English line
not a lyric line`;

describe('parseLrc', () => {
  it('parses metadata, multi-timestamps, fractional formats and word tags', () => {
    const p = parseLrc(SAMPLE);
    expect(p.kind).toBe('synced');
    expect(p.meta).toMatchObject({ title: '城市漫游者', artist: '林夏', offsetMs: 200 });
    expect(p.lines.map((l) => l.timeMs)).toEqual([800, 5300, 9923, 14800, 20050]);
    expect(p.lines[1]?.text).toBe('夜の終わりに、ひかりを');
    expect(p.lines[4]?.text).toBe('夜の終わりに、ひかりを');
    expect(p.lines[2]?.text).toBe('Word timed');
    expect(p.plain).toEqual(['not a lyric line']);
  });

  it('treats text without timestamps as plain lyrics', () => {
    const p = parseLrc('line one\r\nline two\n\n');
    expect(p.kind).toBe('plain');
    expect(p.plain).toEqual(['line one', 'line two']);
  });

  it('supports mm:ss:xx separators', () => {
    expect(parseLrc('[01:02:50]x').lines[0]?.timeMs).toBe(62_500);
  });
});

describe('activeLineIndex', () => {
  const { lines } = parseLrc('[00:01.00]a\n[00:03.00]b\n[00:06.00]c');
  it('finds the active line with binary search', () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 1000)).toBe(0);
    expect(activeLineIndex(lines, 5999)).toBe(1);
    expect(activeLineIndex(lines, 60_000)).toBe(2);
  });
  it('applies the user calibration offset (positive = lyrics later)', () => {
    expect(activeLineIndex(lines, 3500, 1000)).toBe(0);
    expect(activeLineIndex(lines, 2500, -1000)).toBe(1);
  });
});
