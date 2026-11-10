import { normalizeText } from '../normalize';
import type { FolderTrack } from '../repositories/library-repo';

/**
 * One album folder sometimes holds tracks whose album tags differ — another language
 * ("城市漫游者" / "City Wanderer"), an edition suffix, a typo — and they show up as separate
 * albums. Decide whether the folder is really one album and, if so, which album row to keep.
 *
 * Only merged when the evidence is strong, so a "misc singles" folder is never glued together:
 *  - at least 80 % of the tracks have track numbers, and no (disc, track) pair repeats;
 *  - numbering is near-contiguous on each disc (highest number ≤ tracks on the disc + 2);
 *  - at most three different album titles.
 * The album with most tracks wins (ties: the one holding the lowest disc/track).
 */
export function planFolderAlbum(tracks: FolderTrack[]): { albumId: string; title: string } | null {
  const albums = new Map<string, FolderTrack[]>();
  for (const t of tracks) {
    if (!t.albumId) continue;
    const list = albums.get(t.albumId) ?? [];
    list.push(t);
    albums.set(t.albumId, list);
  }
  if (albums.size < 2) return null;

  const numbered = tracks.filter((t) => t.track !== null);
  if (numbered.length < tracks.length * 0.8) return null;
  const seen = new Set<string>();
  const perDisc = new Map<number, number[]>();
  for (const t of numbered) {
    const disc = t.disc ?? 1;
    const key = `${disc}:${t.track}`;
    if (seen.has(key)) return null; // two "track 3" on the same disc: really different albums
    seen.add(key);
    const list = perDisc.get(disc) ?? [];
    list.push(t.track as number);
    perDisc.set(disc, list);
  }
  for (const nums of perDisc.values()) {
    if (Math.max(...nums) > nums.length + 2) return null;
  }
  const titles = new Set(tracks.map((t) => normalizeText(t.album)));
  if (titles.size > 3) return null;

  return pickCanonicalAlbum(tracks);
}

/** The album row a folder's tracks should join: most tracks, ties → the lowest disc/track. */
export function pickCanonicalAlbum(
  tracks: FolderTrack[],
): { albumId: string; title: string } | null {
  const albums = new Map<string, FolderTrack[]>();
  for (const t of tracks) {
    if (!t.albumId) continue;
    const list = albums.get(t.albumId) ?? [];
    list.push(t);
    albums.set(t.albumId, list);
  }
  const order = (t: FolderTrack) => (t.disc ?? 1) * 10_000 + (t.track ?? 9_999);
  const ranked = [...albums.entries()].sort(
    ([, a], [, b]) => b.length - a.length || Math.min(...a.map(order)) - Math.min(...b.map(order)),
  );
  if (ranked.length === 0) return null;
  const [albumId, members] = ranked[0] as [string, FolderTrack[]];
  return { albumId, title: (members[0] as FolderTrack).album };
}
