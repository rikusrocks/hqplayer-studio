/**
 * A well-behaved JSON-over-HTTP client for third-party services (lyrics, cover art). Shared house
 * rules, from the handoff (§8.4):
 *  - identify the app with a User-Agent (name + version; no homepage link, which would carry the
 *    maintainer's account name);
 *  - one request at a time and at least `minIntervalMs` between requests — never a burst;
 *  - honour 429 + Retry-After; after errors back off instead of retrying immediately;
 *  - never log or return response bodies in errors (they may contain lyrics).
 *
 * No Node-only APIs: `fetch` is injected or global.
 */

export type OnlineFailure = 'rate_limited' | 'unavailable' | 'bad_response';

/** A service could not answer right now. `retryAfterMs`: when the client will send again. */
export class OnlineUnavailableError extends Error {
  constructor(
    readonly reason: OnlineFailure,
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'OnlineUnavailableError';
  }
}

export interface PoliteHttpOptions {
  /** Name used in error messages, e.g. "LRCLIB". */
  service: string;
  /** e.g. "HQPlayerStudio/0.3.0 (unofficial HQPlayer Desktop client)". */
  userAgent: string;
  fetch?: typeof fetch;
  /** Extra request headers (e.g. a Referer some services expect). */
  headers?: Record<string, string>;
  /** Abort a request after this long. Default 15 s. */
  timeoutMs?: number;
  /** Minimum gap between the start of two requests. Default 1 s. */
  minIntervalMs?: number;
  /** Back-off after a 429 without Retry-After. Default 60 s. */
  defaultRetryAfterMs?: number;
  /** Back-off after a network error / 5xx. Default 30 s. */
  errorBackoffMs?: number;
  /**
   * Each further failure in a row multiplies the error back-off by this (1 = always the same
   * pause). A service that stays unreachable is then asked less and less often.
   */
  errorBackoffGrowth?: number;
  /** Upper bound for any back-off (a hostile Retry-After cannot park us for days). Default 1 h. */
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Build the error thrown to callers (lets a client keep its own error class). */
  makeError?: (reason: OnlineFailure, retryAfterMs: number, message: string) => Error;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse a Retry-After header: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export class PoliteHttp {
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private blockedReason: OnlineFailure = 'unavailable';
  private failuresInARow = 0;
  /** Requests actually sent (tests / diagnostics). */
  requestCount = 0;

  constructor(private readonly opts: PoliteHttpOptions) {
    this.doFetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Milliseconds until the client sends again (0 = not backing off). */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** The service answered, but not with what its API promises. No back-off. */
  badResponse(): Error {
    return this.error('bad_response', 0, `${this.opts.service} returned an unexpected response`);
  }

  /**
   * The service said "not now" inside a normal answer (quota codes in a 200 body…): pause like
   * after an HTTP error and return the error to throw.
   */
  pause(reason: OnlineFailure, ms?: number): Error {
    return this.backOff(reason, ms ?? this.errorBackoff());
  }

  /**
   * GET → parsed JSON, or null for 404. One request at a time, spaced out; during a back-off
   * window it fails fast without any traffic.
   */
  getJson(url: string | URL, params: Record<string, string> = {}): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const blocked = this.blockedForMs();
      if (blocked > 0) {
        throw this.error(
          this.blockedReason,
          blocked,
          `${this.opts.service} paused for ${Math.ceil(blocked / 1000)} s`,
        );
      }
      const wait = this.lastStart + (this.opts.minIntervalMs ?? 1000) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return this.request(url, params);
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private error(reason: OnlineFailure, retryAfterMs: number, message: string): Error {
    return (
      this.opts.makeError?.(reason, retryAfterMs, message) ??
      new OnlineUnavailableError(reason, retryAfterMs, message)
    );
  }

  private errorBackoff(): number {
    const growth = Math.max(1, this.opts.errorBackoffGrowth ?? 1);
    return (this.opts.errorBackoffMs ?? 30_000) * growth ** Math.min(this.failuresInARow, 16);
  }

  private backOff(reason: OnlineFailure, ms: number): Error {
    const capped = Math.min(Math.max(ms, 1000), this.opts.maxBackoffMs ?? 3_600_000);
    this.blockedUntil = this.now() + capped;
    this.blockedReason = reason;
    this.failuresInARow += 1;
    return this.error(
      reason,
      capped,
      reason === 'rate_limited'
        ? `${this.opts.service} asked us to slow down (429)`
        : `${this.opts.service} is not reachable right now`,
    );
  }

  private async request(target: string | URL, params: Record<string, string>): Promise<unknown> {
    const url = new URL(String(target));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      this.requestCount += 1;
      res = await this.doFetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.opts.userAgent,
          Accept: 'application/json',
          ...this.opts.headers,
        },
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw this.backOff('unavailable', this.errorBackoff());
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      this.failuresInARow = 0;
      return null;
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const after = parseRetryAfter(res.headers.get('retry-after'), this.now());
      throw this.backOff('rate_limited', after ?? this.opts.defaultRetryAfterMs ?? 60_000);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // 503 may carry Retry-After as well.
      const after = parseRetryAfter(res.headers.get('retry-after'), this.now());
      throw this.backOff('unavailable', after ?? this.errorBackoff());
    }
    this.failuresInARow = 0;
    try {
      return (await res.json()) as unknown;
    } catch {
      throw this.badResponse();
    }
  }
}
