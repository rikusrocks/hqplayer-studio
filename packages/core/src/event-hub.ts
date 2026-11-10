import type { StudioEvent } from '@hqps/contracts';

type Listener = (event: StudioEvent) => void;

/** In-process fan-out of Studio events to WebSocket clients and internal services. */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  publish(event: StudioEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[studio] event listener failed', err);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  notice(
    level: 'info' | 'warning' | 'error',
    code: string,
    message: string,
    params?: Record<string, string | number>,
  ): void {
    this.publish({ type: 'notice', level, code, message, ...(params ? { params } : {}) });
  }
}
