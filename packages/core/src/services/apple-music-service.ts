import { createHash } from 'node:crypto';
import {
  isLiveInputUri,
  LIVE_ARTWORK_ID,
  LIVE_LYRICS_TRACK_ID,
  liveArtworkId,
  type AppleMusicBlock,
  type AppleMusicCheck,
  type AppleMusicControlAction,
  type AppleMusicState,
  type EngineStatus,
  type LiveNowPlaying,
  type LivePlayedSong,
  type TransportAction,
  type UpdateAppleMusicSettingsRequest,
  type UpdateSoundGuardRequest,
} from '@hqps/contracts';
import { CapabilityUnavailableError, LiveHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { ConflictError, type LibraryContext } from '@hqps/library';
import type { EventHub } from '../event-hub';
import type { StudioLog } from '../logging/studio-log';
import type { EngineService, LiveSourceHook } from './engine-service';
import type { QueueService } from './queue-service';
import { SoundGuard } from './sound-guard';
import {
  isAppleMusicApp,
  looksLikeVirtualCable,
  type MediaAction,
  type MediaSession,
  type OpenTarget,
  type SystemAudioInfo,
  type WindowsMedia,
} from './windows-media';
import type { WindowsSound } from './windows-sound';

/** The switch on the Apple Music page (boolean, default false). */
export const APPLE_MUSIC_ENABLED_SETTING = 'appleMusic.enabled';
/** The user's own live-input URI, tried first (string or null). */
export const APPLE_MUSIC_URI_SETTING = 'appleMusic.preferredUri';
/** The live-input URI that worked last time (string or null). */
export const APPLE_MUSIC_LAST_URI_SETTING = 'appleMusic.lastUri';

/**
 * Tried after the user's own URI, the one that worked last time and whatever HQPlayer lists.
 * "default" = the input device chosen in HQPlayer Settings → Input; rate 0 is reported to mean
 * "detect the rate"; 2 = channels. Forum knowledge from HQPlayer 4/5 — not verified on 6.
 */
export const DEFAULT_LIVE_URIS = [
  'audio:default/0/2',
  'audio:default/44100/2',
  'audio:default/48000/2',
] as const;

const MAX_CANDIDATES = 6;
const MAX_HISTORY = 100;
const MAX_ONLINE_COVERS = 40;

/** Online cover lookup for a song that is not in the library (the cover service). */
export interface CoverLookup {
  /** Online covers are switched on in Settings. */
  enabled(): boolean;
  find(album: string, artist: string | null): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

const BLOCK_MESSAGES: Record<AppleMusicBlock, string> = {
  disabled: 'Turn the Apple Music source on first.',
  engine_offline: 'HQPlayer is not connected.',
  control_disabled: 'Studio is not allowed to control HQPlayer (Settings → HQPlayer).',
  not_supported: 'This engine cannot play a live input.',
  busy: 'Studio is still switching — wait a moment.',
};

/**
 * Apple Music through HQPlayer, from inside Studio.
 *
 * Start: stop HQPlayer, replace its playlist with ONE live-input entry and play it (the adapter
 * tries a few URIs and reports what HQPlayer said). While that plays, Studio shows what the
 * Apple Music app reports to Windows and its transport buttons drive that app. Stop: Studio's
 * own queue is put back in HQPlayer (not playing).
 *
 * Studio never opens, reads or stores Apple Music's audio: the sound goes from the Apple Music
 * app through a virtual cable into HQPlayer, entirely outside this program.
 */
export class AppleMusicService implements LiveSourceHook {
  private enabled = false;
  private preferredUri: string | null = null;
  private liveUri: string | null = null;
  private phase: AppleMusicState['phase'] = 'idle';
  private sessions: MediaSession[] = [];
  private mediaError: string | null = null;
  private lastStart: AppleMusicState['lastStart'] = null;
  private setup: AppleMusicState['setup'] = null;
  private audioInfo: SystemAudioInfo | null = null;
  private stopWatch: (() => void) | null = null;
  private artwork: { data: Buffer; mime: string } | null = null;
  private artworkHash: string | null = null;
  private artworkVersion = 0;
  private artworkKey = '';
  private artworkTimer: ReturnType<typeof setTimeout> | null = null;
  private artworkLateTimer: ReturnType<typeof setTimeout> | null = null;
  private artworkSource: 'windows' | 'online' | null = null;
  private artworkError: string | null = null;
  /** Online covers of this session by album and artist (null = looked up, nothing found). */
  private readonly onlineCovers = new Map<string, { data: Buffer; mime: string } | null>();
  private coverLookup: CoverLookup | null = null;
  /** The song the played list and the lyrics were last told about. */
  private songKey = '';
  private history: LivePlayedSong[] = [];
  private offStatus: (() => void) | null = null;
  /** Windows' default output: kept away from the DAC and the cable while the live input plays. */
  private readonly guard: SoundGuard;
  /** The first engine status after a start of Studio has been looked at (see `onEngineStatus`). */
  private guardSettled = false;

  constructor(
    private readonly engine: EngineService,
    private readonly queue: QueueService,
    private readonly hub: EventHub,
    private readonly settings: LibraryContext['settings'],
    private readonly media: WindowsMedia,
    private readonly log: StudioLog,
    sound: WindowsSound,
  ) {
    this.guard = new SoundGuard(sound, settings, log, () => this.publish());
  }

  init(): void {
    this.guard.init();
    this.enabled = this.settings.get<boolean>(APPLE_MUSIC_ENABLED_SETTING, false);
    this.preferredUri = this.settings.get<string | null>(APPLE_MUSIC_URI_SETTING, null);
    this.liveUri = this.settings.get<string | null>(APPLE_MUSIC_LAST_URI_SETTING, null);
    this.applyPolicy();
    this.engine.setLiveSource(this);
    this.offStatus = this.engine.onStatus(() => this.onEngineStatus());
    if (this.enabled) this.startWatching();
  }

  dispose(): void {
    this.offStatus?.();
    this.offStatus = null;
    this.stopWatching();
    this.engine.setLiveSource(null);
  }

  get(): AppleMusicState {
    return {
      supported: this.media.supported,
      simulated: this.media.simulated,
      enabled: this.enabled,
      phase: this.phase,
      liveUri: this.liveUri,
      preferredUri: this.preferredUri,
      nowPlaying: this.nowPlaying(),
      mediaError: this.mediaError,
      blocked: this.blocked(),
      lastStart: this.lastStart,
      setup: this.setup,
      artwork: {
        source: this.artwork ? this.artworkSource : null,
        error: this.artworkError,
        onlineEnabled: this.coverLookup?.enabled() ?? false,
      },
      history: this.history,
      guard: this.guard.get(),
    };
  }

  // --- Windows' default output (the sound guard) --------------------------------------------------

  /** Ask Windows which outputs exist and which is the default; read-only. */
  async refreshGuard(): Promise<AppleMusicState> {
    await this.guard.refresh();
    return this.get();
  }

  async updateGuard(patch: UpdateSoundGuardRequest): Promise<AppleMusicState> {
    await this.guard.update(patch);
    // Switched to automatic while the live input is already playing: act now, not next time.
    if (patch.auto === true && this.phase === 'active')
      await this.noteGuard(this.guard.liveStarted());
    return this.get();
  }

  /** Make the chosen everyday output Windows' default now. */
  async protectSound(): Promise<AppleMusicState> {
    await this.guard.protect();
    return this.get();
  }

  /** Put back the default output Studio replaced. */
  async restoreSound(): Promise<AppleMusicState> {
    await this.guard.restore();
    return this.get();
  }

  /** An automatic switch that failed must not pass unnoticed: the music is unprotected. */
  private async noteGuard(result: Promise<boolean>): Promise<void> {
    if (await result) return;
    this.hub.notice(
      'warning',
      'applemusic_guard_failed',
      'Studio could not switch Windows’ default sound output. The Apple Music page shows why.',
    );
  }

  async updateSettings(patch: UpdateAppleMusicSettingsRequest): Promise<AppleMusicState> {
    if (patch.preferredUri !== undefined) {
      this.preferredUri = patch.preferredUri;
      this.settings.set(APPLE_MUSIC_URI_SETTING, patch.preferredUri);
    }
    if (patch.enabled !== undefined && patch.enabled !== this.enabled) {
      if (!patch.enabled && this.phase === 'active') await this.stop();
      this.enabled = patch.enabled;
      this.settings.set(APPLE_MUSIC_ENABLED_SETTING, patch.enabled);
      this.applyPolicy();
      await this.engine.refreshCapabilities().catch(() => undefined);
      if (patch.enabled) this.startWatching();
      else this.stopWatching();
      this.log.info('apple-music', patch.enabled ? 'source enabled' : 'source disabled');
    }
    this.publish();
    return this.get();
  }

  /** Look at this PC and at HQPlayer; read-only. */
  async checkSetup(): Promise<AppleMusicState> {
    const checks: AppleMusicCheck[] = [];
    const raw = this.engine.getRawStatus();
    checks.push({
      id: 'windows',
      status: this.media.supported ? 'ok' : 'missing',
      detail: this.media.supported ? null : process.platform,
    });
    const connected = raw.connection === 'connected';
    checks.push({
      id: 'engine',
      status: connected && this.engine.can('queue.replace') ? 'ok' : 'missing',
      detail: !connected
        ? 'engine_offline'
        : this.engine.can('queue.replace')
          ? null
          : 'control_disabled',
    });

    let info: SystemAudioInfo | null = null;
    let infoError: string | null = null;
    if (this.media.supported) {
      try {
        info = await this.media.inspect();
        this.audioInfo = info;
      } catch (err) {
        infoError = (err as Error).message;
      }
    }
    const unknown = (id: AppleMusicCheck['id']): AppleMusicCheck => ({
      id,
      status: 'unknown',
      detail: infoError ?? info?.errors.join('; ') ?? null,
    });

    const session = this.apple();
    if (session) checks.push({ id: 'appleMusicApp', status: 'ok', detail: null });
    else if (!info?.appleMusic) checks.push(unknown('appleMusicApp'));
    else {
      checks.push({
        id: 'appleMusicApp',
        status: 'missing',
        detail: !info.appleMusic.installed
          ? 'not_installed'
          : info.appleMusic.running
            ? 'no_session'
            : 'not_running',
      });
    }

    if (!info?.devices) checks.push(unknown('virtualCable'));
    else {
      const cables = info.devices.filter(looksLikeVirtualCable);
      checks.push({
        id: 'virtualCable',
        status: cables.length > 0 ? 'ok' : 'missing',
        detail: cables.length > 0 ? cables.join(' · ') : null,
      });
    }
    checks.push({ id: 'cableFormat', status: 'manual', detail: null });
    if (!info || info.microphoneAccess === null) checks.push(unknown('microphoneAccess'));
    else {
      checks.push({
        id: 'microphoneAccess',
        status: info.microphoneAccess === 'allow' ? 'ok' : 'missing',
        detail: null,
      });
    }
    checks.push({ id: 'appRouting', status: 'manual', detail: null });

    let listed: string[] = [];
    let inputDetail: string | null = null;
    if (connected) {
      try {
        const inputs = await this.readInputs();
        listed = inputs.uris;
        inputDetail = [...inputs.uris, ...inputs.names].join(' · ') || null;
      } catch (err) {
        inputDetail = (err as Error).message;
      }
    }
    checks.push({ id: 'hqplayerInput', status: 'manual', detail: inputDetail });

    this.setup = { checkedAt: Date.now(), checks, listedInputs: listed };
    this.publish();
    return this.get();
  }

  /** Switch HQPlayer to the live input. Stops whatever HQPlayer is playing. */
  async start(): Promise<AppleMusicState> {
    const blocked = this.blocked();
    if (blocked) throw new ConflictError(BLOCK_MESSAGES[blocked]);
    if (this.phase === 'active') return this.get();
    this.engine.require('input.live');
    this.phase = 'starting';
    this.publish();
    const at = Date.now();
    // Before HQPlayer opens the input: other apps' sounds are out of the way from the first second.
    await this.noteGuard(this.guard.liveStarted());
    try {
      let listed: string[] = [];
      try {
        listed = (await this.readInputs()).uris;
      } catch {
        // HQPlayer would not list its inputs: the built-in URIs are still worth trying
      }
      const candidates = [
        ...new Set(
          [this.preferredUri, this.liveUri, ...listed, ...DEFAULT_LIVE_URIS].filter(isLiveInputUri),
        ),
      ].slice(0, MAX_CANDIDATES);
      this.queue.suspendForLive(() => this.released());
      // Several stop / clear / add / play rounds in a row: far longer than one command.
      const result = await this.engine.run(
        'playLiveInput',
        (a) => {
          if (!a.playLiveInput)
            throw new CapabilityUnavailableError('input.live', 'adapter has no live input');
          return a.playLiveInput(candidates);
        },
        6,
      );
      this.lastStart = { at, ok: result.uri !== null, attempts: result.attempts, error: null };
      if (result.uri) {
        this.phase = 'active';
        this.liveUri = result.uri;
        this.settings.set(APPLE_MUSIC_LAST_URI_SETTING, result.uri);
        this.log.info('apple-music', 'live input playing', {
          uri: result.uri,
          tried: result.attempts.length,
        });
      } else {
        this.phase = 'idle';
        this.log.warn('apple-music', 'no live input could be started', {
          tried: result.attempts.map((a) => a.uri).join(','),
        });
        await this.restoreQueue();
        this.hub.notice(
          'warning',
          'applemusic_start_failed',
          'HQPlayer could not open a live input. The Apple Music page shows what it answered.',
        );
        await this.guard.liveEnded();
      }
    } catch (err) {
      this.phase = 'idle';
      this.lastStart = { at, ok: false, attempts: [], error: (err as Error).message };
      this.log.warn('apple-music', 'start failed', { error: (err as Error).name });
      await this.restoreQueue().catch(() => undefined);
      await this.guard.liveEnded();
      throw err;
    } finally {
      this.publish();
      this.engine.republish();
    }
    return this.get();
  }

  /** Leave the live input: Studio's queue goes back into HQPlayer, not playing. */
  async stop(): Promise<AppleMusicState> {
    if (this.phase !== 'active') return this.get();
    this.phase = 'stopping';
    this.publish();
    try {
      const session = this.apple();
      // Otherwise Apple Music would go on playing silently into the cable.
      if (session?.status === 'Playing')
        await this.media.control(session.app, 'pause').catch(() => false);
      await this.restoreQueue();
      this.log.info('apple-music', 'live input stopped');
    } finally {
      await this.guard.liveEnded();
      this.phase = 'idle';
      this.queue.resumeFromLive();
      this.publish();
      this.engine.republish();
    }
    return this.get();
  }

  /** Buttons on the Apple Music page; the player bar goes through `transport` below. */
  async control(action: AppleMusicControlAction): Promise<AppleMusicState> {
    const session = this.requireSession();
    const resolved: MediaAction =
      action === 'toggle' ? (session.status === 'Playing' ? 'pause' : 'play') : action;
    await this.send(session.app, resolved);
    return this.get();
  }

  async open(target: OpenTarget): Promise<void> {
    if (!this.media.supported) throw new ConflictError('Only available on Windows.');
    await this.media.open(target, this.audioInfo?.appleMusic?.familyName ?? null);
  }

  /** The cover Apple Music publishes, for `/artwork/live-apple-music-<n>`. */
  artworkFor(id: string): { data: Buffer; mime: string } | null {
    return LIVE_ARTWORK_ID.test(id) ? this.artwork : null;
  }

  /** Where a cover comes from when Windows provides none (the online cover sources, opt-in). */
  setCoverLookup(lookup: CoverLookup | null): void {
    this.coverLookup = lookup;
  }

  /** The song the live input is carrying right now, for the lyrics lookup (null when none). */
  liveTrack(): {
    key: string;
    title: string;
    artist: string;
    album: string;
    durationMs: number | null;
  } | null {
    if (this.phase !== 'active') return null;
    const s = this.apple();
    if (!s || !s.title.trim()) return null;
    return {
      key: [s.title, s.artist, s.album].join('\u0001').toLowerCase(),
      title: s.title,
      artist: s.artist,
      album: s.album,
      durationMs: s.durationMs,
    };
  }

  // --- LiveSourceHook ---------------------------------------------------------------------------

  decorate(status: EngineStatus): EngineStatus {
    if (this.phase !== 'active' || status.connection !== 'connected') return status;
    const uri = status.track?.uri ?? null;
    if (uri !== null && !isLiveInputUri(uri)) return status; // no longer the live input
    const np = this.nowPlaying();
    const now = Date.now();
    let positionMs = 0;
    if (np && np.positionMs !== null) {
      const running = np.playback === 'playing' && np.positionAt !== null;
      positionMs = np.positionMs + (running ? Math.max(0, now - (np.positionAt as number)) : 0);
      // What is audible left Apple Music one HQPlayer output delay ago.
      positionMs = Math.max(0, positionMs - (status.outputDelayMs ?? 0));
      if (np.durationMs !== null) positionMs = Math.min(positionMs, np.durationMs);
    }
    const transport =
      status.transport === 'playing' && np && np.playback !== 'playing'
        ? 'paused'
        : status.transport;
    return {
      ...status,
      transport,
      positionMs,
      durationMs: np?.durationMs ?? null,
      observedAt: now,
      track: {
        index: status.track?.index ?? status.trackIndex ?? 0,
        uri: uri ?? this.liveUri,
        title: np?.title ?? 'Apple Music',
        artist: np?.artist ?? null,
        album: np?.album ?? null,
        durationMs: np?.durationMs ?? null,
        studioTrackId: null,
        artworkId: this.artwork ? liveArtworkId(this.artworkVersion) : null,
        source: 'apple-music',
      },
    };
  }

  async transport(action: Exclude<TransportAction, 'toggle'>, raw: EngineStatus): Promise<boolean> {
    if (this.phase !== 'active') return false;
    if (action === 'stop') {
      await this.stop();
      return true;
    }
    const session = this.apple();
    if (action === 'play') {
      // The live entry is still HQPlayer's playlist but HQPlayer itself was stopped.
      if (raw.transport !== 'playing') await this.engine.run('play', (a) => a.play());
      if (session) await this.send(session.app, 'play');
      return true;
    }
    // Without a media session Studio cannot reach Apple Music: let HQPlayer pause the input.
    if (!session) {
      if (action === 'pause') return false;
      throw new ConflictError('Windows does not show Apple Music as a player right now.');
    }
    await this.send(session.app, action);
    return true;
  }

  // --- internals --------------------------------------------------------------------------------

  private applyPolicy(): void {
    const adapter = this.engine.adapter;
    if (adapter instanceof LiveHQPlayerAdapter) {
      adapter.setPolicy({ ...adapter.getPolicy(), liveInputEnabled: this.enabled });
    }
  }

  private blocked(): AppleMusicBlock | null {
    if (!this.enabled) return 'disabled';
    if (this.phase === 'starting' || this.phase === 'stopping') return 'busy';
    if (this.engine.getRawStatus().connection !== 'connected') return 'engine_offline';
    if (!this.engine.can('input.live'))
      return this.engine.can('queue.replace') ? 'not_supported' : 'control_disabled';
    return null;
  }

  private apple(): MediaSession | null {
    return this.sessions.find((s) => isAppleMusicApp(s.app)) ?? null;
  }

  private requireSession(): MediaSession {
    const session = this.apple();
    if (!session)
      throw new ConflictError('Windows does not show Apple Music as a player right now.');
    return session;
  }

  private nowPlaying(): LiveNowPlaying | null {
    const s = this.apple();
    if (!s) return null;
    const playback =
      s.status === 'Playing'
        ? 'playing'
        : s.status === 'Paused'
          ? 'paused'
          : s.status === 'Stopped' || s.status === 'Closed'
            ? 'stopped'
            : 'other';
    return {
      app: s.app,
      playback,
      title: s.title || null,
      artist: s.artist || null,
      album: s.album || null,
      hasArtwork: this.artwork !== null,
      artworkVersion: this.artworkVersion,
      positionMs: s.positionMs,
      positionAt: s.positionAt,
      durationMs: s.durationMs,
      controls: s.controls,
    };
  }

  private readInputs(): Promise<{ uris: string[]; names: string[] }> {
    return this.engine.run('getLiveInputs', async (a) =>
      a.getLiveInputs ? a.getLiveInputs() : { uris: [], names: [] },
    );
  }

  private async send(app: string, action: MediaAction): Promise<void> {
    let ok: boolean;
    try {
      ok = await this.media.control(app, action);
    } catch (err) {
      throw new ConflictError(`Windows could not reach Apple Music: ${(err as Error).message}`);
    }
    if (!ok) throw new ConflictError(`Apple Music did not accept "${action}".`);
  }

  /** Put Studio's plan back into HQPlayer (stopped), or just empty HQPlayer's playlist. */
  private async restoreQueue(): Promise<void> {
    if (this.queue.get().items.length > 0) {
      await this.queue.takeover();
      return;
    }
    if (this.engine.can('queue.replace')) {
      await this.engine.run('clearQueue', async (a) => {
        if (a.clearQueue) await a.clearQueue();
        else await a.stop();
      });
    }
    this.queue.resumeFromLive();
  }

  /** The live input ended without `stop()`: Studio loaded a queue, or HQPlayer moved on. */
  private released(): void {
    if (this.phase !== 'active' && this.phase !== 'starting') return;
    this.phase = 'idle';
    this.queue.resumeFromLive();
    this.log.info('apple-music', 'live input replaced');
    void this.guard.liveEnded();
    this.publish();
    queueMicrotask(() => this.engine.republish());
  }

  private onEngineStatus(): void {
    const raw = this.engine.getRawStatus();
    if (raw.connection !== 'connected') return;
    const uri = raw.track?.uri ?? null;
    if (this.phase === 'active') {
      if ((uri !== null && !isLiveInputUri(uri)) || raw.trackCount === 0) this.released();
    } else if (this.phase === 'idle' && this.enabled && isLiveInputUri(uri)) {
      // HQPlayer is already on a live input (Studio was restarted, or it was started there).
      this.phase = 'active';
      this.liveUri = uri;
      this.queue.suspendForLive(() => this.released());
      void this.noteGuard(this.guard.liveStarted());
      this.publish();
      queueMicrotask(() => this.engine.republish());
    }
    if (!this.guardSettled) {
      this.guardSettled = true;
      // Studio was closed while it held Windows' default output and the live input has ended
      // since: put Windows back now (automatic mode only; otherwise the page offers the button).
      if (this.phase === 'idle') void this.guard.liveEnded();
    }
  }

  private startWatching(): void {
    if (this.stopWatch || !this.media.supported) return;
    this.stopWatch = this.media.watch(
      (sessions) => this.onSessions(sessions),
      (message) => {
        if (message === this.mediaError) return;
        this.mediaError = message;
        if (message) this.log.warn('apple-music', 'Windows media query failed');
        this.publish();
      },
    );
  }

  private stopWatching(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    if (this.artworkTimer) clearTimeout(this.artworkTimer);
    if (this.artworkLateTimer) clearTimeout(this.artworkLateTimer);
    this.artworkTimer = null;
    this.artworkLateTimer = null;
    this.artworkSource = null;
    this.artworkError = null;
    this.sessions = [];
    this.mediaError = null;
    this.artwork = null;
    this.artworkHash = null;
    this.artworkKey = '';
  }

  private onSessions(sessions: MediaSession[]): void {
    this.sessions = sessions;
    const s = this.apple();
    const key = s ? [s.app, s.title, s.artist, s.album, s.hasThumbnail].join('\u0001') : '';
    if (key !== this.artworkKey) {
      this.artworkKey = key;
      void this.refreshArtwork(key);
      // Apps often publish the cover a moment after the title — and some swap the previous
      // song's picture for the new one later still.
      if (this.artworkTimer) clearTimeout(this.artworkTimer);
      if (this.artworkLateTimer) clearTimeout(this.artworkLateTimer);
      this.artworkTimer = setTimeout(() => void this.refreshArtwork(key), 2500);
      this.artworkLateTimer = setTimeout(() => void this.refreshArtwork(key), 8000);
    }
    this.publish();
    if (this.phase === 'active') this.engine.republish();
  }

  private async refreshArtwork(key: string): Promise<void> {
    const s = this.apple();
    let image: { data: Buffer; mime: string } | null = null;
    let source: 'windows' | 'online' | null = null;
    let error: string | null = null;
    if (s?.hasThumbnail) {
      try {
        image = await this.media.artwork(s.app);
        if (image) source = 'windows';
      } catch (err) {
        // Shown on the page: a cover that Windows has but will not hand over is a fault to fix.
        error = (err as Error).message.slice(0, 400);
      }
    }
    // No cover from Windows: look the album up online, if the user turned online covers on.
    if (!image && s && s.album.trim() && this.coverLookup?.enabled()) {
      const cacheKey = `${s.album}\u0001${s.artist}`.toLowerCase();
      let found = this.onlineCovers.get(cacheKey);
      if (found === undefined) {
        try {
          const hit = await this.coverLookup.find(s.album, s.artist || null);
          found = hit ? { data: Buffer.from(hit.bytes), mime: hit.mime } : null;
        } catch {
          found = null; // an outage: no cover this time, asked again with the next song
        }
        this.onlineCovers.set(cacheKey, found);
        if (this.onlineCovers.size > MAX_ONLINE_COVERS) {
          const oldest = this.onlineCovers.keys().next().value;
          if (oldest !== undefined) this.onlineCovers.delete(oldest);
        }
      }
      if (found) {
        image = found;
        source = 'online';
      }
    }
    if (key !== this.artworkKey) return; // the track changed while Windows answered
    const hash = image ? createHash('sha1').update(image.data).digest('hex') : null;
    const changed = hash !== this.artworkHash;
    if (!changed && error === this.artworkError && source === this.artworkSource) return;
    if (error && error !== this.artworkError)
      this.log.warn('apple-music', 'Windows would not hand over the cover');
    this.artworkError = error;
    this.artworkSource = source;
    if (changed) {
      this.artwork = image;
      this.artworkHash = hash;
      this.artworkVersion += 1;
    }
    this.publish();
    if (this.phase === 'active') this.engine.republish();
  }

  /**
   * Keep the played list in step with the song, and tell lyric views when the song changes.
   * Apple Music's own "Playing Next" cannot be read from outside the app; the list of what was
   * played since Start is what Studio can show. It lives in memory only.
   */
  private syncSong(): void {
    if (this.phase !== 'active') {
      if (this.songKey === '' && this.history.length === 0) return;
      this.songKey = '';
      this.history = [];
      this.hub.publish({ type: 'lyrics.changed', trackId: LIVE_LYRICS_TRACK_ID });
      return;
    }
    const live = this.liveTrack();
    const key = live?.key ?? '';
    if (key === this.songKey) return;
    this.songKey = key;
    if (live) {
      this.history = [
        ...this.history,
        {
          title: live.title,
          artist: live.artist || null,
          album: live.album || null,
          startedAt: Date.now(),
        },
      ].slice(-MAX_HISTORY);
    }
    this.hub.publish({ type: 'lyrics.changed', trackId: LIVE_LYRICS_TRACK_ID });
  }

  private publish(): void {
    this.syncSong();
    this.hub.publish({ type: 'applemusic.changed', state: this.get() });
  }
}
