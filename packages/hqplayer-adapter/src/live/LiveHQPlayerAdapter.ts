import {
  disconnectedStatus,
  type DspState,
  type EngineCapabilities,
  type EngineCapabilityKey,
  type EngineIdentity,
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
import { CapabilityUnavailableError, EngineUnavailableError } from '../errors';
import { DEFAULT_CONTROL_PORT } from '../protocol/commands';
import { HqpConnection, type TranscriptEntry } from '../protocol/connection';
import { mapStateDocument, mapStatusDocument, repeatToSdk } from '../protocol/status';
import {
  attrFloat,
  attrInt,
  attrStr,
  findChildren,
  unescapeHqpText,
  type XmlElement,
} from '../protocol/xml';
import {
  DESKTOP6_EVIDENCE,
  resolveCapabilities,
  type CapabilityEvidence,
  type CapabilityPolicy,
} from './capability-matrix';

export interface LiveAdapterOptions {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
  evidence?: Record<EngineCapabilityKey, CapabilityEvidence>;
  policy?: CapabilityPolicy;
  onTranscript?: (entry: TranscriptEntry) => void;
}

/**
 * EXPERIMENTAL (Phase 1 spike) adapter for a real HQPlayer Desktop 6 over TCP/XML.
 *
 * Read paths (GetInfo, Status subscription, State, PlaylistGet, DSP lists) are allowed because
 * they are side-effect free. Every write path is gated by the capability matrix: until a command
 * is confirmed on Desktop 6 — or the user explicitly opts into Gate C testing — it throws
 * CapabilityUnavailableError instead of touching the engine.
 */
export class LiveHQPlayerAdapter implements HQPlayerAdapter {
  readonly kind = 'live' as const;

  private connection: HqpConnection | null = null;
  private identity: EngineIdentity | null = null;
  private last: EngineStatus = disconnectedStatus();
  private serial = 0;
  private readonly listeners = new Set<StatusListener>();
  private readonly evidence: Record<EngineCapabilityKey, CapabilityEvidence>;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: LiveAdapterOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? DEFAULT_CONTROL_PORT;
    this.evidence = options.evidence ?? DESKTOP6_EVIDENCE;
  }

  isConnected(): boolean {
    return this.connection?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const conn = new HqpConnection({
      host: this.host,
      port: this.port,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 4000,
      allowSideEffects: Boolean(this.options.policy?.allowUntestedWrites),
      onTranscript: this.options.onTranscript,
    });
    this.publish({ ...this.last, connection: 'connecting', lastError: null });
    try {
      await conn.connect();
    } catch (err) {
      this.publish({ ...disconnectedStatus(0, (err as Error).message), connection: 'error' });
      throw err;
    }
    this.connection = conn;
    conn.onClose((_hadError, reason) => {
      if (this.connection === conn) this.connection = null;
      this.publish(
        disconnectedStatus(0, reason ? `Connection closed: ${reason}` : 'Connection closed'),
      );
    });
    conn.onUnsolicited((doc) => {
      if (doc.name === 'Status') this.applyStatus(doc);
    });

    const info = await conn.request('GetInfo');
    this.identity = {
      product: attrStr(info, 'product') ?? 'HQPlayer',
      version: attrStr(info, 'version'),
      platform: attrStr(info, 'platform'),
      engine: attrStr(info, 'engine'),
    };
    const first = await conn.request('Status', { subscribe: 1 });
    this.applyStatus(first);
    try {
      const state = mapStateDocument(await conn.request('State'));
      this.publish({ ...this.last, repeat: state.repeat, random: state.random });
    } catch {
      // State is optional for Phase 1; Status already carries the essentials.
    }
  }

  async disconnect(): Promise<void> {
    this.connection?.close();
    this.connection = null;
    this.publish(disconnectedStatus(0, null));
  }

  async getCapabilities(): Promise<EngineCapabilities> {
    return {
      adapter: 'live',
      engine: this.identity,
      items: resolveCapabilities(this.evidence, this.isConnected(), this.options.policy),
    };
  }

  async getStatus(): Promise<EngineStatus> {
    return this.last;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  play(): Promise<void> {
    return this.write('transport.play', 'Play', { last: 0 });
  }
  pause(): Promise<void> {
    return this.write('transport.pause', 'Pause');
  }
  stop(): Promise<void> {
    return this.write('transport.stop', 'Stop');
  }
  next(): Promise<void> {
    return this.write('transport.next', 'Next');
  }
  previous(): Promise<void> {
    return this.write('transport.previous', 'Previous');
  }
  seek(positionMs: number): Promise<void> {
    return this.write('transport.seek', 'Seek', { position: Math.round(positionMs / 1000) });
  }
  setVolume(volumeDb: number): Promise<void> {
    return this.write('volume.set', 'Volume', { value: volumeDb });
  }
  setRepeat(mode: RepeatMode): Promise<void> {
    return this.write('playback.repeat', 'SetRepeat', { value: repeatToSdk(mode) });
  }
  setRandom(on: boolean): Promise<void> {
    return this.write('playback.random', 'SetRandom', { value: on ? 1 : 0 });
  }

  async replaceQueue(items: PlayableTrack[], options: ReplaceQueueOptions): Promise<void> {
    const conn = this.requireWrite('queue.replace');
    if (options.albumMode) {
      // Album Mode cannot be selected via the SDK API; the queue is still loaded in order.
    }
    await conn.request('PlaylistClear');
    for (const item of items) {
      await conn.request('PlaylistAdd', { uri: item.uri, queued: 1, clear: 0 });
    }
    await conn.request('SelectTrack', { index: options.startIndex });
    if (options.autoplay) await conn.request('Play', { last: 0 });
  }

  async appendToQueue(items: PlayableTrack[]): Promise<void> {
    const conn = this.requireWrite('queue.append');
    for (const item of items)
      await conn.request('PlaylistAdd', { uri: item.uri, queued: 1, clear: 0 });
  }

  async removeFromQueue(engineIndex: number): Promise<void> {
    await this.write('queue.replace', 'PlaylistRemove', { index: engineIndex });
  }

  async clearQueue(): Promise<void> {
    await this.write('queue.replace', 'PlaylistClear');
  }

  async selectIndex(index: number, autoplay: boolean): Promise<void> {
    const conn = this.requireWrite('queue.select');
    await conn.request('SelectTrack', { index });
    if (autoplay) await conn.request('Play', { last: 0 });
  }

  async getEngineQueue(): Promise<EngineQueueSnapshot> {
    const conn = this.requireRead('queue.read');
    const doc = await conn.request('PlaylistGet', { picture: 0 });
    return {
      albumMode: doc.attributes.album === undefined ? null : doc.attributes.album === '1',
      entries: findChildren(doc, 'PlaylistItem').map((item, i) => {
        const length = attrFloat(item, 'length');
        const s = (n: string) => {
          const v = attrStr(item, n);
          return v === null ? null : unescapeHqpText(v);
        };
        return {
          index: attrInt(item, 'index') ?? i,
          uri: attrStr(item, 'uri'),
          title: s('song'),
          artist: s('artist'),
          album: s('album'),
          durationMs: length !== null ? Math.round(length * 1000) : null,
        };
      }),
    };
  }

  async getDspState(): Promise<DspState> {
    const conn = this.requireRead('dsp.read');
    const list = async (cmd: string, item: string) =>
      findChildren(await conn.request(cmd), item).map((el: XmlElement) => ({
        index: attrInt(el, 'index') ?? 0,
        name: attrStr(el, 'name') ?? '',
        value: attrInt(el, 'value'),
      }));
    const modes = await list('GetModes', 'ModesItem');
    const filters = await list('GetFilters', 'FiltersItem');
    const shapers = await list('GetShapers', 'ShapersItem');
    const rates = findChildren(await conn.request('GetRates'), 'RatesItem').map((el) => ({
      index: attrInt(el, 'index') ?? 0,
      rate: attrInt(el, 'rate') ?? 0,
    }));
    return {
      modes,
      filters,
      shapers,
      rates,
      current: {
        mode: this.last.dsp?.mode ?? null,
        filter: this.last.dsp?.filter ?? null,
        shaper: this.last.dsp?.shaper ?? null,
        rate: this.last.dsp?.outputRate ?? null,
      },
      writable: false,
    };
  }

  // --- internals --------------------------------------------------------------------------------

  private applyStatus(doc: XmlElement): void {
    const mapped = mapStatusDocument(doc);
    this.publish({ ...this.last, ...mapped, connection: 'connected', lastError: null });
  }

  private publish(status: Omit<EngineStatus, 'serial'> & { serial?: number }): void {
    this.serial += 1;
    this.last = { ...status, serial: this.serial };
    for (const l of this.listeners) l(this.last);
  }

  private capabilityEntry(key: EngineCapabilityKey) {
    return resolveCapabilities(this.evidence, this.isConnected(), this.options.policy)[key];
  }

  private requireRead(key: EngineCapabilityKey): HqpConnection {
    if (!this.connection?.connected) throw new EngineUnavailableError();
    const entry = this.capabilityEntry(key);
    if (!entry.usable) throw new CapabilityUnavailableError(key, entry.note ?? entry.status);
    return this.connection;
  }

  private requireWrite(key: EngineCapabilityKey): HqpConnection {
    if (!this.connection?.connected) throw new EngineUnavailableError();
    const entry = this.capabilityEntry(key);
    if (!entry.usable) {
      throw new CapabilityUnavailableError(
        key,
        entry.status === 'untested'
          ? 'not yet verified on HQPlayer Desktop 6 (Gate C requires explicit consent)'
          : (entry.note ?? entry.status),
      );
    }
    return this.connection;
  }

  private async write(
    key: EngineCapabilityKey,
    command: string,
    attributes: Record<string, string | number> = {},
  ): Promise<void> {
    const conn = this.requireWrite(key);
    await conn.request(command, attributes);
  }
}
