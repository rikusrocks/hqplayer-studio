import {
  attrFloat,
  attrInt,
  attrStr,
  findChildren,
  HqpConnection,
  mapTransport,
  type XmlElement,
} from '@hqps/hqplayer-adapter';
import type { TransportState } from '@hqps/contracts';
import { describeValue, Redactor } from '../sanitize';
import { GateGuardError, type CommandLog } from '../gatec/session';

/**
 * The only commands the DSP gate may send. Reads, the four DSP selectors, the three DSP toggles,
 * the matrix profile, and Play/Stop for the "change while playing" step. Everything else —
 * Reset, ConfigurationLoad, SetTransport*, SetDisplay, SetJunkFilter, Volume, playlist edits —
 * is refused here before it can reach the socket.
 */
export const DSP_GATE_ALLOWED: ReadonlySet<string> = new Set([
  // read-only
  'GetInfo',
  'State',
  'Status',
  'GetModes',
  'GetFilters',
  'GetShapers',
  'GetRates',
  'MatrixListProfiles',
  'MatrixGetProfile',
  'PlaylistGet',
  // playback, only for the playing step
  'Play',
  'Stop',
  // DSP selectors
  'SetMode',
  'SetFilter',
  'SetShaping',
  'SetRate',
  // DSP toggles
  'SetInvert',
  'SetConvolution',
  'SetAdaptiveVolume',
  // matrix
  'MatrixSetProfile',
]);

export type DspKind = 'mode' | 'filter' | 'shaper' | 'rate';

export const SET_COMMAND: Record<DspKind, string> = {
  mode: 'SetMode',
  filter: 'SetFilter',
  shaper: 'SetShaping',
  rate: 'SetRate',
};

const GET_COMMAND: Record<DspKind, { cmd: string; item: string }> = {
  mode: { cmd: 'GetModes', item: 'ModesItem' },
  filter: { cmd: 'GetFilters', item: 'FiltersItem' },
  shaper: { cmd: 'GetShapers', item: 'ShapersItem' },
  rate: { cmd: 'GetRates', item: 'RatesItem' },
};

const KIND_BY_SET: Record<string, DspKind> = {
  SetMode: 'mode',
  SetFilter: 'filter',
  SetShaping: 'shaper',
  SetRate: 'rate',
};

const TOGGLES = new Set(['SetInvert', 'SetConvolution', 'SetAdaptiveVolume']);

/**
 * One entry of GetModes / GetFilters / GetShapers / GetRates. For rates the SDK gives only
 * `index` and `rate`; the rate in Hz is kept in `value` so all four lists share one shape.
 */
export interface DspItem {
  index: number;
  name: string;
  value: number | null;
  /** FiltersItem only (meaning unknown; recorded as evidence). */
  arg?: number | null;
  description?: string | null;
}

export type DspLists = Record<DspKind, DspItem[]>;

export interface DspStateSnapshot {
  transport: TransportState;
  mode: number | null;
  filter: number | null;
  filter1x: number | null;
  filterNx: number | null;
  shaper: number | null;
  rate: number | null;
  invert: number | null;
  convolution: number | null;
  adaptive: number | null;
  matrixProfile: string | null;
  /** Every attribute as sent by the engine, except free text (matrix profile name, volume). */
  raw: Record<string, string>;
}

export interface DspLiveStatus {
  transport: TransportState;
  positionMs: number | null;
  activeMode: string | null;
  activeFilter: string | null;
  activeShaper: string | null;
  activeRate: number | null;
  activeBits: number | null;
  receivedAt: number;
}

export function toDspLiveStatus(doc: XmlElement, receivedAt = Date.now()): DspLiveStatus {
  const position = attrFloat(doc, 'position');
  return {
    transport: mapTransport(attrInt(doc, 'state')),
    positionMs: position !== null ? Math.round(position * 1000) : null,
    activeMode: attrStr(doc, 'active_mode'),
    activeFilter: attrStr(doc, 'active_filter'),
    activeShaper: attrStr(doc, 'active_shaper'),
    activeRate: attrInt(doc, 'active_rate'),
    activeBits: attrInt(doc, 'active_bits'),
    receivedAt,
  };
}

/** State attributes that are safe to copy into the report verbatim (numbers only). */
const RAW_STATE_KEYS = [
  'state',
  'mode',
  'filter',
  'filter1x',
  'filterNx',
  'shaper',
  'rate',
  'active_mode',
  'active_rate',
  'invert',
  'convolution',
  'adaptive',
  'filter_junk',
  'repeat',
  'random',
] as const;

export function toDspState(doc: XmlElement): DspStateSnapshot {
  const raw: Record<string, string> = {};
  for (const k of RAW_STATE_KEYS) {
    const v = doc.attributes[k];
    if (v !== undefined) raw[k] = v;
  }
  return {
    transport: mapTransport(attrInt(doc, 'state')),
    mode: attrInt(doc, 'mode'),
    filter: attrInt(doc, 'filter'),
    filter1x: attrInt(doc, 'filter1x'),
    filterNx: attrInt(doc, 'filterNx'),
    shaper: attrInt(doc, 'shaper'),
    rate: attrInt(doc, 'rate'),
    invert: attrInt(doc, 'invert'),
    convolution: attrInt(doc, 'convolution'),
    adaptive: attrInt(doc, 'adaptive'),
    matrixProfile: attrStr(doc, 'matrix_profile'),
    raw,
  };
}

export interface DspSessionOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Multiplies every wait (tests use a small value). */
  timeScale?: number;
}

/**
 * One guarded control connection for the DSP gate. Besides the allowlist it enforces the main
 * safety rule of the test: a selector value must come from the list that was read LAST for
 * that selector on this connection (its `index`, or its `value` / rate), so a number that
 * HQPlayer never offered can not be sent.
 */
export class DspGateSession {
  readonly conn: HqpConnection;
  private latest: DspLiveStatus | null = null;
  private statusLog: DspLiveStatus[] | null = null;
  private logSink: CommandLog[] | null = null;
  private lists: Partial<DspLists> = {};
  private profiles: string[] | null = null;
  readonly timeScale: number;
  readonly redactor = new Redactor();

  constructor(options: DspSessionOptions) {
    this.timeScale = options.timeScale ?? 1;
    this.conn = new HqpConnection({
      host: options.host,
      port: options.port,
      connectTimeoutMs: options.timeoutMs ?? 3000,
      requestTimeoutMs: options.timeoutMs ?? 5000,
      allowSideEffects: true,
    });
    this.conn.onUnsolicited((doc) => {
      if (doc.name === 'Status') this.noteStatus(toDspLiveStatus(doc));
    });
  }

  private noteStatus(st: DspLiveStatus): void {
    this.latest = st;
    this.statusLog?.push(st);
  }

  async open(): Promise<void> {
    await this.conn.connect();
    await this.send('Status', { subscribe: 1 });
  }

  close(): void {
    this.conn.close();
  }

  get connected(): boolean {
    return this.conn.connected;
  }

  capture(sink: CommandLog[] | null): void {
    this.logSink = sink;
  }

  /** Record every pushed Status into `sink` (used to watch playback react to a change). */
  watchStatus(sink: DspLiveStatus[] | null): void {
    this.statusLog = sink;
  }

  private assertListed(kind: DspKind, raw: unknown, attr: string): void {
    const n = Number(raw);
    const list = this.lists[kind];
    if (!list) throw new GateGuardError(`${SET_COMMAND[kind]} before its list was read`);
    if (!Number.isInteger(n) || !list.some((i) => i.index === n || i.value === n))
      throw new GateGuardError(
        `${SET_COMMAND[kind]} ${attr}="${String(raw)}" is not in the list HQPlayer returned`,
      );
  }

  private guard(name: string, attributes: Record<string, string | number>): void {
    if (!DSP_GATE_ALLOWED.has(name))
      throw new GateGuardError(`"${name}" is not part of the DSP gate plan`);
    const kind = KIND_BY_SET[name];
    if (kind) {
      this.assertListed(kind, attributes.value, 'value');
      if (name === 'SetFilter' && attributes.value1x !== undefined)
        this.assertListed('filter', attributes.value1x, 'value1x');
    }
    if (TOGGLES.has(name) && attributes.value !== 0 && attributes.value !== 1)
      throw new GateGuardError(`${name} takes 0 or 1`);
    if (name === 'MatrixSetProfile' && !this.profiles?.includes(String(attributes.value)))
      throw new GateGuardError('MatrixSetProfile value is not a profile HQPlayer listed');
  }

  async send(name: string, attributes: Record<string, string | number> = {}): Promise<XmlElement> {
    this.guard(name, attributes);
    const started = performance.now();
    const entry: CommandLog = {
      name,
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([k, v]) => [
          k,
          name === 'MatrixSetProfile' ? describeValue(String(v)) : String(v),
        ]),
      ),
      ok: false,
      ms: 0,
      result: null,
    };
    try {
      const doc = await this.conn.request(name, attributes);
      entry.ok = true;
      entry.result = doc.attributes.result ?? null;
      if (name === 'Status') this.noteStatus(toDspLiveStatus(doc));
      return doc;
    } catch (err) {
      entry.error = this.redactor
        .apply(`${(err as Error).name}: ${(err as Error).message}`)
        .slice(0, 300);
      throw err;
    } finally {
      entry.ms = Math.round(performance.now() - started);
      this.logSink?.push(entry);
    }
  }

  status(): DspLiveStatus | null {
    return this.latest;
  }

  async state(): Promise<DspStateSnapshot> {
    return toDspState(await this.send('State'));
  }

  /** Read one selector list; the result becomes the only source of valid Set values. */
  async readList(kind: DspKind): Promise<DspItem[]> {
    const { cmd, item } = GET_COMMAND[kind];
    const doc = await this.send(cmd);
    const list = findChildren(doc, item).map((el, i): DspItem => {
      const index = attrInt(el, 'index') ?? i;
      if (kind === 'rate') {
        const rate = attrInt(el, 'rate');
        return { index, name: rate === null ? '' : String(rate), value: rate };
      }
      const out: DspItem = {
        index,
        name: attrStr(el, 'name') ?? '',
        value: attrInt(el, 'value'),
      };
      if (kind === 'filter') {
        out.arg = attrInt(el, 'arg');
        out.description = attrStr(el, 'description');
      }
      return out;
    });
    this.lists[kind] = list;
    return list;
  }

  async readLists(): Promise<DspLists> {
    return {
      mode: await this.readList('mode'),
      filter: await this.readList('filter'),
      shaper: await this.readList('shaper'),
      rate: await this.readList('rate'),
    };
  }

  async matrix(): Promise<{ profiles: string[]; current: string | null }> {
    const list = await this.send('MatrixListProfiles');
    const profiles = findChildren(list, 'MatrixProfile')
      .map((el) => attrStr(el, 'name'))
      .filter((n): n is string => n !== null);
    this.profiles = profiles;
    for (const p of profiles) this.redactor.add(p);
    const cur = await this.send('MatrixGetProfile');
    return { profiles, current: attrStr(cur, 'value') };
  }

  async playlistLength(): Promise<number> {
    const doc = await this.send('PlaylistGet', { picture: 0 });
    return findChildren(doc, 'PlaylistItem').length;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(1, Math.round(ms * this.timeScale))));
  }

  /** Poll State (read-only) until `pred` holds or the time is up; returns the last State read. */
  async pollState(
    pred: (s: DspStateSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<{ state: DspStateSnapshot; matched: boolean; ms: number }> {
    const started = Date.now();
    const deadline = started + timeoutMs * this.timeScale;
    for (;;) {
      const state = await this.state();
      if (pred(state)) return { state, matched: true, ms: Date.now() - started };
      if (Date.now() > deadline) return { state, matched: false, ms: Date.now() - started };
      await this.sleep(250);
    }
  }

  async waitForStatus(
    pred: (s: DspLiveStatus) => boolean,
    timeoutMs: number,
  ): Promise<DspLiveStatus | null> {
    const deadline = Date.now() + timeoutMs * this.timeScale;
    for (;;) {
      const s = this.latest;
      if (s && pred(s)) return s;
      if (Date.now() > deadline || !this.conn.connected) return null;
      await new Promise((r) => setTimeout(r, Math.max(5, Math.round(100 * this.timeScale))));
    }
  }
}
