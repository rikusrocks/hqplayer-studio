/**
 * Old Chinese/Japanese taggers wrote ID3v1 / ID3v2 "ISO-8859-1" frames / RIFF INFO in the
 * system code page (GBK on Simplified Chinese Windows, Shift-JIS on Japanese Windows). Parsers
 * read those bytes as Latin-1, so "南方的风" arrives as "ÄÏ·½µÄ·ç". This module recovers them.
 *
 * It is deliberately conservative — a wrong guess is worse than leaving text alone:
 *  - only strings made purely of Latin-1 code points with at least two high bytes are considered;
 *  - genuine European text (isolated accented letters: "Café", "Motörhead", "Sigur Rós") is kept;
 *  - a candidate must decode without errors and look like real CJK text (scored), and the
 *    winner must clearly beat the other candidate;
 *  - the file's folder/file name (Unicode on Windows) is used as a language hint.
 * All tag fields of one file are judged together, so they get the same encoding.
 */

export type LegacyEncoding = 'gbk' | 'shift_jis';
export type LanguageHint = 'zh' | 'ja' | null;

const CANDIDATES: LegacyEncoding[] = ['gbk', 'shift_jis'];
type Decoder = InstanceType<typeof TextDecoder>;
const decoders = new Map<LegacyEncoding, Decoder | null>();

function decoder(enc: LegacyEncoding): Decoder | null {
  if (!decoders.has(enc)) {
    try {
      decoders.set(enc, new TextDecoder(enc, { fatal: true }));
    } catch {
      decoders.set(enc, null); // runtime without full ICU: skip quietly
    }
  }
  return decoders.get(enc) ?? null;
}

const KANA = /[぀-ヿ]/;
const HAN = /[一-鿿]/;

/** Language hint from a path or file name (those are real Unicode on Windows). */
export function languageHint(text: string): LanguageHint {
  if (KANA.test(text)) return 'ja';
  if (HAN.test(text)) return 'zh';
  return null;
}

/** Could this be legacy-encoded bytes read as Latin-1? */
export function isLegacyCandidate(value: string): boolean {
  if (/[^\p{ASCII}\u0080-\u00ff]/u.test(value)) return false; // beyond Latin-1: real Unicode
  const runs = value.match(/[\u0080-ÿ]+/g);
  if (!runs) return false;
  const high = runs.reduce((n, r) => n + r.length, 0);
  if (high < 2) return false;
  // European text: every accented letter stands alone between ASCII letters
  const european = runs.every((r) => r.length === 1 && r >= ' ');
  return !european;
}

/**
 * Plausibility of `bytes` as text in `enc`, judged by byte ranges rather than decoded characters:
 * GBK maps almost every byte pair to *some* ideograph, but real Chinese text sits in the GB2312
 * core (lead B0–F7, trail A1–FE); real Japanese text sits in kana (82/83) and level-1 kanji
 * (88–98). Mis-decodes land in GBK extension areas or half-width katakana.
 */
function byteScore(bytes: Uint8Array, enc: LegacyEncoding): number {
  let s = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    if (b < 0x80) continue;
    const t = bytes[i + 1] ?? 0;
    if (enc === 'gbk') {
      i += 1; // every high byte starts a two-byte character
      if (t < 0xa1)
        s -= 2; // GBK extension (trail outside GB2312)
      else if (b >= 0xb0 && b <= 0xd7)
        s += 2; // level-1 hanzi (most common 3,755)
      else if (b >= 0xd8 && b <= 0xf7)
        s += 1; // level-2 hanzi
      else if (b >= 0xa1 && b <= 0xa9)
        s += 1; // punctuation, full-width forms, kana
      else s -= 2; // 81–A0, AA–AF, F8–FE: extension / user-defined
    } else {
      if (b >= 0xa1 && b <= 0xdf) {
        s -= 3; // single-byte half-width katakana: classic mis-decode
        continue;
      }
      i += 1;
      if (b === 0x81)
        s += 1; // punctuation
      else if (b === 0x82)
        s += 2; // full-width alphanumerics, hiragana
      else if (b === 0x83)
        s += t <= 0x96 ? 2 : 0; // katakana (then Greek)
      else if (b >= 0x88 && b <= 0x98)
        s += 2; // level-1 kanji
      else if ((b >= 0x99 && b <= 0x9f) || (b >= 0xe0 && b <= 0xea))
        s += 1; // level-2 kanji
      else s -= 2; // Cyrillic/box drawing, NEC/IBM extensions, user-defined
    }
  }
  return s;
}

/** Pick the encoding for a set of suspicious strings, or null to leave them alone. */
export function detectLegacyEncoding(values: string[], hint: LanguageHint): LegacyEncoding | null {
  const suspicious = values.filter(isLegacyCandidate);
  if (suspicious.length === 0) return null;
  const bytes = suspicious.map((v) => Buffer.from(v, 'latin1'));
  const highBytes = bytes.reduce((n, b) => n + b.filter((x) => x >= 0x80).length, 0);
  const results: { enc: LegacyEncoding; score: number }[] = [];
  for (const enc of CANDIDATES) {
    const d = decoder(enc);
    if (!d) continue;
    try {
      for (const b of bytes) d.decode(b); // must be valid in this encoding at all
    } catch {
      continue;
    }
    let total = bytes.reduce((n, b) => n + byteScore(b, enc), 0);
    if (hint === 'ja' && enc === 'shift_jis') total += 3;
    if (hint === 'zh' && enc === 'gbk') total += 3;
    results.push({ enc, score: total });
  }
  results.sort((a, b) => b.score - a.score);
  const [best, second] = results;
  if (!best) return null;
  // most characters must look like everyday CJK text (common ones score 2 per character)
  if (best.score < Math.max(2, highBytes * 0.4)) return null;
  if (second && best.score - second.score < 2) return null; // too close to call
  return best.enc;
}

/** Decode one Latin-1-read string with the chosen encoding; unchanged if not applicable. */
export function decodeLegacy(value: string, enc: LegacyEncoding): string {
  if (!isLegacyCandidate(value)) return value;
  const d = decoder(enc);
  if (!d) return value;
  try {
    return d.decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
}

/** True when this runtime can decode the legacy encodings (Electron ships full ICU). */
export function legacyDecodingAvailable(): boolean {
  return CANDIDATES.every((enc) => decoder(enc) !== null);
}
