/**
 * Fixed-window counter per key (usually the client IP). Small and dependency-free: the LAN
 * listener serves a handful of phones, so an in-memory map is enough.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit. `ok: false` once the key used up its window. */
  hit(key: string): { ok: boolean; retryAfterMs: number } {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(t);
    }
    w.count += 1;
    const retryAfterMs = Math.max(0, w.start + this.windowMs - t);
    return { ok: w.count <= this.limit, retryAfterMs };
  }

  /** True while the key is over its limit (without counting a hit). */
  blocked(key: string): { blocked: boolean; retryAfterMs: number } {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs || w.count < this.limit) {
      return { blocked: false, retryAfterMs: 0 };
    }
    return { blocked: true, retryAfterMs: w.start + this.windowMs - t };
  }

  reset(key?: string): void {
    if (key === undefined) this.windows.clear();
    else this.windows.delete(key);
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
