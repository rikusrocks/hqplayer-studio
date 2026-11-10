import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './errors';

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

export function isTrustedRequest(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
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
