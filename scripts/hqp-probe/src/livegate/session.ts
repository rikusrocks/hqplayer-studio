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
import { describeValue, Redactor, sanitizeElement, type SanitizedElement } from '../sanitize';
import {
  GateGuardError,
  toLiveStatus,
  type CommandLog,
  type LiveStatus,
  type PlaylistEntry,
} from '../gatec/session';

/**
 * The only commands the live-input gate may send. Reads, Stop/Play, and the playlist commands
 * needed to put ONE live-input entry in the playlist and to put the original playlist back.
 * Everything else — SetTransport*, DSP, volume, output, configuration — is refused here before
 * it can reach the socket.
 */
export const LIVE_GATE_ALLOWED: ReadonlySet<string> = new Set([
  // read-only
  'GetInfo',
  'State',
  'Status',
  'GetInputs',
  'GetTransport',
  'PlaylistGet',
  // playback
  'Stop',
  'Play',
  'SelectTrack',
  // playlist (live entry in, original entries back)
  'PlaylistClear',
  'PlaylistAdd',
]);

export const isLiveUri = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^audio:\S/i.test(value);

/** Every `audio:` value found anywhere in a reply (attributes or text), in document order. */
export function findLiveUris(doc: XmlElement): string[] {
  const out: string[] = [];
  const visit = (el: XmlElement) => {
    for (const v of Object.values(el.attributes)) if (isLiveUri(v)) out.push(v);
    const text = el.text.trim();
    if (isLiveUri(text)) out.push(text);
    el.children.forEach(visit);
  };
  visit(doc);
  return [...new Set(out)];
}

/**
 * Sanitise a reply for the report, but keep `audio:` values as they are: they name an input
 * (device / rate / channels), not a file or a person, and their exact form is what this gate
 * is trying to learn.
 */
export function sanitizeLive(
  doc: XmlElement,
  extraSensitive: readonly string[] = [],
): SanitizedElement {
  const clean = sanitizeElement(doc, extraSensitive, 40);
  const restore = (from: XmlElement, to: SanitizedElement) => {
    for (const [k, v] of Object.entries(from.attributes)) if (isLiveUri(v)) to.attributes[k] = v;
    const text = from.text.trim();
    if (isLiveUri(text)) to.text = text;
    to.children?.forEach((child, i) => {
      const src = from.children[i];
      if (src) restore(src, child);
    });
  };
  restore(doc, clean);
  return clean;
}

export interface LiveSessionOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Multiplies every wait (tests use a small value). */
  timeScale?: number;
}

/**
 * One guarded control connection for the live-input gate. Besides the allowlist it enforces the
 * rule that matters here: PlaylistAdd may only carry a URI that was explicitly permitted — a
 * live-input candidate, or an entry of the playlist that was backed up at the start.
 */
export class LiveGateSession {
  readonly conn: HqpConnection;
  private latest: LiveStatus | null = null;
  private latestDoc: XmlElement | null = null;
  private statusLog: LiveStatus[] | null = null;
  private logSink: CommandLog[] | null = null;
  private permitted = new Set<string>();
  readonly timeScale: number;
  readonly redactor = new Redactor();

  constructor(options: LiveSessionOptions) {
    this.timeScale = options.timeScale ?? 1;
    this.conn = new HqpConnection({
      host: options.host,
      port: options.port,
      connectTimeoutMs: options.timeoutMs ?? 3000,
      requestTimeoutMs: options.timeoutMs ?? 5000,
      allowSideEffects: true,
    });
    this.conn.onUnsolicited((doc) => {
      if (doc.name === 'Status') this.noteStatus(doc);
    });
  }

  private noteStatus(doc: XmlElement): void {
    this.latest = toLiveStatus(doc);
    this.latestDoc = doc;
    this.statusLog?.push(this.latest);
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

  /** Record every pushed Status into `sink` (used while listening to the live input). */
  watchStatus(sink: LiveStatus[] | null): void {
    this.statusLog = sink;
  }

  /** Allow these exact URIs / paths in PlaylistAdd. */
  permit(...uris: (string | null | undefined)[]): void {
    for (const u of uris) if (u) this.permitted.add(u);
  }

  async send(name: string, attributes: Record<string, string | number> = {}): Promise<XmlElement> {
    if (!LIVE_GATE_ALLOWED.has(name))
      throw new GateGuardError(`"${name}" is not part of the live-input gate plan`);
    if (name === 'PlaylistAdd' && !this.permitted.has(String(attributes.uri)))
      throw new GateGuardError(
        'PlaylistAdd may only carry a live-input candidate or a backed-up entry',
      );
    const started = performance.now();
    const entry: CommandLog = {
      name,
      attributes: Object.fromEntries(
        Object.entries(attributes).map(([k, v]) => {
          const s = String(v);
          return [k, name === 'PlaylistAdd' && k === 'uri' && !isLiveUri(s) ? describeValue(s) : s];
        }),
      ),
      ok: false,
      ms: 0,
      result: null,
    };
    try {
      const doc = await this.conn.request(name, attributes);
      entry.ok = true;
      entry.result = doc.attributes.result ?? null;
      if (name === 'Status') this.noteStatus(doc);
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

  /** The last Status as the engine sent it, sanitised (titles and paths removed). */
  statusRaw(): SanitizedElement | null {
    return this.latestDoc ? sanitizeLive(this.latestDoc) : null;
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

  /**
   * Stop and wait for the engine to really be stopped. HQPlayer acknowledges Stop before it has
   * stopped, and a PlaylistClear sent too early keeps the playing entry (decision D-020).
   */
  async stopAndWait(timeoutMs = 10000): Promise<{ stopped: boolean; ms: number }> {
    const started = Date.now();
    await this.send('Stop');
    const st = await this.waitFor((x) => x.transport === 'stopped', timeoutMs);
    return { stopped: st !== null, ms: Date.now() - started };
  }
}
