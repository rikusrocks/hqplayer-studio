import {
  attrFloat,
  attrInt,
  attrStr,
  findChildren,
  HqpConnection,
  mapStatusDocument,
  mapTransport,
  type XmlElement,
} from '@hqps/hqplayer-adapter';
import type { TransportState } from '@hqps/contracts';
import { describeValue, Redactor } from '../sanitize';

/**
 * The only commands Gate C may send (docs/gate-c-plan.md, approved 2026-11-10: C1–C4 + O1/O2).
 * Anything else — DSP, output, configuration, saved playlists, favourites, Reset — is refused
 * here before it can reach the socket.
 */
export const GATE_C_ALLOWED: ReadonlySet<string> = new Set([
  // read-only
  'GetInfo',
  'State',
  'Status',
  'VolumeRange',
  'PlaylistGet',
  // C1 transport
  'Play',
  'Pause',
  'Stop',
  'Next',
  'Previous',
  'Seek',
  // C2–C4 playlist
  'PlaylistClear',
  'PlaylistAdd',
  'SelectTrack',
  'PlaylistRemove',
  // O1 / O2
  'SetRepeat',
  'SetRandom',
  'Volume',
]);

export class GateGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateGuardError';
  }
}

export interface CommandLog {
  name: string;
  /** Attributes with any path/URI replaced by a structural description. */
  attributes: Record<string, string>;
  ok: boolean;
  ms: number;
  result: string | null;
  error?: string;
}

export interface PlaylistEntry {
  /** As reported by HQPlayer (observed 1-based). */
  engineIndex: number;
  uri: string | null;
  lengthMs: number | null;
}

export interface LiveStatus {
  transport: TransportState;
  /** Raw Status `track` value. */
  track: number | null;
  uri: string | null;
  /** Audible position (engine position − output delay). */
  positionMs: number;
  enginePositionMs: number;
  durationMs: number | null;
  outputDelayMs: number | null;
  tracksTotal: number | null;
  inputLabel: string | null;
  outputLabel: string | null;
  receivedAt: number;
}

const PATH_ATTRS = new Set(['uri', 'value']);

function sanitizeAttrs(
  name: string,
  attrs: Record<string, string | number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const s = String(v);
    out[k] = name === 'PlaylistAdd' && PATH_ATTRS.has(k) ? describeValue(s) : s;
  }
  return out;
}

export function toLiveStatus(doc: XmlElement, receivedAt = Date.now()): LiveStatus {
  const m = mapStatusDocument(doc, receivedAt);
  const meta = doc.children.find((c) => c.name === 'metadata');
  const position = attrFloat(doc, 'position');
  return {
    transport: m.transport,
    track: attrInt(doc, 'track'),
    uri: meta ? attrStr(meta, 'uri') : null,
    positionMs: m.positionMs,
    enginePositionMs: position !== null ? Math.round(position * 1000) : m.positionMs,
    durationMs: m.durationMs,
    outputDelayMs: m.outputDelayMs,
    tracksTotal: attrInt(doc, 'tracks_total'),
    inputLabel: m.input?.label ?? null,
    outputLabel: m.output?.label ?? null,
    receivedAt,
  };
}

export interface SessionOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Multiplies every wait (tests use a small value). */
  timeScale?: number;
}

/**
 * One guarded control connection for Gate C. Subscribes to Status pushes so steps can observe
 * the engine reacting, and logs every command (sanitised) for the report.
 */
export class GateCSession {
  readonly conn: HqpConnection;
  private latest: LiveStatus | null = null;
  private logSink: CommandLog[] | null = null;
  private allowedVolume: string | null = null;
  readonly timeScale: number;
  /** Applied to every error message that is logged for the report. */
  readonly redactor = new Redactor();

  constructor(private readonly options: SessionOptions) {
    this.timeScale = options.timeScale ?? 1;
    this.conn = new HqpConnection({
      host: options.host,
      port: options.port,
      connectTimeoutMs: options.timeoutMs ?? 3000,
      requestTimeoutMs: options.timeoutMs ?? 5000,
      allowSideEffects: true,
    });
    this.conn.onUnsolicited((doc) => {
      if (doc.name === 'Status') this.latest = toLiveStatus(doc);
    });
  }

  async open(): Promise<void> {
    await this.conn.connect();
    const first = await this.send('Status', { subscribe: 1 });
    this.latest = toLiveStatus(first);
  }

  close(): void {
    this.conn.close();
  }

  get connected(): boolean {
    return this.conn.connected;
  }

  /** Collect command logs into `sink` (one array per step). */
  capture(sink: CommandLog[] | null): void {
    this.logSink = sink;
  }

  /** O2 guard: Volume may only be set to exactly this (original) value string. */
  permitVolume(value: string | null): void {
    this.allowedVolume = value;
  }

  async send(name: string, attributes: Record<string, string | number> = {}): Promise<XmlElement> {
    if (!GATE_C_ALLOWED.has(name))
      throw new GateGuardError(`"${name}" is not part of the approved Gate C plan`);
    if (
      name === 'Volume' &&
      (this.allowedVolume === null || String(attributes.value) !== this.allowedVolume)
    ) {
      throw new GateGuardError(
        'Volume may only be set to the value read at the start (never louder)',
      );
    }
    const started = performance.now();
    const entry: CommandLog = {
      name,
      attributes: sanitizeAttrs(name, attributes),
      ok: false,
      ms: 0,
      result: null,
    };
    try {
      const doc = await this.conn.request(name, attributes);
      entry.ok = true;
      entry.result = doc.attributes.result ?? null;
      if (name === 'Status') this.latest = toLiveStatus(doc);
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

  status(): LiveStatus | null {
    return this.latest;
  }

  async state(): Promise<{ transport: TransportState; raw: Record<string, string> }> {
    const doc = await this.send('State');
    return { transport: mapTransport(attrInt(doc, 'state')), raw: { ...doc.attributes } };
  }

  async playlist(): Promise<{ albumMode: boolean | null; entries: PlaylistEntry[] }> {
    const doc = await this.send('PlaylistGet', { picture: 0 });
    return {
      albumMode: doc.attributes.album === undefined ? null : doc.attributes.album === '1',
      entries: findChildren(doc, 'PlaylistItem').map((item, i) => {
        const len = attrFloat(item, 'length');
        return {
          engineIndex: attrInt(item, 'index') ?? i + 1,
          uri: attrStr(item, 'uri'),
          lengthMs: len !== null ? Math.round(len * 1000) : null,
        };
      }),
    };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(1, Math.round(ms * this.timeScale))));
  }

  /** Wait until the pushed status satisfies `pred` (or time out). Returns the matching status. */
  async waitFor(pred: (s: LiveStatus) => boolean, timeoutMs: number): Promise<LiveStatus | null> {
    const deadline = Date.now() + timeoutMs * this.timeScale;
    for (;;) {
      const s = this.latest;
      if (s && pred(s)) return s;
      if (Date.now() > deadline || !this.conn.connected) return null;
      await new Promise((r) => setTimeout(r, Math.max(5, Math.round(100 * this.timeScale))));
    }
  }
}
