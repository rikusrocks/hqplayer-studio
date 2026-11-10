/**
 * Invented lyrics for the fictional demo library, so synced lyrics can be tried on the Mac with
 * the mock engine. Every line is generated here and says that it is a demo — no real lyrics.
 */
const PATTERNS = [
  (n: number, title: string) => `演示歌词 · 第 ${n} 行 ——《${title}》`,
  (n: number) => `Demo lyric line ${n}: the words would appear here`,
  (n: number) => `デモ歌詞・${n} 行目（架空のテキスト）`,
  (n: number) => `第 ${n} 行：随进度滚动的示例文字`,
];

/** LRC text with a line every ~5 s across the track (at most 48 lines). */
export function demoLyricsLrc(title: string, durationMs: number | null): string {
  const end = Math.max(30_000, (durationMs ?? 180_000) - 4000);
  const step = Math.max(5000, Math.ceil(end / 48 / 1000) * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  const out = [`[ti:${title}]`, '[by:HQPlayer Studio demo]'];
  let n = 1;
  for (let t = 3000; t < end; t += step, n += 1) {
    const m = Math.floor(t / 60_000);
    const s = Math.floor(t / 1000) % 60;
    const pattern = PATTERNS[(n - 1) % PATTERNS.length]!;
    out.push(`[${pad(m)}:${pad(s)}.00]${pattern(n, title)}`);
  }
  return out.join('\n');
}
