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
  EngineQueueEntry,
  EngineQueueSnapshot,
  HQPlayerAdapter,
  PlayableTrack,
  ReplaceQueueOptions,
  StatusListener,
} from '../adapter';
import { CapabilityUnavailableError, EngineCommandError, EngineUnavailableError } from '../errors';
import { DEFAULT_CONTROL_PORT } from '../protocol/commands';
import { HqpConnection, type TranscriptEntry } from '../protocol/connection';
import { ProtocolLog } from './protocol-log';
import {
  mapStateDocument,
  mapStatusDocument,
  repeatToSdk,
  toEngineIndex,
  toStudioIndex,
} from '../protocol/status';
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
  type RuntimeLimits,
} from './capability-matrix';

export interface LiveAdapterOptions {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
  evidence?: Record<EngineCapabilityKey, CapabilityEvidence>;
  policy?: CapabilityPolicy;
  onTranscript?: (entry: TranscriptEntry) => void;
  /** Max wait for HQPlayer's "stopped" Status after Stop, before clearing (default 6 s). */
  stopSettleMs?: number;
  /** Pause between clear attempts when HQPlayer kept an entry (default 1 s). */
  clearRetryMs?: number;
  /** How long to wait for SelectTrack during playback to switch before stopping (2.5 s). */
  switchSettleMs?: number;
}

/**
 * Adapter for a real HQPlayer Desktop 6 over TCP/XML.
 *
 * Read paths (GetInfo, Status subscription, State, PlaylistGet, DSP lists) are always allowed —
 * they are side-effect free. Write paths need BOTH evidence (confirmed/observed in Gate C on the
 * user's engine) AND the user's switch “允许 Studio 控制 HQPlayer” (`policy.controlEnabled`);
 * otherwise they throw CapabilityUnavailableError without touching the engine, and the
 * connection-level interlock refuses side-effect commands as a second line of defence.
 */
export class LiveHQPlayerAdapter implements HQPlayerAdapter {
  readonly kind = 'live' as const;

  private connection: HqpConnection | null = null;
  private identity: EngineIdentity | null = null;
  private last: EngineStatus = disconnectedStatus();
  private serial = 0;
  /** Cached HQPlayer playlist (PlaylistGet). Status carries no metadata while stopped. */
  private playlist: EngineQueueSnapshot | null = null;
  private volumeRange: { min: number; max: number } | null = null;
  private serials: string | null = null;
  private refreshing = false;
  /**
   * Numbering base of Status `track`, verified by matching the playing file's URI against the
   * playlist (PlaylistItem.index is known to be 1-based). null until verified.
   */
  private statusTrackBase: number | null = null;
  private currentMatchedBy: 'uri' | 'index' | 'none' = 'none';
  private policy: CapabilityPolicy;
  private runtime: RuntimeLimits = {};
  private readonly listeners = new Set<StatusListener>();
  /** Internal waiters re-checked on every published status (e.g. "until stopped"). */
  private readonly waiters = new Set<() => void>();
  private readonly log = new ProtocolLog();
  private readonly evidence: Record<EngineCapabilityKey, CapabilityEvidence>;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: LiveAdapterOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? DEFAULT_CONTROL_PORT;
    this.evidence = options.evidence ?? DESKTOP6_EVIDENCE;
    this.policy = { ...options.policy };
  }

  /** Change the control policy at runtime (the user's switch). Read paths are unaffected. */
  setPolicy(policy: CapabilityPolicy): void {
    this.policy = { ...policy };
    this.connection?.setAllowSideEffects(this.sideEffectsAllowed());
  }

  getPolicy(): CapabilityPolicy {
    return { ...this.policy };
  }

  private sideEffectsAllowed(): boolean {
    return Boolean(this.policy.controlEnabled || this.policy.allowUntestedWrites);
  }

  isConnected(): boolean {
    return this.connection?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const conn = new HqpConnection({
      host: this.host,
      port: this.port,
      // Stop takes ~3.8 s to acknowledge while playing (Gate C, engine 6.1.0).
      requestTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
      allowSideEffects: this.sideEffectsAllowed(),
      onTranscript: (entry) => {
        this.log.record(entry);
        this.options.onTranscript?.(entry);
      },
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
      this.playlist = null;
      this.serials = null;
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
    try {
      const range = await conn.request('VolumeRange');
      const min = attrFloat(range, 'min');
      const max = attrFloat(range, 'max');
      if (min !== null && max !== null) this.volumeRange = { min, max };
      const enabled = range.attributes.enabled;
      this.runtime = {
        ...this.runtime,
        volumeControlEnabled: enabled === undefined ? null : enabled === '1',
      };
    } catch {
      // optional
    }
    try {
      this.playlist = await this.readPlaylist(conn);
    } catch {
      this.playlist = null;
    }
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
    this.playlist = null;
    this.serials = null;
    this.publish(disconnectedStatus(0, null));
  }

  async getCapabilities(): Promise<EngineCapabilities> {
    return {
      adapter: 'live',
      engine: this.identity,
      items: resolveCapabilities(this.evidence, this.isConnected(), this.policy, this.runtime),
    };
  }

  async getStatus(): Promise<EngineStatus> {
    return this.last;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** From pause, resume with Pause (it toggles and resumes in place — Gate C); otherwise Play. */
  async play(): Promise<void> {
    const conn = this.requireWrite('transport.play');
    if (this.last.transport === 'paused') await conn.request('Pause');
    else if (this.last.transport !== 'playing') await conn.request('Play', { last: 0 });
  }
  /** HQPlayer's Pause toggles, so only send it while playing (a 2nd click must not resume). */
  async pause(): Promise<void> {
    const conn = this.requireWrite('transport.pause');
    if (this.last.transport === 'playing') await conn.request('Pause');
  }
  stop(): Promise<void> {
    return this.write('transport.stop', 'Stop');
  }
  next(): Promise<void> {
    return this.write('transport.next', 'Next');
  }
  /**
   * HQPlayer's own Previous was inconclusive in Gate C, so “previous” is built from confirmed
   * commands: restart the track if we are more than 3 s in, otherwise select the previous item.
   */
  async previous(): Promise<void> {
    const conn = this.requireWrite('transport.previous');
    const st = this.last;
    if (st.positionMs > 3000 || st.trackIndex === null || st.trackIndex <= 0) {
      await conn.request('Seek', { position: 0 });
      return;
    }
    await this.select(conn, st.trackIndex - 1, st.transport === 'playing');
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
    await this.clearPlaylistVerified(conn);
    for (const item of items) {
      await conn.request('PlaylistAdd', { uri: item.uri, queued: 1, clear: 0 });
    }
    // Verify before selecting: SelectTrack on a playlist that is not exactly ours would start
    // the wrong song.
    const loaded = await this.readPlaylist(conn);
    this.playlist = loaded;
    this.publishPlaylistCount();
    if (loaded.entries.length !== items.length) {
      throw new EngineCommandError(
        'PlaylistAdd',
        `HQPlayer's playlist has ${loaded.entries.length} item(s) after loading ${items.length}`,
      );
    }
    await conn.request('SelectTrack', { index: toEngineIndex(options.startIndex) });
    if (options.autoplay) await conn.request('Play', { last: 0 });
  }

  async appendToQueue(items: PlayableTrack[]): Promise<void> {
    const conn = this.requireWrite('queue.append');
    for (const item of items)
      await conn.request('PlaylistAdd', { uri: item.uri, queued: 1, clear: 0 });
    await this.refreshAfterEdit(conn);
  }

  async removeFromQueue(engineIndex: number): Promise<void> {
    const conn = this.requireWrite('queue.replace');
    await conn.request('PlaylistRemove', { index: toEngineIndex(engineIndex) });
    await this.refreshAfterEdit(conn);
  }

  async clearQueue(): Promise<void> {
    const conn = this.requireWrite('queue.replace');
    await this.clearPlaylistVerified(conn);
  }

  /**
   * Empty HQPlayer's playlist for real.
   *
   * Observed on HQPlayer Desktop 6 (user report, Studio v0.1.4): `PlaylistClear` while a track
   * is playing leaves that track in the playlist and it keeps playing — so a following
   * `SelectTrack 1` + `Play` resumed the old song instead of the new album. Gate C only ever
   * cleared a stopped engine. So: always Stop first (confirmed in Gate C; ~3.8 s while playing,
   * 0 ms when already stopped — and Studio's last pushed Status may lag behind a Play it just
   * sent), clear, then read the playlist back; leftovers are removed one by one
   * (`PlaylistRemove`, confirmed) and anything still left is reported as an error.
   */
  private async clearPlaylistVerified(conn: HqpConnection): Promise<void> {
    // v0.1.5 report: one song survived the clear. HQPlayer ACKs Stop before it has fully
    // stopped (Gate C waited for the pushed "stopped" Status before clearing — and passed).
    await this.stopAndWait(conn);
    let playlist: EngineQueueSnapshot | null = null;
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await conn.request('PlaylistClear');
      playlist = await this.readPlaylist(conn);
      if (playlist.entries.length === 0) break;
      this.log.note(`PlaylistClear left ${playlist.entries.length} item(s) (attempt ${attempt})`);
      for (let n = playlist.entries.length; n > 0; n -= 1) {
        await conn
          .request('PlaylistRemove', { index: toEngineIndex(n - 1) })
          .catch((err: Error) => this.log.note(`PlaylistRemove ${n} refused: ${err.message}`));
      }
      playlist = await this.readPlaylist(conn);
      if (playlist.entries.length === 0) break;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, this.options.clearRetryMs ?? 1000));
        if (this.last.transport !== 'stopped') await conn.request('Stop');
      }
    }
    this.playlist = playlist;
    this.publishPlaylistCount();
    if (playlist && playlist.entries.length > 0) {
      throw new EngineCommandError(
        'PlaylistClear',
        `HQPlayer kept ${playlist.entries.length} item(s) in its playlist after ${attempts} attempts — please use “复制诊断信息” in Settings and send it to the developer`,
      );
    }
  }

  /** Resolves true once `pred(status)` holds for a published status, false on timeout. */
  private waitForStatus(pred: (s: EngineStatus) => boolean, timeoutMs: number): Promise<boolean> {
    if (pred(this.last)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (pred(this.last)) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(ok);
      };
      this.waiters.add(check);
    });
  }

  /** Privacy-safe recent HQPlayer conversation for “复制诊断信息”. */
  getProtocolLog() {
    return this.log.snapshot();
  }

  private publishPlaylistCount(): void {
    if (!this.playlist) return;
    this.publish({
      ...this.last,
      trackCount: this.playlist.entries.length,
      albumMode: this.playlist.albumMode,
    });
  }

  /**
   * After Studio edits HQPlayer's playlist, re-read it before returning so the next status (and
   * Studio's queue sync check) sees the new length rather than the stale cache.
   */
  private async refreshAfterEdit(conn: HqpConnection): Promise<void> {
    try {
      this.playlist = await this.readPlaylist(conn);
      this.publishPlaylistCount();
    } catch {
      // the serial-change refresh will catch up
    }
  }

  async selectIndex(index: number, autoplay: boolean): Promise<void> {
    const conn = this.requireWrite('queue.select');
    await this.select(conn, index, autoplay);
  }

  /**
   * Select (and play) a playlist entry. Gate C verified SelectTrack + Play from *stopped* only.
   * During playback HQPlayer may ignore it (as it ignored PlaylistClear), so: try it, and if the
   * playing file has not changed within a short time, Stop → wait until stopped → select → play.
   * The protocol log records which path was taken (evidence for the next real-engine report).
   */
  private async select(conn: HqpConnection, index: number, play: boolean): Promise<void> {
    const active = this.last.transport === 'playing' || this.last.transport === 'paused';
    if (play && active) {
      const target = this.playlist?.entries[index]?.uri ?? null;
      const sentAt = Date.now();
      await conn.request('SelectTrack', { index: toEngineIndex(index) });
      await conn.request('Play', { last: 0 });
      const switched =
        target !== null &&
        (await this.waitForStatus(
          (s) => s.observedAt >= sentAt && s.transport === 'playing' && s.track?.uri === target,
          this.options.switchSettleMs ?? 2500,
        ));
      this.log.note(
        switched
          ? `SelectTrack during playback switched after ${Date.now() - sentAt} ms`
          : 'SelectTrack during playback did not switch — stopping first',
      );
      if (switched) return;
      await this.stopAndWait(conn);
    }
    await conn.request('SelectTrack', { index: toEngineIndex(index) });
    if (play) await conn.request('Play', { last: 0 });
  }

  /** Stop, and wait until HQPlayer reports it really stopped (its ACK comes earlier). */
  private async stopAndWait(conn: HqpConnection): Promise<void> {
    const wasStopped = this.last.transport === 'stopped';
    const stopSentAt = Date.now();
    await conn.request('Stop');
    if (wasStopped) return;
    const stopped = await this.waitForStatus(
      (s) => s.transport === 'stopped' && s.observedAt >= stopSentAt,
      this.options.stopSettleMs ?? 6000,
    );
    this.log.note(
      stopped
        ? `stopped confirmed after ${Date.now() - stopSentAt} ms`
        : `no "stopped" Status within ${Date.now() - stopSentAt} ms — continuing anyway`,
    );
  }

  async getEngineQueue(): Promise<EngineQueueSnapshot> {
    const conn = this.requireRead('queue.read');
    this.playlist = await this.readPlaylist(conn);
    this.publishPlaylistCount();
    return {
      ...this.playlist,
      currentIndex: this.last.trackIndex,
      currentMatchedBy: this.last.trackIndex === null ? 'none' : this.currentMatchedBy,
      statusTrackBase: this.statusTrackBase,
    };
  }

  private async readPlaylist(conn: HqpConnection): Promise<EngineQueueSnapshot> {
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
          index: toStudioIndex(attrInt(item, 'index')) ?? i,
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
    const rawTrack = attrInt(doc, 'track');
    let trackIndex = mapped.trackIndex;
    this.currentMatchedBy = trackIndex === null ? 'none' : 'index';
    // Prefer locating the playing file by URI (unique within the playlist) over trusting the
    // numbering of Status `track`; when that works, it also verifies the numbering base.
    const playingUri = mapped.track?.uri ?? null;
    if (playingUri && this.playlist) {
      const hits = this.playlist.entries.filter((e) => e.uri === playingUri);
      if (hits.length === 1) {
        trackIndex = (hits[0] as EngineQueueEntry).index;
        this.currentMatchedBy = 'uri';
        if (rawTrack !== null) this.statusTrackBase = rawTrack - trackIndex;
      }
    } else if (rawTrack !== null && this.statusTrackBase !== null) {
      trackIndex = rawTrack >= this.statusTrackBase ? rawTrack - this.statusTrackBase : null;
    }
    const entry = trackIndex !== null ? this.playlist?.entries[trackIndex] : undefined;
    let track = mapped.track ? { ...mapped.track, index: trackIndex } : null;
    if (track && entry && !track.title) {
      // Stopped/paused status has no <metadata>: describe the selected track from the playlist.
      track = {
        ...track,
        uri: track.uri ?? entry.uri,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        durationMs: track.durationMs ?? entry.durationMs,
      };
    }
    this.publish({
      ...this.last,
      ...mapped,
      trackIndex,
      track,
      durationMs: mapped.durationMs ?? track?.durationMs ?? null,
      trackCount: this.playlist?.entries.length ?? null,
      albumMode: this.playlist?.albumMode ?? null,
      volumeRange: this.volumeRange,
      connection: 'connected',
      lastError: null,
    });
    // Playlist/track changes bump these serials: re-read the playlist (cheap, read-only).
    const serials = `${doc.attributes.track_serial ?? ''}|${doc.attributes.transport_serial ?? ''}`;
    if (this.serials !== null && serials !== this.serials) void this.refreshPlaylist();
    this.serials = serials;
  }

  private async refreshPlaylist(): Promise<void> {
    const conn = this.connection;
    if (!conn?.connected || this.refreshing) return;
    this.refreshing = true;
    try {
      this.playlist = await this.readPlaylist(conn);
      this.publishPlaylistCount();
    } catch {
      // keep the previous cache; the next status change retries
    } finally {
      this.refreshing = false;
    }
  }

  private publish(status: Omit<EngineStatus, 'serial'> & { serial?: number }): void {
    this.serial += 1;
    this.last = { ...status, serial: this.serial };
    for (const l of this.listeners) l(this.last);
    for (const w of [...this.waiters]) w();
  }

  private capabilityEntry(key: EngineCapabilityKey) {
    return resolveCapabilities(this.evidence, this.isConnected(), this.policy, this.runtime)[key];
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
