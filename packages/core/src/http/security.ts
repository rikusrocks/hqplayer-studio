import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, WS_AUTH_PROTOCOL_PREFIX } from '@hqps/contracts';
import { mediaKeyFor, type AuthedDevice, type PairingService } from '../remote/pairing';
import { FixedWindowLimiter } from '../remote/rate-limit';
import { HttpError } from './errors';

/** Which listener an app instance serves: the loopback desktop app or the LAN Web Remote. */
export type StudioScope = 'local' | 'lan';

declare module 'fastify' {
  interface FastifyInstance {
    studioScope: StudioScope;
  }
  interface FastifyRequest {
    /** Paired device that authenticated this LAN request (null on loopback). */
    remoteDevice: AuthedDevice | null;
  }
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr !== undefined && LOOPBACK_ADDRESSES.has(addr);
}

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

/**
 * A client on this computer: loopback address *and* served by the loopback listener. Requests on
 * the LAN listener are never trusted, whatever their address — they never see local paths,
 * settings or diagnostics.
 */
export function isTrustedRequest(req: FastifyRequest): boolean {
  return req.server.studioScope !== 'lan' && isLoopbackAddress(req.socket.remoteAddress);
}

/**
 * Phase 0 security posture (see docs/architecture.md):
 *  - the server only binds to loopback; LAN remote access arrives with pairing in Phase 3;
 *  - every request must come from a loopback address (defence in depth);
 *  - Host must be a loopback name (blocks DNS-rebinding);
 *  - state-changing requests and WebSocket upgrades must carry a loopback Origin (or none),
 *    and JSON bodies must be sent as application/json (blocks cross-site form CSRF).
 */
export function registerSecurity(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const reject = (message: string): void => {
      if (isUpgrade) {
        // Rejected WebSocket upgrades must not leave the raw socket open.
        reply.hijack();
        req.socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      throw new HttpError(403, 'forbidden', message);
    };
    if (!isTrustedRequest(req)) {
      reject('Remote access is not enabled (LAN pairing arrives in Phase 3).');
      return;
    }
    const host = req.headers.host ?? '';
    if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
      reject('Unexpected Host header');
      return;
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const origin = req.headers.origin;
    if ((mutating || isUpgrade) && origin) {
      let ok: boolean;
      try {
        ok = LOOPBACK_HOSTNAMES.has(hostnameOf(new URL(origin).host));
      } catch {
        ok = false;
      }
      if (!ok) {
        reject('Cross-origin request rejected');
        return;
      }
    }
    if (mutating && req.url.startsWith('/api/')) {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.startsWith('application/json')) {
        throw new HttpError(415, 'invalid_request', 'Content-Type must be application/json');
      }
    }
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('X-Frame-Options', 'DENY');
  });
}

export const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// --- LAN listener (Web Remote, Phase 3) ----------------------------------------------------------

export const MEDIA_COOKIE = 'hqps_media';
const MEDIA_COOKIE_PATH = `${API_PREFIX}/artwork`;

export interface LanSecurityOptions {
  /** The address/port the LAN listener is bound to (Host and Origin must match it). */
  bound: { address: string; port: number };
  pairing: PairingService;
  /** All requests per client address per minute. Default 1200. */
  requestsPerMinute?: number;
  /** Failed authentications per client address before it is blocked. Default 30 / 10 min. */
  authFailures?: number;
  authFailureWindowMs?: number;
  now?: () => number;
}

function bearerToken(req: FastifyRequest): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,256})$/i.exec(req.headers.authorization ?? '');
  return m?.[1] ?? null;
}

function protocolToken(req: FastifyRequest): string | null {
  const raw = req.headers['sec-websocket-protocol'];
  if (typeof raw !== 'string') return null;
  for (const p of raw.split(',')) {
    const v = p.trim();
    if (v.startsWith(WS_AUTH_PROTOCOL_PREFIX)) return v.slice(WS_AUTH_PROTOCOL_PREFIX.length);
  }
  return null;
}

function cookieValue(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Artwork-only cookie: HttpOnly, SameSite=Strict, limited to the artwork path. */
export function setMediaCookie(reply: FastifyReply, mediaKey: string): void {
  void reply.header(
    'Set-Cookie',
    `${MEDIA_COOKIE}=${mediaKey}; Path=${MEDIA_COOKIE_PATH}; Max-Age=31536000; HttpOnly; SameSite=Strict`,
  );
}

/**
 * Security for the LAN listener (handoff §12.3). Deny by default:
 *  - per-address request rate limit; repeated authentication failures block the address;
 *  - Host must be the bound address (DNS rebinding); Origin, when sent, must be that same origin
 *    for writes and WebSocket upgrades; cross-site fetch metadata is refused; writes need JSON;
 *  - every `/api/` request needs a paired device: `Authorization: Bearer` (HTTP), the
 *    `hqps.auth.<token>` subprotocol (WebSocket), or — for artwork GETs only — the artwork
 *    cookie. Tokens in query strings are ignored.
 *  - public without a token: the remote's static files, `GET /remote/pairing-status` and
 *    `POST /remote/pair` (which has its own attempt limits).
 */
export function registerLanSecurity(app: FastifyInstance, opts: LanSecurityOptions): void {
  const now = opts.now ?? Date.now;
  const requests = new FixedWindowLimiter(opts.requestsPerMinute ?? 1200, 60_000, now);
  const failures = new FixedWindowLimiter(
    opts.authFailures ?? 30,
    opts.authFailureWindowMs ?? 10 * 60_000,
    now,
  );
  // Read per request: with port 0 (tests) the real port is known only after listen().
  const expectedHostOf = () =>
    opts.bound.port === 80 ? opts.bound.address : `${opts.bound.address}:${opts.bound.port}`;
  const pairPath = `${API_PREFIX}/remote/pair`;
  const statusPath = `${API_PREFIX}/remote/pairing-status`;
  const artworkPrefix = `${API_PREFIX}/artwork/`;

  app.addHook('onRequest', async (req, reply) => {
    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const client = req.socket.remoteAddress ?? 'unknown';
    const reject = (
      status: 401 | 403 | 429,
      code: 'forbidden' | 'unauthorized' | 'rate_limited',
      message: string,
      retryAfterMs?: number,
    ): void => {
      if (isUpgrade) {
        const text = { 401: 'Unauthorized', 403: 'Forbidden', 429: 'Too Many Requests' }[status];
        reply.hijack();
        req.socket.end(
          `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      if (retryAfterMs !== undefined) {
        void reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      throw new HttpError(status, code, message);
    };

    const rate = requests.hit(client);
    if (!rate.ok) return reject(429, 'rate_limited', 'Too many requests', rate.retryAfterMs);

    const expectedHost = expectedHostOf();
    const path = req.url.split('?')[0] ?? '';
    const lower = path.toLowerCase();
    const isApi = !lower.startsWith('/') || lower.startsWith('/api');
    if ((req.headers.host ?? '').toLowerCase() !== expectedHost) {
      // Someone typed the PC's name instead of its address: send page loads to the real origin
      // (a fixed absolute URL on our own address, so no open redirect). API calls stay refused.
      if (!isUpgrade && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
        return reply.redirect(`http://${expectedHost}${req.url}`);
      }
      return reject(403, 'forbidden', 'Unexpected Host header');
    }
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (isApi && req.headers['sec-fetch-site'] === 'cross-site') {
      return reject(403, 'forbidden', 'Cross-site request rejected');
    }
    const origin = req.headers.origin;
    if ((mutating || isUpgrade) && origin !== undefined) {
      const sameOrigin = (() => {
        try {
          const u = new URL(origin);
          return u.protocol === 'http:' && u.host === expectedHost;
        } catch {
          return false;
        }
      })();
      if (!sameOrigin) return reject(403, 'forbidden', 'Cross-origin request rejected');
    }
    if (mutating && isApi) {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.startsWith('application/json')) {
        throw new HttpError(415, 'invalid_request', 'Content-Type must be application/json');
      }
    }

    // --- authentication
    const token = isUpgrade ? protocolToken(req) : bearerToken(req);
    let device = opts.pairing.authenticate(token);
    if (!device && !isUpgrade && req.method === 'GET' && path.startsWith(artworkPrefix)) {
      device = opts.pairing.authenticateMedia(cookieValue(req, MEDIA_COOKIE));
    }
    const isPublic =
      (!mutating && !isApi && !isUpgrade) ||
      (req.method === 'GET' && path === statusPath) ||
      (req.method === 'POST' && path === pairPath);
    if (!device && !isPublic) {
      const blocked = failures.blocked(client);
      if (blocked.blocked) {
        return reject(429, 'rate_limited', 'Too many failed attempts', blocked.retryAfterMs);
      }
      failures.hit(client);
      return reject(401, 'unauthorized', 'This device is not paired with HQPlayer Studio');
    }
    req.remoteDevice = device;
    if (device) {
      opts.pairing.touch(device, client);
      // Keep the artwork cookie in step with the token (e.g. after Safari cleared cookies).
      if (token && !isUpgrade) {
        const mediaKey = mediaKeyFor(token);
        if (cookieValue(req, MEDIA_COOKIE) !== mediaKey) setMediaCookie(reply, mediaKey);
      }
    }

    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('X-Frame-Options', 'DENY');
    if (isApi) void reply.header('Cache-Control', 'no-store');
  });
}
