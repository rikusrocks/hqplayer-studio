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

/**
 * Supervises the HQPlayer adapter:
 *  - serialises every engine command (one at a time, in arrival order, across Desktop + Web);
 *  - applies a timeout and reports it — never retries a write (avoids double-queued tracks);
 *  - republishes engine-reported status (HQPlayer is the authority on playback state);
 *  - reconnects with backoff, and after reconnecting only re-reads state: it never sends Play,
 *    volume or DSP changes on its own.
 */
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
  private lastUri: string | null = null;
  private lastUriTrackId: string | null = null;

  constructor(
    readonly adapter: HQPlayerAdapter,
    private readonly hub: EventHub,
    private readonly library: LibraryRepository,
    private readonly options: EngineServiceOptions = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.adapter.subscribeStatus((s) => this.onAdapterStatus(s));
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

  /** Run an engine command exclusively, with a timeout. */
  run<T>(label: string, fn: (adapter: HQPlayerAdapter) => Promise<T>): Promise<T> {
    const exec = async () => {
      if (!this.adapter.isConnected()) throw new EngineUnavailableError();
      const timeoutMs = this.options.commandTimeoutMs ?? 8000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(this.adapter),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EngineTimeoutError(label, timeoutMs)), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
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
    await this.run(resolved, (a) => a[resolved]());
    return this.status;
  }

  async seek(positionMs: number): Promise<EngineStatus> {
    this.require('transport.seek');
    await this.run('seek', (a) => {
      if (!a.seek) throw new CapabilityUnavailableError('transport.seek', 'adapter has no seek');
      return a.seek(positionMs);
    });
    return this.status;
  }

  async setVolume(volumeDb: number): Promise<EngineStatus> {
    this.require('volume.set');
    await this.run('volume', (a) => {
      if (!a.setVolume) throw new CapabilityUnavailableError('volume.set', 'adapter has no volume');
      return a.setVolume(volumeDb);
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

  private async refreshCapabilities(): Promise<void> {
    this.capabilities = await this.adapter.getCapabilities();
    this.hub.publish({ type: 'engine.capabilities', capabilities: this.capabilities });
  }

  private onAdapterStatus(raw: EngineStatus): void {
    const wasConnected = this.status.connection === 'connected';
    let track = raw.track;
    if (track?.uri) {
      if (track.uri !== this.lastUri) {
        this.lastUri = track.uri;
        this.lastUriTrackId = this.library.findTrackIdBySource(track.uri);
      }
      track = { ...track, studioTrackId: this.lastUriTrackId };
    }
    this.publish({ ...raw, track });
    const connected = raw.connection === 'connected';
    if (wasConnected !== connected) {
      void this.refreshCapabilities().catch(() => undefined);
      if (!connected) this.scheduleReconnect();
    }
  }

  private publish(status: EngineStatus): void {
    this.serial += 1;
    this.status = { ...status, serial: this.serial };
    for (const l of this.listeners) l(this.status);
    this.hub.publish({ type: 'engine.status', status: this.status });
  }
}
