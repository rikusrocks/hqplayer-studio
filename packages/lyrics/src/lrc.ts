export interface LyricLine {
  /** Start time in ms, already including the file's [offset:] tag. */
  timeMs: number;
  text: string;
}

export interface ParsedLyrics {
  kind: 'synced' | 'plain';
  lines: LyricLine[];
  /** Plain lyrics (no timestamps) keep their original lines here. */
  plain: string[];
  meta: { title?: string; artist?: string; album?: string; offsetMs: number };
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ti|ar|al|offset|by|length|re|ve):([^\]]*)\]\s*$/i;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function fractionToMs(frac: string | undefined): number {
  if (!frac) return 0;
  if (frac.length === 1) return Number(frac) * 100;
  if (frac.length === 2) return Number(frac) * 10;
  return Number(frac.slice(0, 3));
}

/**
 * Parse LRC text. Supports multiple timestamps per line (`[00:12.00][00:45.10]chorus`),
 * `mm:ss`, `mm:ss.xx`, `mm:ss.xxx`, `mm:ss:xx`, the `[offset:±ms]` tag (positive = earlier,
 * per the LRC convention) and strips enhanced word timestamps (`<00:12.34>`).
 */
export function parseLrc(source: string): ParsedLyrics {
  const meta: ParsedLyrics['meta'] = { offsetMs: 0 };
  const timed: LyricLine[] = [];
  const plain: string[] = [];
  const rawLines = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);

  for (const raw of rawLines) {
    const line = raw.trim();
    const m = line.match(META_TAG);
    if (m) {
      const key = (m[1] as string).toLowerCase();
      const value = (m[2] as string).trim();
      if (key === 'offset') meta.offsetMs = Number.parseInt(value, 10) || 0;
      else if (key === 'ti') meta.title = value;
      else if (key === 'ar') meta.artist = value;
      else if (key === 'al') meta.album = value;
      continue;
    }
    const stamps: number[] = [];
    TIME_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastEnd = 0;
    while ((match = TIME_TAG.exec(line)) && match.index === lastEnd) {
      stamps.push(Number(match[1]) * 60_000 + Number(match[2]) * 1000 + fractionToMs(match[3]));
      lastEnd = TIME_TAG.lastIndex;
    }
    if (stamps.length === 0) {
      if (line) plain.push(line);
      continue;
    }
    const text = line.slice(lastEnd).replace(WORD_TAG, '').trim();
    for (const t of stamps) timed.push({ timeMs: t, text });
  }

  if (timed.length === 0) return { kind: 'plain', lines: [], plain, meta };
  // LRC [offset:+500] means lyrics should appear 500 ms *earlier*.
  const lines = timed
    .map((l) => ({ timeMs: Math.max(0, l.timeMs - meta.offsetMs), text: l.text }))
    .sort((a, b) => a.timeMs - b.timeMs);
  return { kind: 'synced', lines, plain, meta };
}

/**
 * Index of the line active at `positionMs`, or -1 before the first line.
 * `userOffsetMs` is the per-track calibration: positive delays the lyrics, negative advances them.
 */
export function activeLineIndex(
  lines: readonly LyricLine[],
  positionMs: number,
  userOffsetMs = 0,
): number {
  const t = positionMs - userOffsetMs;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid] as LyricLine).timeMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
