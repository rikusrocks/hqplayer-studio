import { StudioEventSchema, type StudioEvent } from '@hqps/contracts';

export type RealtimeState = 'connecting' | 'open' | 'closed';

export interface RealtimeOptions {
  url: string;
  /** WebSocket subprotocols, read on every (re)connect (they carry the LAN device token). */
  protocols?: () => string[];
  /** Injected for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type EventListener = (event: StudioEvent) => void;
type StateListener = (state: RealtimeState) => void;
type CloseListener = (code: number) => void;

/**
 * Reconnecting subscription to `WS /api/v1/events`. Every message is validated against the
 * shared contract; malformed messages are dropped (and logged) rather than trusted.
 */
export class StudioRealtime {
  private ws: WebSocket | null = null;
  private state: RealtimeState = 'closed';
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly closeListeners = new Set<CloseListener>();

  constructor(private readonly options: RealtimeOptions) {}

  get connectionState(): RealtimeState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Close code of every dropped connection (e.g. 4401 = this device's pairing was revoked). */
  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private open(): void {
    const Impl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      const protocols = this.options.protocols?.();
      ws = protocols?.length ? new Impl(this.options.url, protocols) : new Impl(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
    };
    ws.onmessage = (msg: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      const parsed = StudioEventSchema.safeParse(data);
      if (!parsed.success) {
        console.warn('[studio] dropped invalid realtime event', parsed.error.issues);
        return;
      }
      for (const l of this.eventListeners) l(parsed.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws === ws) this.ws = null;
      for (const l of this.closeListeners) l(ev.code);
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  private scheduleReconnect(): void {
    this.setState('closed');
    const min = this.options.minBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private setState(state: RealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    for (const l of this.stateListeners) l(state);
  }
}
