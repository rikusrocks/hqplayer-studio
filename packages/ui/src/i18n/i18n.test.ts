import { describe, expect, it } from 'vitest';
import { interpolate, translate } from './I18nProvider';
import { en } from './messages.en';
import { zh } from './messages.zh';

describe('i18n dictionaries', () => {
  it('zh and en have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it('no empty translations', () => {
    for (const dict of [zh, en]) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), key).not.toBe('');
      }
    }
  });
  it('placeholders match between locales', () => {
    const vars = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(vars(en[key]), key).toEqual(vars(zh[key]));
    }
  });
});

describe('interpolate / translate', () => {
  it('replaces known placeholders and keeps unknown ones', () => {
    expect(interpolate('Added to “{name}” {x}', { name: 'Mix' })).toBe('Added to “Mix” {x}');
  });
  it('translates with params', () => {
    expect(translate('zh-CN', 'common.tracksCount', { count: 3 })).toBe('3 首');
    expect(translate('en', 'common.tracksCount', { count: 3 })).toBe('3 tracks');
  });
});
