/**
 * Name matching shared by the online lyric sources. Tags and catalogues rarely agree to the
 * letter ("Song (Remastered 2009)" vs "Song", "A / B" vs "A"), so besides the name as tagged we
 * also try a cleaned title and the first credited artist — still for one track at a time.
 */

/** Comparison key: case, width, spaces, punctuation and symbols do not matter. */
export const normName = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

/** Words that mark a bracket / dash suffix as decoration rather than part of the title. */
const DECORATION =
  /remaster|\blive\b|\bmono\b|\bstereo\b|\bversion\b|\bver\b|\bedit\b|\bmix\b|deluxe|\bbonus\b|explicit|\bclean\b|acoustic|\bdemo\b|\bfeat\b|\bft\b|featuring|\bwith\b|\bost\b|soundtrack|现场|現場|live版|(?:录音室|錄音室|纪念|紀念|完整|单曲|單曲|专辑|專輯|电影|電影|电视|電視)版|主题曲|主題曲|插曲|片尾曲|片头曲|片頭曲|重制|重製/i;

const BRACKETS = /\s*[([（【［〔「『]([^)\]）】］〕」』]*)[)\]）】］〕」』]/gu;

/**
 * A title without decorations: "(Remastered 2009)", "[Live]", "（电影《X》主题曲）",
 * " - 2011 Remaster", " feat. Somebody". Brackets that look like part of the title
 * ("Song (Part 2)") stay.
 */
export function cleanTitle(title: string): string {
  let t = title.normalize('NFKC');
  t = t.replace(BRACKETS, (whole: string, inner: string) => (DECORATION.test(inner) ? '' : whole));
  t = t.replace(/\s+[-–—]\s+([^-–—]*)$/u, (whole: string, tail: string) =>
    DECORATION.test(tail) ? '' : whole,
  );
  t = t.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/iu, '');
  t = t.trim();
  return t || title.trim();
}

/** The first credited artist of "A / B", "A; B", "A、B", "A feat. B", "A & B". */
export function firstArtist(artist: string): string {
  const a = artist.normalize('NFKC');
  const first = a.split(
    /\s*(?:[/;,、&＆|]|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b)\s*/iu,
  )[0];
  return first?.trim() || artist.trim();
}

/** Distinct, non-empty variants in the order they should be tried. */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = normName(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

/** The title as tagged, then without decorations. */
export function titleVariants(title: string): string[] {
  return distinct([title, cleanTitle(title)]);
}

/** The artist as tagged, then the first credited artist. */
export function artistVariants(artist: string): string[] {
  return distinct([artist, firstArtist(artist)]);
}

export interface TrackSignature {
  trackName: string;
  artistName: string;
  /** Seconds. */
  durationSec?: number | null;
}

/**
 * Does a catalogue entry describe the same recording as the track? Titles must be equal (as
 * tagged or cleaned), the artists compatible (one contains the other, or the first credited
 * artists agree) and — when both sides know it — the duration within `toleranceSec`.
 */
export function sameTrack(
  candidate: TrackSignature,
  wanted: TrackSignature,
  toleranceSec = 3,
): boolean {
  const titles = new Set(titleVariants(wanted.trackName).map(normName));
  const theirs = titleVariants(candidate.trackName).map(normName);
  if (!theirs.some((t) => titles.has(t))) return false;

  const mine = artistVariants(wanted.artistName).map(normName);
  const other = artistVariants(candidate.artistName).map(normName);
  if (mine.length > 0 && other.length > 0) {
    const compatible = mine.some((a) => other.some((b) => a.includes(b) || b.includes(a)));
    if (!compatible) return false;
  }
  if (
    wanted.durationSec &&
    candidate.durationSec &&
    Math.abs(candidate.durationSec - wanted.durationSec) > toleranceSec
  ) {
    return false;
  }
  return true;
}

/** Sort key for candidates that passed `sameTrack`: closest duration first. */
export function durationDistance(candidate: TrackSignature, wanted: TrackSignature): number {
  return wanted.durationSec && candidate.durationSec
    ? Math.abs(candidate.durationSec - wanted.durationSec)
    : 0;
}
