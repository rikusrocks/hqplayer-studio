import {
  emptyQueue,
  type EngineStatus,
  type QueueMode,
  type QueueSource,
  type QueueState,
  type QueueSyncCode,
  type QueueSyncState,
  type Track,
} from '@hqps/contracts';
import {
  CapabilityUnavailableError,
  type EngineQueueSnapshot,
  type PlayableTrack,
} from '@hqps/hqplayer-adapter';
import { ConflictError, NotFoundError, newId, type LibraryContext } from '@hqps/library';
import type { EventHub } from '../event-hub';
import type { EngineService } from './engine-service';

interface PlannedItem {
  itemId: string;
  track: Track;
}

export interface QueueServiceOptions {
  /**
   * After Studio itself changed HQPlayer's queue, mismatches are not flagged for this long:
   * HQPlayer acknowledges before its pushed Status catches up (Stop ~3.8 s, Play ~3 s buffering).
   */
  settleMs?: number;
}

export interface ReplaceInput {
  trackIds: string[];
  startIndex?: number;
  source?: QueueSource | null;
  mode?: QueueMode;
  autoplay?: boolean;
}

/**
 * Owns Studio's *planned* Now Playing queue and keeps it honest against what HQPlayer reports.
 *
 * - Every change goes to the engine first; the plan is only updated (and persisted) once the
 *   engine accepted the command. A failed or timed-out command leaves the plan untouched.
 * - When HQPlayer's current track stops matching the plan (someone used the native UI or another
 *   remote), the queue is flagged `out_of_sync` — it is never silently overwritten. The user
 *   decides: "follow HQPlayer" (read-only: adopt HQPlayer's playlist or drop Studio's plan) or
 *   "take over" (re-send Studio's plan; stops HQPlayer, does not start playback).
 * - A plan restored from the last session is only a guess: if HQPlayer has its own playlist
 *   when Studio connects, Studio follows HQPlayer instead of raising an alarm.
 * - Saved playlists are never modified by queue operations.
 */
export class QueueService {
  private items: PlannedItem[] = [];
  private sessionId: string | null = null;
  private version = 0;
  private mode: QueueMode = 'playlist';
  private source: QueueSource | null = null;
  private currentIndex: number | null = null;
  private sync: QueueState['sync'] = {
    state: 'unknown',
    code: null,
    reason: null,
    detectedAt: null,
  };
  private updatedAt = Date.now();
  /** >0 while Studio itself is changing the engine queue; sync checks wait until it settles. */
  private busy = 0;
  /** The plan came from the last session and has not been compared with HQPlayer yet. */
  private restored = false;
  private settleUntil = 0;
  /** When Studio's own last queue change finished; older engine statuses cannot judge it. */
  private lastChangeAt = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly settleMs: number;

  constructor(
    private readonly engine: EngineService,
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
    options: QueueServiceOptions = {},
  ) {
    this.settleMs = options.settleMs ?? 4000;
  }

  /** Restore the last persisted plan. Never starts playback. */
  init(): void {
    this.restore();
    this.engine.onStatus((s) => this.onEngineStatus(s));
  }

  dispose(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private restore(): void {
    const snap = this.ctx.queue.load();
    if (!snap || snap.items.length === 0) return;
    const ids = snap.items.map((i) => i.trackId);
    let tracks: Track[];
    try {
      tracks = this.ctx.library.getTracks(ids);
    } catch {
      return; // tracks were removed from the library since — the old plan is meaningless
    }
    // A queue of fictional demo tracks (left over from mock mode) means nothing to a real
    // HQPlayer and could never be sent to it.
    if (
      this.engine.adapter.kind !== 'mock' &&
      this.ctx.library.getTrackSources([...new Set(ids)]).some((s) => s.isFixture)
    ) {
      return;
    }
    this.items = snap.items.map((i, idx) => ({ itemId: i.itemId, track: tracks[idx] as Track }));
    this.sessionId = snap.sessionId;
    this.version = snap.version;
    this.mode = snap.mode;
    this.source = snap.source;
    this.currentIndex = snap.currentIndex;
    this.updatedAt = snap.updatedAt;
    this.restored = true;
  }

  get(): QueueState {
    if (this.items.length === 0 && this.version === 0) return { ...emptyQueue(), sync: this.sync };
    return {
      sessionId: this.sessionId,
      version: this.version,
      mode: this.mode,
      source: this.source,
      items: this.items.map((i) => ({ itemId: i.itemId, track: i.track })),
      currentIndex: this.currentIndex,
      sync: this.sync,
      updatedAt: this.updatedAt,
    };
  }

  replace(input: ReplaceInput): Promise<QueueState> {
    return this.exclusive(() => this.replaceImpl(input));
  }

  private async replaceImpl(input: ReplaceInput): Promise<QueueState> {
    const all = this.ctx.library.getTracks(input.trackIds);
    const requestedStart = Math.min(
      Math.max(0, input.startIndex ?? 0),
      Math.max(0, all.length - 1),
    );
    const startTrack = all[requestedStart];
    const tracks = all.filter((t) => t.available);
    if (tracks.length === 0) {
      throw new ConflictError(
        'None of these tracks are currently available (is the music folder offline?)',
      );
    }
    if (tracks.length < all.length) {
      this.hub.notice(
        'warning',
        'tracks_unavailable',
        `${all.length - tracks.length} unavailable track(s) were skipped.`,
        { count: all.length - tracks.length },
      );
    }
    let startIndex = startTrack ? tracks.findIndex((t) => t.id === startTrack.id) : 0;
    if (startIndex < 0) startIndex = 0;
    const mode = input.mode ?? 'playlist';
    if (mode === 'album' && !this.engine.can('mode.album')) {
      this.hub.notice(
        'info',
        'album_mode_unavailable',
        'Album Mode cannot be selected through the HQPlayer API; tracks are queued in album order but gapless playback is not guaranteed.',
      );
    }
    this.engine.require('queue.replace');
    const playables = this.playables(tracks);
    const autoplay = input.autoplay ?? true;
    await this.engine.run('replaceQueue', (a) => {
      if (!a.replaceQueue)
        throw new CapabilityUnavailableError('queue.replace', 'adapter cannot load a queue');
      return a.replaceQueue(playables, { startIndex, autoplay, albumMode: mode === 'album' });
    });
    this.items = tracks.map((track) => ({ itemId: newId('qi'), track }));
    this.sessionId = newId('qs');
    this.mode = mode;
    this.source = input.source ?? {
      kind: 'tracks',
      id: null,
      label: tracks.length === 1 ? (tracks[0] as Track).title : `${tracks.length} tracks`,
    };
    this.currentIndex = startIndex;
    this.setSync('in_sync');
    return this.commit();
  }

  async playAlbum(albumId: string, startTrackId?: string): Promise<QueueState> {
    const album = this.ctx.library.getAlbum(albumId);
    const ids = album.tracks.map((t) => t.id);
    const start = startTrackId ? ids.indexOf(startTrackId) : 0;
    if (startTrackId && start < 0) throw new NotFoundError('Track in album', startTrackId);
    return this.replace({
      trackIds: ids,
      startIndex: Math.max(0, start),
      mode: 'album',
      source: { kind: 'album', id: album.id, label: `${album.title} — ${album.albumArtist}` },
      autoplay: true,
    });
  }

  async playPlaylist(playlistId: string, startItemId?: string): Promise<QueueState> {
    const pl = this.ctx.playlists.get(playlistId);
    if (pl.items.length === 0) throw new ConflictError('This playlist is empty');
    const start = startItemId ? pl.items.findIndex((i) => i.itemId === startItemId) : 0;
    if (startItemId && start < 0) throw new NotFoundError('Playlist item', startItemId);
    return this.replace({
      trackIds: pl.items.map((i) => i.track.id),
      startIndex: Math.max(0, start),
      mode: 'playlist',
      source: { kind: 'playlist', id: pl.id, label: pl.name },
      autoplay: true,
    });
  }

  add(trackIds: string[], position: 'next' | 'end'): Promise<QueueState> {
    return this.exclusive(() => this.addImpl(trackIds, position));
  }

  private async addImpl(trackIds: string[], position: 'next' | 'end'): Promise<QueueState> {
    if (this.items.length === 0) {
      return this.replace({
        trackIds,
        startIndex: 0,
        mode: 'playlist',
        autoplay: false,
        source: { kind: 'manual', id: null, label: 'Queue' },
      });
    }
    const tracks = this.ctx.library.getTracks(trackIds).filter((t) => t.available);
    if (tracks.length === 0)
      throw new ConflictError('None of these tracks are currently available');
    const playables = this.playables(tracks);
    if (position === 'end') {
      this.engine.require('queue.append');
      await this.engine.run('appendToQueue', (a) => {
        if (!a.appendToQueue)
          throw new CapabilityUnavailableError('queue.append', 'adapter cannot append');
        return a.appendToQueue(playables);
      });
      this.items.push(...tracks.map((track) => ({ itemId: newId('qi'), track })));
    } else {
      this.engine.require('queue.append');
      await this.engine.run('insertNext', (a) => {
        if (!a.insertNext)
          throw new CapabilityUnavailableError(
            'queue.append',
            '"Play Next" is not supported by this engine adapter',
          );
        return a.insertNext(playables);
      });
      const at = this.currentIndex === null ? 0 : this.currentIndex + 1;
      this.items.splice(at, 0, ...tracks.map((track) => ({ itemId: newId('qi'), track })));
    }
    this.mode = 'playlist'; // an edited album queue is no longer a pure album
    return this.commit();
  }

  remove(itemIds: string[]): Promise<QueueState> {
    return this.exclusive(() => this.removeImpl(itemIds));
  }

  private async removeImpl(itemIds: string[]): Promise<QueueState> {
    const indexes = itemIds
      .map((id) => this.items.findIndex((i) => i.itemId === id))
      .filter((i) => i >= 0)
      .sort((a, b) => b - a);
    if (indexes.length === 0) throw new NotFoundError('Queue item', itemIds.join(', '));
    this.engine.require('queue.replace');
    for (const index of indexes) {
      await this.engine.run('removeFromQueue', (a) => {
        if (!a.removeFromQueue)
          throw new CapabilityUnavailableError('queue.replace', 'adapter cannot remove items');
        return a.removeFromQueue(index);
      });
      this.items.splice(index, 1);
      if (this.currentIndex !== null && index < this.currentIndex) this.currentIndex -= 1;
    }
    if (this.items.length === 0) this.currentIndex = null;
    else if (this.currentIndex !== null)
      this.currentIndex = Math.min(this.currentIndex, this.items.length - 1);
    this.mode = 'playlist';
    return this.commit();
  }

  jump(index: number): Promise<QueueState> {
    return this.exclusive(() => this.jumpImpl(index));
  }

  private async jumpImpl(index: number): Promise<QueueState> {
    if (index < 0 || index >= this.items.length)
      throw new NotFoundError('Queue index', String(index));
    this.engine.require('queue.select');
    await this.engine.run('selectIndex', (a) => {
      if (!a.selectIndex)
        throw new CapabilityUnavailableError('queue.select', 'adapter cannot select');
      return a.selectIndex(index, true);
    });
    this.currentIndex = index;
    return this.commit();
  }

  clear(): Promise<QueueState> {
    return this.exclusive(() => this.clearImpl());
  }

  private async clearImpl(): Promise<QueueState> {
    this.engine.require('queue.replace');
    await this.engine.run('clearQueue', async (a) => {
      if (!a.clearQueue)
        throw new CapabilityUnavailableError('queue.replace', 'adapter cannot clear');
      await a.clearQueue();
    });
    this.items = [];
    this.currentIndex = null;
    this.source = null;
    this.setSync('in_sync');
    return this.commit();
  }

  /**
   * Tracks were removed from the library (a folder was removed). A plan that refers to them
   * cannot be kept or saved: drop it — HQPlayer keeps playing what it has, untouched.
   */
  forgetTracks(ids: ReadonlySet<string>): void {
    if (!this.items.some((i) => ids.has(i.track.id))) return;
    this.items = [];
    this.currentIndex = null;
    this.source = null;
    this.mode = 'playlist';
    this.sessionId = newId('qs');
    this.restored = false;
    this.setSync('in_sync');
    this.commit();
    if (this.busy === 0) this.onEngineStatus(this.engine.getStatus());
  }

  /**
   * Explicit user decision: make Studio follow HQPlayer. Sends no write command — HQPlayer keeps
   * playing exactly what it plays. If every entry of HQPlayer's playlist is in the library, that
   * playlist becomes Studio's queue; otherwise Studio drops its plan and the queue panel shows
   * HQPlayer's own playlist (read-only).
   */
  follow(): Promise<QueueState> {
    return this.exclusive(() => this.followImpl());
  }

  private async followImpl(): Promise<QueueState> {
    const adopted = await this.readEnginePlaylist();
    this.items = adopted ? adopted.tracks.map((track) => ({ itemId: newId('qi'), track })) : [];
    this.currentIndex = adopted ? adopted.currentIndex : null;
    this.mode = 'playlist';
    this.source = adopted ? { kind: 'manual', id: null, label: 'HQPlayer' } : null;
    this.sessionId = newId('qs');
    this.restored = false;
    this.setSync('in_sync'); // re-checked against HQPlayer as soon as this settles
    if (adopted) {
      this.hub.notice(
        'info',
        'queue_followed_engine',
        `Studio now follows HQPlayer's playlist (${adopted.tracks.length} tracks).`,
        { count: adopted.tracks.length },
      );
    } else {
      this.hub.notice(
        'info',
        'queue_released',
        "Studio dropped its queue; the queue panel shows HQPlayer's own playlist.",
      );
    }
    return this.commit();
  }

  /** HQPlayer's playlist as library tracks — null unless *every* entry is in the library. */
  private async readEnginePlaylist(): Promise<{
    tracks: Track[];
    currentIndex: number | null;
  } | null> {
    if (!this.engine.can('queue.read')) return null;
    let snap: EngineQueueSnapshot;
    try {
      snap = await this.engine.run('getEngineQueue', (a) => {
        if (!a.getEngineQueue)
          throw new CapabilityUnavailableError('queue.read', 'adapter cannot read the queue');
        return a.getEngineQueue();
      });
    } catch {
      return null;
    }
    if (snap.entries.length === 0) return null;
    const ids: string[] = [];
    for (const entry of snap.entries) {
      const id = entry.uri ? this.ctx.library.findTrackIdBySource(entry.uri) : null;
      if (!id) return null;
      ids.push(id);
    }
    const current = snap.currentIndex ?? null;
    return {
      tracks: this.ctx.library.getTracks(ids),
      currentIndex: current !== null && current >= 0 && current < ids.length ? current : null,
    };
  }

  /**
   * Explicit user decision: push Studio's plan back to HQPlayer. Stops HQPlayer first (its
   * playlist cannot be replaced under a playing track) and does not start playback.
   */
  takeover(): Promise<QueueState> {
    return this.exclusive(() => this.takeoverImpl());
  }

  private async takeoverImpl(): Promise<QueueState> {
    if (this.items.length === 0) throw new ConflictError('Studio has no queue to restore');
    this.engine.require('queue.replace');
    const playables = this.playables(this.items.map((i) => i.track));
    const startIndex = this.currentIndex ?? 0;
    await this.engine.run('takeover', (a) => {
      if (!a.replaceQueue)
        throw new CapabilityUnavailableError('queue.replace', 'adapter cannot load a queue');
      return a.replaceQueue(playables, {
        startIndex,
        autoplay: false,
        albumMode: this.mode === 'album',
      });
    });
    this.restored = false;
    this.setSync('in_sync');
    return this.commit();
  }

  // --- internals ------------------------------------------------------------------------------

  private async exclusive(fn: () => Promise<QueueState>): Promise<QueueState> {
    this.busy += 1;
    try {
      const state = await fn();
      this.lastChangeAt = Date.now();
      this.startSettling();
      return state;
    } finally {
      this.busy -= 1;
      if (this.busy === 0) this.onEngineStatus(this.engine.getStatus());
    }
  }

  /** Give HQPlayer's pushed Status time to catch up with a change Studio just made. */
  private startSettling(): void {
    if (this.settleMs <= 0) return;
    this.settleUntil = Date.now() + this.settleMs;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.onEngineStatus(this.engine.getStatus());
    }, this.settleMs + 50);
    this.settleTimer.unref?.();
  }

  private playables(tracks: Track[]): PlayableTrack[] {
    const sources = this.ctx.library.getTrackSources(tracks.map((t) => t.id));
    // The demo library is fictional: never hand its non-existent paths to a real HQPlayer
    // (loading it would replace the user's playlist with broken entries).
    if (this.engine.adapter.kind !== 'mock' && sources.some((s) => s.isFixture)) {
      throw new ConflictError(
        'Demo tracks are fictional and cannot be sent to the real HQPlayer. Add your music folder in Settings → Library and scan it first.',
      );
    }
    return sources.map((s) => ({
      studioTrackId: s.id,
      uri: s.sourcePath,
      title: s.title,
      artist: s.artist,
      album: s.album,
      durationMs: s.durationMs,
      format: {
        sampleRate: s.sampleRate,
        bitDepth: s.bitDepth,
        channels: s.channels,
        isDsd: s.isDsd,
      },
    }));
  }

  private onEngineStatus(status: EngineStatus): void {
    if (this.busy > 0) return;
    const verdict = this.evaluate(status);
    if (verdict.state !== 'engine_offline' && this.restored) {
      // First look at HQPlayer since the plan was restored from the last session.
      this.restored = false;
      if (verdict.state === 'out_of_sync' && verdict.code !== 'engine_playlist_empty') {
        // HQPlayer has its own playlist: follow it rather than alarm about a stale plan.
        // (An empty HQPlayer playlist keeps the plan + banner, so it can be pushed back.)
        void this.follow().catch(() => undefined);
        return;
      }
    }
    if (
      verdict.state === 'out_of_sync' &&
      // HQPlayer has not reported since Studio's own change (its last Status predates it), or
      // is still catching up with it: not a verdict yet.
      (status.observedAt <= this.lastChangeAt || Date.now() < this.settleUntil)
    ) {
      return;
    }
    const changed =
      verdict.state !== this.sync.state ||
      verdict.index !== this.currentIndex ||
      verdict.code !== this.sync.code;
    if (!changed) return;
    this.currentIndex = verdict.index;
    this.setSync(verdict.state, verdict.code);
    this.commit(verdict.state !== 'engine_offline' && verdict.state !== 'out_of_sync');
  }

  private evaluate(status: EngineStatus): {
    state: QueueSyncState;
    code: QueueSyncCode | null;
    index: number | null;
  } {
    const index = this.currentIndex;
    if (status.connection !== 'connected') return { state: 'engine_offline', code: null, index };
    if (this.items.length === 0) {
      return status.track
        ? { state: 'unknown', code: 'engine_unqueued', index }
        : { state: 'in_sync', code: null, index };
    }
    if (!status.track) {
      if (status.trackCount === 0)
        return { state: 'out_of_sync', code: 'engine_playlist_empty', index };
      if (status.trackCount !== null && status.trackCount !== this.items.length)
        return { state: 'out_of_sync', code: 'engine_length_differs', index };
      // Stopped with a playlist of the right length: nothing new to learn — keep the verdict.
      return this.sync.state === 'out_of_sync'
        ? { state: 'out_of_sync', code: this.sync.code, index }
        : { state: 'in_sync', code: null, index };
    }
    const engineIdx = status.trackIndex;
    const planned = engineIdx !== null ? this.items[engineIdx] : undefined;
    const matches = planned !== undefined && status.track.studioTrackId === planned.track.id;
    const countOk = status.trackCount === null || status.trackCount === this.items.length;
    if (matches && countOk) return { state: 'in_sync', code: null, index: engineIdx };
    return {
      state: 'out_of_sync',
      code: matches ? 'engine_length_differs' : 'engine_track_differs',
      index,
    };
  }

  private setSync(state: QueueSyncState, code: QueueSyncCode | null = null): void {
    if (state !== this.sync.state || code !== this.sync.code) {
      this.sync = { state, code, reason: code ? SYNC_REASONS[code] : null, detectedAt: Date.now() };
    }
  }

  private commit(persist = true): QueueState {
    this.version += 1;
    this.updatedAt = Date.now();
    if (persist && this.sessionId) {
      this.ctx.queue.save({
        sessionId: this.sessionId,
        version: this.version,
        mode: this.mode,
        source: this.source,
        currentIndex: this.currentIndex,
        items: this.items.map((i) => ({ itemId: i.itemId, trackId: i.track.id })),
        updatedAt: this.updatedAt,
      });
    }
    const state = this.get();
    this.hub.publish({ type: 'queue.changed', queue: state });
    return state;
  }
}

/** English fallbacks for clients that do not translate `sync.code`. */
const SYNC_REASONS: Record<QueueSyncCode, string> = {
  engine_unqueued: 'HQPlayer is playing something that Studio did not queue.',
  engine_playlist_empty:
    "HQPlayer's playlist is empty, so it no longer matches Studio's queue (HQPlayer restarted, or the playlist was cleared elsewhere).",
  engine_track_differs:
    'HQPlayer is playing a track that is not in Studio’s queue (changed outside Studio).',
  engine_length_differs:
    "HQPlayer's playlist length differs from Studio's queue (changed outside Studio).",
};
