import { createHash } from 'node:crypto';
import {
  normalizeText,
  pickCanonicalAlbum,
  type AmbiguousFolder,
  type LibraryContext,
} from '@hqps/library';

/**
 * Opt-in MusicBrainz check for album folders the local rules could not settle (several album
 * names, unclear numbering). Only album title + album artist go to musicbrainz.org — never file
 * paths. If MusicBrainz has no release whose track list matches the folder (common for indie
 * music), nothing changes. Answers are cached, so a folder is asked about once (a "no match" is
 * retried after 30 days).
 */

export interface MbRelease {
  id: string;
  title: string;
  trackCount: number;
}

export interface MbTrack {
  disc: number;
  position: number;
  title: string;
  lengthMs: number | null;
}

export interface MusicBrainzOptions {
  userAgent: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** MusicBrainz allows one request per second per client. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

export class MusicBrainzClient {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;

  constructor(private readonly options: MusicBrainzOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://musicbrainz.org/ws/2';
    this.minIntervalMs = options.minIntervalMs ?? 1100;
  }

  async searchReleases(artist: string, title: string): Promise<MbRelease[]> {
    const q = `release:"${luceneEscape(title)}" AND artist:"${luceneEscape(artist)}"`;
    const body = (await this.get(`/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`)) as {
      releases?: { id: string; title: string; 'track-count'?: number }[];
    };
    return (body.releases ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      trackCount: r['track-count'] ?? 0,
    }));
  }

  async releaseTracks(id: string): Promise<MbTrack[]> {
    const body = (await this.get(`/release/${encodeURIComponent(id)}?inc=recordings&fmt=json`)) as {
      media?: {
        position?: number;
        tracks?: { position?: number; title: string; length?: number | null }[];
      }[];
    };
    const out: MbTrack[] = [];
    (body.media ?? []).forEach((m, i) => {
      for (const t of m.tracks ?? []) {
        out.push({
          disc: m.position ?? i + 1,
          position: t.position ?? 0,
          title: t.title,
          lengthMs: t.length ?? null,
        });
      }
    });
    return out;
  }

  /** One request at a time, at most one per `minIntervalMs`; a 503 (rate limited) is retried once. */
  private get(path: string): Promise<unknown> {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const wait = this.last + this.minIntervalMs * (attempt + 1) - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.last = Date.now();
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
          headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
        if (res.status === 503 && attempt === 0) continue;
        if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
        return (await res.json()) as unknown;
      }
      throw new Error('MusicBrainz is rate limiting');
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

function luceneEscape(s: string): string {
  return s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
}

type FolderTrack = AmbiguousFolder['tracks'][number];

/** Share of the folder's tracks found on the release (title, position+length, or length alone). */
export function matchShare(ours: FolderTrack[], theirs: MbTrack[]): number {
  if (ours.length === 0 || theirs.length === 0) return 0;
  const free = new Set(theirs.map((_, i) => i));
  const close = (a: number | null, b: number | null, tol: number) =>
    a !== null && b !== null && Math.abs(a - b) <= tol;
  let matched = 0;
  const take = (pred: (t: MbTrack) => boolean) => {
    for (const i of free) {
      if (pred(theirs[i] as MbTrack)) {
        free.delete(i);
        return true;
      }
    }
    return false;
  };
  const pending: FolderTrack[] = [];
  for (const o of ours) {
    const title = normalizeText(o.title);
    if (take((t) => normalizeText(t.title) === title)) matched += 1;
    else pending.push(o);
  }
  for (const o of pending) {
    const byPosition = (t: MbTrack) =>
      o.track !== null &&
      t.position === o.track &&
      t.disc === (o.disc ?? 1) &&
      close(t.lengthMs, o.durationMs, 3000);
    const byLength = (t: MbTrack) => close(t.lengthMs, o.durationMs, 2000);
    if (take(byPosition) || take(byLength)) matched += 1;
  }
  return matched / ours.length;
}

export interface OnlineDecision {
  merge: boolean;
  releaseId: string | null;
  share: number;
}

const RECHECK_UNMATCHED_MS = 30 * 24 * 3600_000;

export function folderKey(f: AmbiguousFolder): string {
  const titles = [...new Set(f.tracks.map((t) => normalizeText(t.album)))].sort();
  const hash = createHash('sha1')
    .update([f.rootId, f.folder, titles.join('\u0001'), String(f.tracks.length)].join('\u0000'))
    .digest('hex');
  return `mb:${hash}`;
}

export class OnlineAlbumChecker {
  constructor(
    private readonly ctx: LibraryContext,
    private readonly client: MusicBrainzClient,
  ) {}

  /** Check (or re-apply cached answers for) every unsettled folder. Returns what changed. */
  async run(
    rootId?: string,
    signal?: AbortSignal,
  ): Promise<{ checked: number; merged: number; unmatched: number; failed: number }> {
    const stats = { checked: 0, merged: 0, unmatched: 0, failed: 0 };
    for (const folder of this.ctx.library.ambiguousFolders(rootId)) {
      if (signal?.aborted) break;
      const key = folderKey(folder);
      const cached = this.ctx.library.getOnlineLookup<OnlineDecision>(key);
      let decision = cached?.result ?? null;
      if (
        !decision ||
        (!decision.merge && Date.now() - (cached?.checkedAt ?? 0) > RECHECK_UNMATCHED_MS)
      ) {
        try {
          decision = await this.ask(folder);
          this.ctx.library.setOnlineLookup(key, 'musicbrainz', decision);
          stats.checked += 1;
        } catch {
          stats.failed += 1; // offline / rate limited: try again next time
          continue;
        }
      }
      if (decision.merge) {
        const target = pickCanonicalAlbum(folder.tracks);
        if (target) {
          const move = folder.tracks.filter((t) => t.albumId !== target.albumId).map((t) => t.id);
          this.ctx.library.moveTracksToAlbum(move, target.albumId, target.title);
          stats.merged += 1;
        }
      } else {
        stats.unmatched += 1;
      }
    }
    return stats;
  }

  private async ask(folder: AmbiguousFolder): Promise<OnlineDecision> {
    const count = (xs: string[]) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
    };
    const artist = count(folder.tracks.map((t) => t.albumArtist))[0] ?? '';
    const titles = count(folder.tracks.map((t) => t.album)).slice(0, 3);
    const n = folder.tracks.length;
    const tried = new Set<string>();
    let best: OnlineDecision = { merge: false, releaseId: null, share: 0 };
    for (const title of titles) {
      const releases = (await this.client.searchReleases(artist, title))
        .filter((r) => !tried.has(r.id) && Math.abs(r.trackCount - n) <= 2)
        .slice(0, 2);
      for (const r of releases) {
        tried.add(r.id);
        const share = matchShare(folder.tracks, await this.client.releaseTracks(r.id));
        if (share > best.share) best = { merge: share >= 0.8 && n >= 3, releaseId: r.id, share };
        if (best.merge) return best;
      }
    }
    return best;
  }
}
