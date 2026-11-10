import { describe, expect, it } from 'vitest';
import { encodeLegacy } from '../testing/synthetic-audio';
import {
  decodeLegacy,
  detectLegacyEncoding,
  isLegacyCandidate,
  languageHint,
  legacyDecodingAvailable,
} from './legacy-encoding';
import { repairMojibake } from './metadata';

/** What a parser hands us when it reads legacy bytes as Latin-1. */
const asRead = (text: string, enc: 'gbk' | 'shift_jis') =>
  encodeLegacy(text, enc).toString('latin1');

function recover(fields: string[], hintFrom = ''): string[] {
  const enc = detectLegacyEncoding(fields, languageHint(hintFrom));
  return enc ? fields.map((f) => decodeLegacy(f, enc)) : fields;
}

describe('legacy GBK / Shift-JIS tag recovery', () => {
  it('is available in this runtime (full ICU)', () => {
    expect(legacyDecodingAvailable()).toBe(true);
  });

  it('recovers Simplified Chinese written as GBK', () => {
    const fields = ['南方的风', '林夏', '城市漫游者'].map((t) => asRead(t, 'gbk'));
    expect(recover(fields)).toEqual(['南方的风', '林夏', '城市漫游者']);
    expect(recover([asRead('午夜地铁 (Live)', 'gbk')])).toEqual(['午夜地铁 (Live)']);
  });

  it('recovers Japanese written as Shift-JIS', () => {
    const fields = ['秋の詩', '月見カルテット', '紅葉'].map((t) => asRead(t, 'shift_jis'));
    expect(recover(fields)).toEqual(['秋の詩', '月見カルテット', '紅葉']);
    expect(recover([asRead('初雪のワルツ', 'shift_jis')])).toEqual(['初雪のワルツ']);
  });

  it('uses the folder / file name as a tie-breaker for short kanji-only tags', () => {
    const shortJa = asRead('東京', 'shift_jis');
    expect(recover([shortJa], '東京事変 - 教育/01 東京.flac')).toEqual(['東京']);
    const shortZh = asRead('北京', 'gbk');
    expect(recover([shortZh], '许巍 - 时光/01 北京.flac')).toEqual(['北京']);
  });

  it('leaves European Latin-1, UTF-8 and plain text alone', () => {
    for (const s of ['Café del Mar', 'Motörhead', 'Sigur Rós', 'Ångström', 'Björk – Jóga', 'ABC']) {
      expect(isLegacyCandidate(s), s).toBe(false);
      expect(recover([s]), s).toEqual([s]);
    }
    expect(isLegacyCandidate('南方的风')).toBe(false); // already real Unicode
    // UTF-8 read as Latin-1 is still handled by repairMojibake first
    expect(repairMojibake(Buffer.from('南方的风', 'utf8').toString('latin1'))).toBe('南方的风');
  });

  it('keeps the original when it cannot tell', () => {
    expect(detectLegacyEncoding(['Ä'], null)).toBeNull(); // one byte: not enough
    expect(decodeLegacy('Motörhead', 'gbk')).toBe('Motörhead');
  });
});
