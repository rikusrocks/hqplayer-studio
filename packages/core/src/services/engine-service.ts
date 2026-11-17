import {
  canUse,
  disconnectedStatus,
  type EngineCapabilities,
  type EngineCapabilityKey,
  type EngineStatus,
  type TransportAction,
} from '@hqps/contracts';
import {
  CapabilityUnavailableError,
  EngineTimeoutError,
  EngineUnavailableError,
  type HQPlayerAdapter,
} from '@hqps/hqplayer-adapter';
import type { LibraryRepository } from '@hqps/library';
import type { EventHub } from '../event-hub';

export interface EngineServiceOptions {
  /** Backstop timeout around every adapter call. Never followed by an automatic retry. */
  commandTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

type StatusListener = (status: EngineStatus) => void;

/** Commands that only read from HQPlayer (everything else may change what it plays). */
export const READ_ONLY_ENGINE_COMMANDS: ReadonlySet<string> = new Set([
  'getDspState',
  'getEngineQueue',
]);

/** One engine command Studio sent (for the log and the soak-test recorder). */
export interface EngineCommandEvent {
  id: number;
  label: string;
  phase: 'start' | 'end';
  at: number;
  /** Set on `end`. */
  ok?: boolean;
  durationMs?: number;
  /** Error class name and message on failure. */
  errorName?: string;
  error?: string;
}

type CommandListener = (event: EngineCommandEvent) => void;

/**
 * A live source (Apple Music through a live input). While HQPlayer plays such an input it only
 * sees an endless stream, so what is playing — and playing / paused — is whatever the other app
 * reports. The source rewrites the published status accordingly and takes the transport buttons,
 * which then drive that app instead of HQPlayer.
 */
export interface LiveSourceHook {
  /** Return the status to publish (the same object when the source is not active). */
  decorate(status: EngineStatus): EngineStatus;
  /** Handle a transport action; false = not active, let HQPlayer handle it. */
  transport(action: Exclude<TransportAction, 'toggle'>, status: EngineStatus): Promise<boolean>;
}

/**
 * Supervises the HQPlayer adapter:
 *  - serialises every engine command (one at a time, in arrival order, across Desktop + Web);
 *  - applies a timeout and reports it — never retries a write (avoids double-queued tracks);
 *  - republishes engine-reported status (HQPlayer is the authority on playback state);
 *  - reconnects with backoff, and after reconnecting only re-reads state: it never sends Play,
 *    volume or DSP changes on its own.
 */
/** Largest volume increase applied by one command (decreases are not limited). */
export const MAX_VOLUME_STEP_DB = 12;

export class EngineService {
  private status: EngineStatus = disconnectedStatus();
  private capabilities: EngineCapabilities | null = null;
  private serial = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<StatusListener>();
  private readonly commandListeners = new Set<CommandListener>();
  private commandSerial = 0;
  private lastUri: string | null = null;
  private lastUriTrackId: string | null = null;
  private lastUriArtworkId: string | null = null;
  private liveSource: LiveSourceHook | null = null;
  /** The last status as HQPlayer reported it (before a live source rewrote it). */
  private raw: EngineStatus = disconnectedStatus();

  constructor(
    readonly adapter: HQPlayerAdapter,
    private readonly hub: EventHub,
    private readonly library: LibraryRepository,
    private readonly options: EngineServiceOptions = {},
  ) {
    // A scan can add the file HQPlayer is playing: re-resolve it instead of keeping a stale
    // "not in library" answer (which made the queue look permanently out of sync).
    hub.subscribe((event) => {
      if (event.type === 'library.changed') this.remapCurrentTrack();
    });
  }

  private remapCurrentTrack(): void {
    this.lastUri = null;
    const track = this.raw.track;
    if (!track?.uri) return;
    this.resolveUri(track.uri);
    if (
      this.lastUriTrackId !== track.studioTrackId ||
      this.lastUriArtworkId !== (track.artworkId ?? null)
    ) {
      this.publish({
        ...this.raw,
        track: { ...track, studioTrackId: this.lastUriTrackId, artworkId: this.lastUriArtworkId },
      });
    }
  }

  /** Map HQPlayer's file to a library track (+ its artwork); cached per URI. */
  private resolveUri(uri: string): void {
    if (uri === this.lastUri) return;
    this.lastUri = uri;
    this.lastUriTrackId = this.library.findTrackIdBySource(uri);
    this.lastUriArtworkId = null;
    if (this.lastUriTrackId) {
      try {
        this.lastUriArtworkId = this.library.getTrack(this.lastUriTrackId).artworkId;
      } catch {
        // removed meanwhile
      }
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const offStatus = this.adapter.subscribeStatus((s) => this.onAdapterStatus(s));
    const offCaps = this.adapter.subscribeCapabilities?.(
      () => void this.refreshCapabilities().catch(() => undefined),
    );
    this.unsubscribe = () => {
      offStatus();
      offCaps?.();
    };
    await this.tryConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.unsubscribe?.();
    await this.adapter.disconnect().catch(() => undefined);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  async getCapabilities(): Promise<EngineCapabilities> {
    if (!this.capabilities) await this.refreshCapabilities();
    return this.capabilities as EngineCapabilities;
  }

  /** Synchronous view used for request-time capability checks. */
  can(key: EngineCapabilityKey): boolean {
    return canUse(this.capabilities, key);
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observe the commands Studio sends (start and end of each). */
  onCommand(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  private emitCommand(event: EngineCommandEvent): void {
    for (const l of this.commandListeners) {
      try {
        l(event);
      } catch {
        // observers never break a command
      }
    }
  }

  setLiveSource(hook: LiveSourceHook | null): void {
    this.liveSource = hook;
    this.republish();
  }

  /** Publish the last engine status again (what a live source reports has changed). */
  republish(): void {
    this.publish(this.raw);
  }

  /** The last status exactly as HQPlayer reported it. */
  getRawStatus(): EngineStatus {
    return this.raw;
  }

  /**
   * Run an engine command exclusively, with a timeout. `timeoutScale` stretches the timeout for
   * the few commands that are several ordinary ones in a row (trying live inputs one by one).
   */
  run<T>(
    label: string,
    fn: (adapter: HQPlayerAdapter) => Promise<T>,
    timeoutScale = 1,
  ): Promise<T> {
    const exec = async () => {
      if (!this.adapter.isConnected()) throw new EngineUnavailableError();
      // HQPlayer's Stop takes ~3.8 s to acknowledge; a queue load sends many commands.
      const timeoutMs = (this.options.commandTimeoutMs ?? 20_000) * timeoutScale;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const id = ++this.commandSerial;
      const startedAt = Date.now();
      if (this.commandListeners.size > 0) {
        this.emitCommand({ id, label, phase: 'start', at: startedAt });
      }
      let ok = false;
      let failure: unknown;
      try {
        const result = await Promise.race([
          fn(this.adapter),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EngineTimeoutError(label, timeoutMs)), timeoutMs);
          }),
        ]);
        ok = true;
        return result;
      } catch (err) {
        failure = err;
        throw err;
      } finally {
        clearTimeout(timer);
        if (this.commandListeners.size > 0) {
          const at = Date.now();
          this.emitCommand({
            id,
            label,
            phase: 'end',
            at,
            ok,
            durationMs: at - startedAt,
            ...(ok
              ? {}
              : {
                  errorName: (failure as Error | undefined)?.name ?? 'Error',
                  error: (failure as Error | undefined)?.message ?? String(failure),
                }),
          });
        }
      }
    };
    const p = this.chain.then(exec, exec);
    this.chain = p.catch(() => undefined);
    return p;
  }

  require(key: EngineCapabilityKey): void {
    if (!this.adapter.isConnected()) throw new EngineUnavailableError();
    const entry = this.capabilities?.items[key];
    if (!entry?.usable) {
      throw new CapabilityUnavailableError(
        key,
        entry?.status === 'untested'
          ? 'not yet verified on HQPlayer Desktop 6'
          : (entry?.note ?? 'not supported by the current engine'),
      );
    }
  }

  async transport(action: TransportAction): Promise<EngineStatus> {
    const resolved: Exclude<TransportAction, 'toggle'> =
      action === 'toggle' ? (this.status.transport === 'playing' ? 'pause' : 'play') : action;
    this.require(`transport.${resolved}`);
    if (this.liveSource && (await this.liveSource.transport(resolved, this.raw))) {
      return this.status;
    }
    await this.run(resolved, (a) => a[resolved]());
    return this.status;
  }

  async seek(positionMs: number): Promise<EngineStatus> {
    this.require('transport.seek');
    if (this.status.track?.source) {
      throw new CapabilityUnavailableError(
        'transport.seek',
        'a live input cannot be seeked from Studio',
      );
    }
    await this.run('seek', (a) => {
      if (!a.seek) throw new CapabilityUnavailableError('transport.seek', 'adapter has no seek');
      return a.seek(positionMs);
    });
    return this.status;
  }

  /**
   * Set HQPlayer's volume (dB). Turning it down is never limited; turning it up is limited to
   * `MAX_VOLUME_STEP_DB` above the current level per command, so a slip of the slider cannot
   * jump straight to full level on a DSD512 chain without an analogue volume control.
   */
  async setVolume(volumeDb: number): Promise<EngineStatus> {
    this.require('volume.set');
    const current = this.status.volumeDb;
    let target = volumeDb;
    if (current !== null && target > current + MAX_VOLUME_STEP_DB) {
      target = current + MAX_VOLUME_STEP_DB;
      this.hub.notice(
        'info',
        'volume_step_limited',
        `Volume raised by at most ${MAX_VOLUME_STEP_DB} dB at a time.`,
        { max: MAX_VOLUME_STEP_DB },
      );
    }
    await this.run('volume', (a) => {
      if (!a.setVolume) throw new CapabilityUnavailableError('volume.set', 'adapter has no volume');
      return a.setVolume(target);
    });
    return this.status;
  }

  // --- internals --------------------------------------------------------------------------------

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.adapter.connect();
      this.reconnectAttempt = 0;
      await this.refreshCapabilities();
      this.onAdapterStatus(await this.adapter.getStatus());
    } catch (err) {
      this.publish({
        ...disconnectedStatus(0, (err as Error).message),
        connection: 'disconnected',
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const min = this.options.reconnectMinMs ?? 1000;
    const max = this.options.reconnectMaxMs ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, delay);
  }

  async refreshCapabilities(): Promise<void> {
    this.capabilities = await this.adapter.getCapabilities();
    this.hub.publish({ type: 'engine.capabilities', capabilities: this.capabilities });
  }

  private onAdapterStatus(raw: EngineStatus): void {
    const wasConnected = this.status.connection === 'connected';
    let track = raw.track;
    if (track?.uri) {
      this.resolveUri(track.uri);
      track = { ...track, studioTrackId: this.lastUriTrackId, artworkId: this.lastUriArtworkId };
    }
    this.publish({ ...raw, track });
    const connected = raw.connection === 'connected';
    if (wasConnected !== connected) {
      void this.refreshCapabilities().catch(() => undefined);
      if (!connected) this.scheduleReconnect();
    }
  }

  private publish(status: EngineStatus): void {
    this.raw = status;
    let shown = status;
    if (this.liveSource) {
      try {
        shown = this.liveSource.decorate(status);
      } catch {
        // a live source never breaks status publishing
      }
    }
    this.serial += 1;
    this.status = { ...shown, serial: this.serial };
    for (const l of this.listeners) l(this.status);
    this.hub.publish({ type: 'engine.status', status: this.status });
  }
}
