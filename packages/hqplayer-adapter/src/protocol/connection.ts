import net from 'node:net';
import {
  EngineCommandError,
  EngineTimeoutError,
  EngineUnavailableError,
  ProtocolError,
} from '../errors';
import { getCommand, isReadOnly, type CommandSpec } from './commands';
import { XmlDocumentFramer } from './framer';
import {
  parseXmlDocument,
  serializeDocument,
  type AttributeValue,
  type XmlChildSpec,
  type XmlElement,
} from './xml';

export interface TranscriptEntry {
  direction: 'out' | 'in' | 'event';
  at: number;
  text: string;
}

export interface HqpConnectionOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Safety interlock: when false (default) only read-only commands (sideEffect "none") and the
   * session-scoped Status subscription may be sent. Write commands require an explicit opt-in.
   */
  allowSideEffects?: boolean;
  onTranscript?: (entry: TranscriptEntry) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  children?: XmlChildSpec[];
}

interface InFlight {
  name: string;
  resolve: (doc: XmlElement) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type DocListener = (doc: XmlElement, raw: string) => void;
type CloseListener = (hadError: boolean, reason: string | null) => void;

/**
 * One TCP control connection to HQPlayer (default 127.0.0.1:4321).
 *
 * - Requests are serialised: one outstanding command at a time, matched by root element name
 *   (the SDK client relies on the response root echoing the command name).
 * - A timeout rejects with EngineTimeoutError and is never retried here.
 * - Documents that do not answer the in-flight request (e.g. Status pushes after
 *   `Status subscribe="1"`) are delivered to `onUnsolicited` listeners.
 */
export class HqpConnection {
  private socket: net.Socket | null = null;
  private readonly framer = new XmlDocumentFramer();
  private inFlight: InFlight | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly unsolicited = new Set<DocListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private closing = false;

  constructor(private readonly options: HqpConnectionOptions) {}

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.readyState === 'open';
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.closing = false;
    this.framer.reset();
    const { host, port, connectTimeoutMs = 3000 } = this.options;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new EngineUnavailableError(`Timed out connecting to ${host}:${port}`));
      }, connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setKeepAlive(true, 10_000);
        this.socket = socket;
        this.trace('event', `connected ${host}:${port}`);
        resolve();
      });
      socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (this.socket !== socket) {
          reject(
            new EngineUnavailableError(
              `Cannot connect to ${host}:${port} (${err.code ?? err.message})`,
            ),
          );
        }
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('close', (hadError) => {
        if (this.socket === socket) this.handleClose(hadError, hadError ? 'socket error' : null);
      });
    });
  }

  close(): void {
    this.closing = true;
    this.socket?.destroy();
    if (this.socket) this.handleClose(false, 'closed by client');
  }

  onUnsolicited(listener: DocListener): () => void {
    this.unsolicited.add(listener);
    return () => this.unsolicited.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** SDK sendKeepAlive(): a single space. */
  sendKeepAlive(): void {
    this.write(' ');
  }

  /**
   * Send an SDK-documented command and resolve with its response document.
   * Rejects with EngineCommandError when the engine answers result="Error".
   */
  request(
    name: string,
    attributes: Record<string, AttributeValue> = {},
    options: RequestOptions = {},
  ): Promise<XmlElement> {
    const spec = getCommand(name);
    this.assertAllowed(spec, attributes);
    const run = () => this.send(spec, attributes, options);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private assertAllowed(spec: CommandSpec, attributes: Record<string, AttributeValue>): void {
    if (this.options.allowSideEffects) return;
    if (isReadOnly(spec)) return;
    if (spec.name === 'Status') return; // subscription is connection-scoped
    void attributes;
    throw new ProtocolError(
      `Refusing to send "${spec.name}" (${spec.sideEffect}) on a read-only connection`,
    );
  }

  private send(
    spec: CommandSpec,
    attributes: Record<string, AttributeValue>,
    options: RequestOptions,
  ): Promise<XmlElement> {
    if (!this.connected) return Promise.reject(new EngineUnavailableError());
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 5000;
    return new Promise<XmlElement>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.inFlight?.timer === timer) this.inFlight = null;
        this.trace('event', `timeout waiting for ${spec.name} (${timeoutMs} ms)`);
        reject(new EngineTimeoutError(spec.name, timeoutMs));
      }, timeoutMs);
      this.inFlight = { name: spec.name, resolve, reject, timer };
      this.write(serializeDocument(spec.name, attributes, options.children));
    });
  }

  private write(text: string): void {
    if (!this.socket) throw new EngineUnavailableError();
    this.trace('out', text);
    this.socket.write(text, 'utf8');
  }

  private onData(chunk: Buffer): void {
    let docs: string[];
    try {
      docs = this.framer.push(chunk);
    } catch (err) {
      this.trace('event', `framing error: ${(err as Error).message}`);
      this.socket?.destroy();
      return;
    }
    for (const raw of docs) {
      this.trace('in', raw);
      let doc: XmlElement;
      try {
        doc = parseXmlDocument(raw);
      } catch (err) {
        this.trace('event', `parse error: ${(err as Error).message}`);
        continue;
      }
      const pending = this.inFlight;
      if (pending && doc.name === pending.name) {
        clearTimeout(pending.timer);
        this.inFlight = null;
        if (doc.attributes.result === 'Error') {
          pending.reject(new EngineCommandError(pending.name, doc.text.trim()));
        } else {
          pending.resolve(doc);
        }
        continue;
      }
      for (const l of this.unsolicited) l(doc, raw);
    }
  }

  private handleClose(hadError: boolean, reason: string | null): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    this.trace('event', `disconnected${reason ? ` (${reason})` : ''}`);
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.reject(new EngineUnavailableError('Connection closed before response'));
      this.inFlight = null;
    }
    for (const l of this.closeListeners) l(hadError && !this.closing, reason);
  }

  private trace(direction: TranscriptEntry['direction'], text: string): void {
    this.options.onTranscript?.({ direction, at: Date.now(), text });
  }
}
