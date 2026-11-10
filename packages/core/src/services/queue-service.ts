import {
  emptyQueue,
  type EngineStatus,
  type QueueMode,
  type QueueSource,
  type QueueState,
  type QueueSyncState,
  type Track,
} from '@hqps/contracts';
import { CapabilityUnavailableError, type PlayableTrack } from '@hqps/hqplayer-adapter';
import { ConflictError, NotFoundError, newId, type LibraryContext } from '@hqps/library';
import type { EventHub } from '../event-hub';
import type { EngineService } from './engine-service';

interface PlannedItem {
  itemId: string;
  track: Track;
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
 *   remote), the queue is flagged `out_of_sync` — it is never silently overwritten. The user can
 *   explicitly "take over", which re-sends the plan without starting playback.
 * - Saved playlists are never modified by queue operations.
 */
export class QueueService {
  private items: PlannedItem[] = [];
  private sessionId: string | null = null;
  private version = 0;
  private mode: QueueMode = 'playlist';
  private source: QueueSource | null = null;
  private currentIndex: number | null = null;
  private sync: QueueState['sync'] = { state: 'unknown', reason: null, detectedAt: null };
  private updatedAt = Date.now();
  /** >0 while Studio itself is changing the engine queue; sync checks wait until it settles. */
  private busy = 0;

  constructor(
    private readonly engine: EngineService,
    private readonly ctx: LibraryContext,
    private readonly hub: EventHub,
  ) {}

  /** Restore the last persisted plan. Never starts playback. */
  init(): void {
    const snap = this.ctx.queue.load();
    if (snap && snap.items.length) {
      const tracks = this.ctx.library.getTracks(snap.items.map((i) => i.trackId));
      this.items = snap.items.map((i, idx) => ({ itemId: i.itemId, track: tracks[idx] as Track }));
      this.sessionId = snap.sessionId;
      this.version = snap.version;
      this.mode = snap.mode;
      this.source = snap.source;
      this.currentIndex = snap.currentIndex;
      this.updatedAt = snap.updatedAt;
    }
    this.engine.onStatus((s) => this.onEngineStatus(s));
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
    this.setSync('in_sync', null);
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
    this.setSync('in_sync', null);
    return this.commit();
  }

  /** Explicit user decision: push Studio's plan back to HQPlayer. Does not start playback. */
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
    this.setSync('in_sync', null);
    return this.commit();
  }

  // --- internals ------------------------------------------------------------------------------

  private async exclusive(fn: () => Promise<QueueState>): Promise<QueueState> {
    this.busy += 1;
    try {
      return await fn();
    } finally {
      this.busy -= 1;
      if (this.busy === 0) this.onEngineStatus(this.engine.getStatus());
    }
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
    let next: QueueSyncState;
    let reason: string | null = null;
    let index = this.currentIndex;
    if (status.connection !== 'connected') {
      next = 'engine_offline';
    } else if (this.items.length === 0) {
      next = status.track ? 'unknown' : 'in_sync';
      if (status.track) reason = 'HQPlayer is playing something that Studio did not queue.';
    } else if (!status.track) {
      next =
        status.trackCount === 0
          ? 'out_of_sync'
          : this.sync.state === 'out_of_sync'
            ? 'out_of_sync'
            : 'in_sync';
      if (next === 'out_of_sync')
        reason =
          status.trackCount === 0
            ? "HQPlayer's playlist is empty, so it no longer matches Studio's queue (HQPlayer restarted, or the playlist was cleared elsewhere)."
            : this.sync.reason;
    } else {
      const engineIdx = status.trackIndex;
      const planned = engineIdx !== null ? this.items[engineIdx] : undefined;
      const matches = planned && status.track.studioTrackId === planned.track.id;
      const countOk = status.trackCount === null || status.trackCount === this.items.length;
      if (matches && countOk) {
        next = 'in_sync';
        index = engineIdx;
      } else {
        next = 'out_of_sync';
        reason = matches
          ? "HQPlayer's playlist length differs from Studio's queue (changed outside Studio)."
          : 'HQPlayer is playing a track that is not in Studio’s queue (changed outside Studio).';
      }
    }
    const changed =
      next !== this.sync.state || index !== this.currentIndex || reason !== this.sync.reason;
    if (!changed) return;
    this.currentIndex = index;
    this.setSync(next, reason);
    this.commit(next === 'engine_offline' || next === 'out_of_sync' ? false : true);
  }

  private setSync(state: QueueSyncState, reason: string | null): void {
    if (state !== this.sync.state || reason !== this.sync.reason) {
      this.sync = { state, reason, detectedAt: Date.now() };
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
