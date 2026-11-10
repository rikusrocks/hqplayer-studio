import {
  ENGINE_CAPABILITY_KEYS,
  formatLabel,
  type AudioFormat,
  type CapabilityEntry,
  type DspState,
  type EngineCapabilities,
  type EngineCapabilityKey,
  type EngineStatus,
  type RepeatMode,
} from '@hqps/contracts';
import type {
  EngineQueueSnapshot,
  HQPlayerAdapter,
  PlayableTrack,
  ReplaceQueueOptions,
  StatusListener,
} from '../adapter';
import { EngineCommandError, EngineTimeoutError, EngineUnavailableError } from '../errors';

export interface MockClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

/** Resolves timer functions lazily so test fake timers are honoured. */
export const systemClock: MockClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
};

export interface MockAdapterOptions {
  /** Simulated command round-trip latency. 0 = resolve on the next microtask. */
  latencyMs?: number;
  /** How often the simulated engine pushes status while playing. */
  tickMs?: number;
  clock?: MockClock;
  initialVolumeDb?: number;
}

type MockTransport = 'playing' | 'paused' | 'stopped';

const VOLUME_MIN = -60;
const VOLUME_MAX = 0;
const DSD512_44K = 22_579_200;
const DSD512_48K = 24_576_000;

const UNSUPPORTED_IN_MOCK: Partial<Record<EngineCapabilityKey, string>> = {
  'playlist.server': 'Server-side playlists are not simulated; Studio owns saved playlists.',
  'dsp.write':
    'DSP changes are not simulated. On a real engine this stays disabled until verified.',
  'library.native': 'HQPlayer built-in library browsing is not simulated.',
};

/**
 * A deterministic, in-memory stand-in for HQPlayer Desktop 6 used on the Mac dev machine, in CI
 * and in demo builds. It mirrors the *domain* behaviour Studio relies on (queue, transport,
 * position, format/DSP summary, disconnects, external changes) — it is NOT evidence that the real
 * engine behaves the same way. Every capability it reports is marked `simulated`.
 */
export class MockHQPlayerAdapter implements HQPlayerAdapter {
  readonly kind = 'mock' as const;

  private connected = false;
  /** Simulates HQPlayer being closed: connection attempts fail until simulateReconnect(). */
  private offline = false;
  private queue: PlayableTrack[] = [];
  private index: number | null = null;
  private transport: MockTransport = 'stopped';
  /** Position at `anchorAt` (or the frozen position while paused/stopped). */
  private positionMs = 0;
  private anchorAt = 0;
  private volumeDb: number;
  private albumMode = false;
  private repeat: RepeatMode = 'none';
  private random = false;
  private serial = 0;
  private pendingFailure: Error | null = null;
  private ticker: unknown = null;
  private readonly listeners = new Set<StatusListener>();
  private readonly clock: MockClock;
  private readonly latencyMs: number;
  private readonly tickMs: number;

  constructor(options: MockAdapterOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.latencyMs = options.latencyMs ?? 25;
    this.tickMs = options.tickMs ?? 1000;
    this.volumeDb = options.initialVolumeDb ?? -12;
  }

  // --- lifecycle --------------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.delay();
    if (this.offline) throw new EngineUnavailableError('Mock HQPlayer is not running (simulated)');
    this.connected = true;
    this.ensureTicker();
    this.emit();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.stopTicker();
    this.emit();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- test / demo hooks -------------------------------------------------------------------------

  /** The control connection drops, but the engine keeps playing (as a real HQPlayer would). */
  simulateDisconnect(): void {
    this.connected = false;
    this.offline = true;
    this.emit();
  }

  simulateReconnect(): void {
    this.offline = false;
    this.connected = true;
    this.ensureTicker();
    this.emit();
  }

  /** Someone changed the queue from the native HQPlayer UI or another remote. */
  simulateExternalChange(): void {
    this.queue = [
      {
        studioTrackId: 'external',
        uri: 'E:\\Other Music\\Unknown Artist\\Imported Elsewhere.flac',
        title: 'Imported Elsewhere',
        artist: 'Unknown Artist',
        album: 'Changed in native HQPlayer',
        durationMs: 241_000,
        format: { sampleRate: 192_000, bitDepth: 24, channels: 2, isDsd: false },
      },
    ];
    this.index = 0;
    this.setPosition(0);
    this.transport = 'playing';
    this.anchorAt = this.clock.now();
    this.emit();
  }

  /** Make the next command fail (default: an ACK timeout). */
  failNextCommand(error?: Error): void {
    this.pendingFailure = error ?? new EngineTimeoutError('(simulated)', 5000);
  }

  // --- status -----------------------------------------------------------------------------------

  async getCapabilities(): Promise<EngineCapabilities> {
    const items = {} as Record<EngineCapabilityKey, CapabilityEntry>;
    for (const key of ENGINE_CAPABILITY_KEYS) {
      const unsupported = UNSUPPORTED_IN_MOCK[key];
      items[key] = unsupported
        ? {
            status: 'unsupported',
            usable: false,
            evidence: 'MockHQPlayerAdapter',
            note: unsupported,
          }
        : {
            status: 'simulated',
            usable: true,
            evidence: 'MockHQPlayerAdapter',
            note: 'Simulated only — not evidence of real HQPlayer Desktop 6 support.',
          };
    }
    return {
      adapter: 'mock',
      engine: {
        product: 'HQPlayer Desktop (mock)',
        version: '6.x-mock',
        platform: 'mock',
        engine: null,
      },
      items,
    };
  }

  async getStatus(): Promise<EngineStatus> {
    return this.snapshot();
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- transport --------------------------------------------------------------------------------

  play(): Promise<void> {
    return this.command('Play', () => {
      if (this.queue.length === 0) throw new EngineCommandError('Play', 'playlist is empty');
      if (this.index === null) this.index = 0;
      if (this.transport !== 'playing') {
        this.transport = 'playing';
        this.anchorAt = this.clock.now();
      }
    });
  }

  pause(): Promise<void> {
    return this.command('Pause', () => {
      if (this.transport === 'playing') {
        this.positionMs = this.currentPosition();
        this.transport = 'paused';
      } else if (this.transport === 'paused') {
        // HQPlayer's Pause toggles; mirror that so "pause while paused" resumes.
        this.transport = 'playing';
        this.anchorAt = this.clock.now();
      }
    });
  }

  stop(): Promise<void> {
    return this.command('Stop', () => {
      this.transport = 'stopped';
      this.setPosition(0);
    });
  }

  next(): Promise<void> {
    return this.command('Next', () => {
      if (this.index === null || this.queue.length === 0) return;
      if (this.index < this.queue.length - 1) this.moveTo(this.index + 1);
      else if (this.repeat === 'all') this.moveTo(0);
    });
  }

  previous(): Promise<void> {
    return this.command('Previous', () => {
      if (this.index === null) return;
      if (this.currentPosition() > 3000 || this.index === 0) this.setPosition(0);
      else this.moveTo(this.index - 1);
    });
  }

  seek(positionMs: number): Promise<void> {
    return this.command('Seek', () => {
      const track = this.currentTrack();
      if (!track) throw new EngineCommandError('Seek', 'no current track');
      const max = track.durationMs ?? Number.MAX_SAFE_INTEGER;
      this.setPosition(Math.max(0, Math.min(positionMs, max - 250)));
    });
  }

  setVolume(volumeDb: number): Promise<void> {
    return this.command('Volume', () => {
      this.volumeDb = Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, Math.round(volumeDb * 2) / 2));
    });
  }

  // --- queue ------------------------------------------------------------------------------------

  replaceQueue(items: PlayableTrack[], options: ReplaceQueueOptions): Promise<void> {
    return this.command('PlaylistAdd(clear)', () => {
      if (items.length === 0) throw new EngineCommandError('PlaylistAdd', 'no items');
      this.queue = [...items];
      this.albumMode = options.albumMode;
      this.index = Math.max(0, Math.min(options.startIndex, items.length - 1));
      this.setPosition(0);
      this.transport = options.autoplay ? 'playing' : 'stopped';
      this.anchorAt = this.clock.now();
    });
  }

  appendToQueue(items: PlayableTrack[]): Promise<void> {
    return this.command('PlaylistAdd(queued)', () => {
      this.queue.push(...items);
      if (this.index === null && this.queue.length > 0) this.index = 0;
    });
  }

  insertNext(items: PlayableTrack[]): Promise<void> {
    return this.command('PlaylistAdd(next)', () => {
      const at = this.index === null ? 0 : this.index + 1;
      this.queue.splice(at, 0, ...items);
      if (this.index === null) this.index = 0;
    });
  }

  removeFromQueue(engineIndex: number): Promise<void> {
    return this.command('PlaylistRemove', () => {
      if (engineIndex < 0 || engineIndex >= this.queue.length) {
        throw new EngineCommandError('PlaylistRemove', 'index out of range');
      }
      this.queue.splice(engineIndex, 1);
      if (this.index === null) return;
      if (this.queue.length === 0) {
        this.index = null;
        this.transport = 'stopped';
        this.setPosition(0);
      } else if (engineIndex < this.index) {
        this.index -= 1;
      } else if (engineIndex === this.index) {
        if (this.index >= this.queue.length) {
          this.index = this.queue.length - 1;
          this.transport = 'stopped';
        }
        this.setPosition(0);
      }
    });
  }

  clearQueue(): Promise<void> {
    return this.command('PlaylistClear', () => {
      this.queue = [];
      this.index = null;
      this.transport = 'stopped';
      this.setPosition(0);
    });
  }

  selectIndex(index: number, autoplay: boolean): Promise<void> {
    return this.command('SelectTrack', () => {
      if (index < 0 || index >= this.queue.length) {
        throw new EngineCommandError('SelectTrack', 'index out of range');
      }
      this.moveTo(index);
      if (autoplay) {
        this.transport = 'playing';
        this.anchorAt = this.clock.now();
      }
    });
  }

  async getEngineQueue(): Promise<EngineQueueSnapshot> {
    this.assertConnected();
    await this.delay();
    return {
      albumMode: this.albumMode,
      currentIndex: this.index,
      currentMatchedBy: this.index === null ? 'none' : 'index',
      statusTrackBase: null,
      entries: this.queue.map((t, index) => ({
        index,
        uri: t.uri,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationMs: t.durationMs,
      })),
    };
  }

  setRepeat(mode: RepeatMode): Promise<void> {
    return this.command('SetRepeat', () => {
      this.repeat = mode;
    });
  }

  setRandom(on: boolean): Promise<void> {
    return this.command('SetRandom', () => {
      this.random = on;
    });
  }

  async getDspState(): Promise<DspState> {
    this.assertConnected();
    const rate = this.outputRate();
    return {
      modes: [
        { index: 0, name: '[source]', value: -1 },
        { index: 1, name: 'PCM', value: 0 },
        { index: 2, name: 'SDM', value: 1 },
      ],
      filters: [
        { index: 0, name: 'poly-sinc-gauss-xla', value: 0 },
        { index: 1, name: 'sinc-M', value: 1 },
      ],
      shapers: [
        { index: 0, name: 'ASDM7EC-ul', value: 0 },
        { index: 1, name: 'ASDM5EC', value: 1 },
      ],
      rates: [
        { index: 0, rate: DSD512_44K },
        { index: 1, rate: DSD512_48K },
      ],
      current: { mode: 'SDM', filter: 'poly-sinc-gauss-xla', shaper: 'ASDM7EC-ul', rate },
      writable: false,
    };
  }

  /** Release timers (tests, shutdown). */
  dispose(): void {
    this.stopTicker();
    this.listeners.clear();
  }

  // --- internals --------------------------------------------------------------------------------

  private async command(name: string, mutate: () => void): Promise<void> {
    this.assertConnected();
    await this.delay();
    this.assertConnected();
    if (this.pendingFailure) {
      const err = this.pendingFailure;
      this.pendingFailure = null;
      throw err instanceof EngineTimeoutError && err.command === '(simulated)'
        ? new EngineTimeoutError(name, 5000)
        : err;
    }
    mutate();
    this.emit();
  }

  private assertConnected(): void {
    if (!this.connected) throw new EngineUnavailableError('Mock HQPlayer is disconnected');
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => this.clock.setTimeout(resolve, this.latencyMs));
  }

  private currentTrack(): PlayableTrack | null {
    return this.index === null ? null : (this.queue[this.index] ?? null);
  }

  private currentPosition(): number {
    if (this.transport !== 'playing') return this.positionMs;
    return this.positionMs + Math.max(0, this.clock.now() - this.anchorAt);
  }

  private setPosition(ms: number): void {
    this.positionMs = ms;
    this.anchorAt = this.clock.now();
  }

  private moveTo(index: number): void {
    this.index = index;
    this.setPosition(0);
  }

  private ensureTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = this.clock.setInterval(() => this.tick(), this.tickMs);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    this.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Advance playback like an engine would and push a status update while playing. */
  tick(): void {
    if (this.transport !== 'playing') return;
    const track = this.currentTrack();
    if (!track) return;
    const duration = track.durationMs;
    if (duration !== null && this.currentPosition() >= duration) {
      const overflow = this.currentPosition() - duration;
      if (this.repeat === 'single') {
        this.setPosition(overflow);
      } else if (this.index !== null && this.index < this.queue.length - 1) {
        this.moveTo(this.index + 1);
        this.setPosition(Math.min(overflow, 1000));
      } else if (this.repeat === 'all' && this.queue.length > 0) {
        this.moveTo(0);
      } else {
        this.transport = 'stopped';
        this.setPosition(0);
      }
    }
    if (this.connected) this.emit();
  }

  private outputRate(): number {
    const f = this.currentTrack()?.format;
    if (!f?.sampleRate) return DSD512_44K;
    const family48 = f.isDsd ? f.sampleRate % 3_072_000 === 0 : f.sampleRate % 48_000 === 0;
    return family48 ? DSD512_48K : DSD512_44K;
  }

  private snapshot(): EngineStatus {
    const track = this.currentTrack();
    const connected = this.connected;
    let input: AudioFormat | null = null;
    if (track?.format) {
      const kind = track.format.isDsd ? 'DSD' : 'PCM';
      input = {
        kind,
        sampleRate: track.format.sampleRate,
        bits: track.format.isDsd ? 1 : track.format.bitDepth,
        channels: track.format.channels,
        label: formatLabel(
          kind,
          track.format.sampleRate,
          track.format.isDsd ? null : track.format.bitDepth,
        ),
      };
    }
    const outRate = this.outputRate();
    const playingSomething = track !== null && this.transport !== 'stopped';
    return {
      connection: connected ? 'connected' : 'disconnected',
      transport: connected ? this.transport : 'unknown',
      positionMs: connected ? Math.round(this.currentPosition()) : 0,
      outputDelayMs: null,
      durationMs: connected ? (track?.durationMs ?? null) : null,
      track:
        connected && track
          ? {
              index: this.index,
              uri: track.uri,
              title: track.title,
              artist: track.artist,
              album: track.album,
              durationMs: track.durationMs,
              studioTrackId: null,
            }
          : null,
      trackIndex: connected ? this.index : null,
      trackCount: connected ? this.queue.length : null,
      volumeDb: connected ? this.volumeDb : null,
      volumeRange: connected ? { min: VOLUME_MIN, max: VOLUME_MAX } : null,
      input: connected ? input : null,
      output:
        connected && playingSomething
          ? {
              kind: 'DSD',
              sampleRate: outRate,
              bits: 1,
              channels: 2,
              label: formatLabel('DSD', outRate, null),
            }
          : null,
      dsp: connected
        ? { mode: 'SDM', filter: 'poly-sinc-gauss-xla', shaper: 'ASDM7EC-ul', outputRate: outRate }
        : null,
      repeat: connected ? this.repeat : null,
      random: connected ? this.random : null,
      albumMode: connected ? this.albumMode : null,
      observedAt: this.clock.now(),
      serial: this.serial,
      lastError: connected ? null : 'Mock HQPlayer is disconnected',
    };
  }

  private emit(): void {
    this.serial += 1;
    const status = this.snapshot();
    for (const l of this.listeners) l(status);
  }
}
