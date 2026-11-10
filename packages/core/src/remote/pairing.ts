import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  PAIRING_CODE_LENGTH,
  WS_CLOSE_UNAUTHORIZED,
  type PairingCode,
  type RemoteDevice,
} from '@hqps/contracts';
import type { RemoteDeviceRepository, RemoteDeviceRow } from '@hqps/library';
import { HttpError } from '../http/errors';
import { FixedWindowLimiter } from './rate-limit';

export interface PairingOptions {
  /** How long a pairing code is valid. Default 5 minutes. */
  codeTtlMs?: number;
  /** Wrong guesses before a code is burned (from any address). Default 5. */
  maxCodeAttempts?: number;
  /** Pairing attempts per client address per window. Default 10 per 10 minutes. */
  pairAttemptsPerWindow?: number;
  pairWindowMs?: number;
  maxDevices?: number;
  now?: () => number;
}

export type PairingFailure =
  'no_code' | 'expired' | 'wrong_code' | 'code_locked' | 'too_many_devices';

/** A device that authenticated this request. */
export interface AuthedDevice {
  id: string;
  name: string;
}

interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Artwork-only key derived from the device token (for the `<img>` cookie). */
export function mediaKeyFor(token: string): string {
  return createHmac('sha256', token).update('hqps-artwork-v1').digest('base64url');
}

/**
 * One-time pairing codes and long-lived per-device tokens for the Web Remote.
 *
 *  - a code is 6 digits, valid 5 minutes, single use, burned after 5 wrong guesses;
 *  - pairing attempts are rate limited per client address;
 *  - a token is 256 random bits, shown once (in the pairing response) and stored as SHA-256;
 *  - revoking a device deletes it and closes its realtime connections immediately.
 */
export class PairingService {
  private code: { value: string; expiresAt: number; failures: number } | null = null;
  private readonly byToken = new Map<string, AuthedDevice>();
  private readonly sockets = new Map<string, Set<ClosableSocket>>();
  private readonly lastTouch = new Map<string, { at: number; address: string | null }>();
  private readonly pairLimiter: FixedWindowLimiter;
  private readonly ttl: number;
  private readonly maxAttempts: number;
  private readonly maxDevices: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly repo: RemoteDeviceRepository,
    opts: PairingOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.codeTtlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxCodeAttempts ?? 5;
    this.maxDevices = opts.maxDevices ?? 32;
    this.pairLimiter = new FixedWindowLimiter(
      opts.pairAttemptsPerWindow ?? 10,
      opts.pairWindowMs ?? 10 * 60_000,
      this.now,
    );
  }

  /** Called whenever the code, the device list or a device's connection changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  // --- pairing codes (created on this computer only) ---------------------------------------

  createCode(): { code: string; expiresAt: number } {
    const value = String(randomInt(0, 10 ** PAIRING_CODE_LENGTH)).padStart(
      PAIRING_CODE_LENGTH,
      '0',
    );
    this.code = { value, expiresAt: this.now() + this.ttl, failures: 0 };
    this.changed();
    return { code: value, expiresAt: this.code.expiresAt };
  }

  cancelCode(): void {
    if (!this.code) return;
    this.code = null;
    this.changed();
  }

  /** The active code, or null when none / expired. */
  activeCode(): { code: string; expiresAt: number } | null {
    if (!this.code) return null;
    if (this.now() >= this.code.expiresAt) {
      this.code = null;
      return null;
    }
    return { code: this.code.value, expiresAt: this.code.expiresAt };
  }

  describeCode(urls: string[]): PairingCode | null {
    const c = this.activeCode();
    if (!c) return null;
    return { ...c, urls: urls.map((u) => `${u}#pair=${c.code}`) };
  }

  // --- pairing (LAN) -----------------------------------------------------------------------

  /**
   * Exchange a code for a device token. Throws HttpError with `details.reason` so the remote can
   * explain what went wrong (codes: 409 no/expired/locked code, 401 wrong code, 429 rate limit).
   */
  pair(
    code: string,
    deviceName: string,
    clientAddress: string,
  ): { token: string; mediaKey: string; device: AuthedDevice } {
    const limit = this.pairLimiter.hit(clientAddress);
    if (!limit.ok) {
      throw new HttpError(429, 'rate_limited', 'Too many pairing attempts. Try again later.', {
        retryAfterSec: Math.ceil(limit.retryAfterMs / 1000),
      });
    }
    const fail = (status: number, reason: PairingFailure, message: string, extra = {}) =>
      new HttpError(status, status === 401 ? 'unauthorized' : 'conflict', message, {
        reason,
        ...extra,
      });
    const active = this.code;
    if (!active) {
      throw fail(409, 'no_code', 'No pairing code is active. Create one on the computer.');
    }
    if (this.now() >= active.expiresAt) {
      this.code = null;
      this.changed();
      throw fail(409, 'expired', 'The pairing code has expired. Create a new one.');
    }
    const ok =
      code.length === active.value.length &&
      timingSafeEqual(Buffer.from(code), Buffer.from(active.value));
    if (!ok) {
      active.failures += 1;
      if (active.failures >= this.maxAttempts) {
        this.code = null;
        this.changed();
        throw fail(409, 'code_locked', 'Too many wrong codes. Create a new code on the computer.');
      }
      throw fail(401, 'wrong_code', 'Wrong pairing code.', {
        attemptsLeft: this.maxAttempts - active.failures,
      });
    }
    if (this.repo.count() >= this.maxDevices) {
      throw fail(409, 'too_many_devices', 'Too many paired devices. Remove one first.');
    }
    const token = randomBytes(32).toString('base64url');
    const mediaKey = mediaKeyFor(token);
    const row = this.repo.create({
      id: `dev_${randomUUID()}`,
      name: deviceName,
      tokenHash: sha256(token),
      mediaHash: sha256(mediaKey),
      createdAt: this.now(),
    });
    this.repo.touch(row.id, this.now(), clientAddress);
    this.code = null; // single use
    this.pairLimiter.reset(clientAddress);
    this.changed();
    return { token, mediaKey, device: { id: row.id, name: row.name } };
  }

  // --- authentication ----------------------------------------------------------------------

  /** Device for a bearer token, or null. Only hashes are compared with stored values. */
  authenticate(token: string | null | undefined): AuthedDevice | null {
    if (!token || token.length > 256) return null;
    const hash = sha256(token);
    const cached = this.byToken.get(hash);
    if (cached) return cached;
    const row = this.repo.findByTokenHash(hash);
    if (!row) return null;
    const device = { id: row.id, name: row.name };
    this.byToken.set(hash, device);
    return device;
  }

  /** Device for the artwork-only cookie value, or null. */
  authenticateMedia(mediaKey: string | null | undefined): AuthedDevice | null {
    if (!mediaKey || mediaKey.length > 256) return null;
    const row = this.repo.findByMediaHash(sha256(mediaKey));
    return row ? { id: row.id, name: row.name } : null;
  }

  /** Record that a device was seen (DB write at most once a minute, or when its IP changes). */
  touch(device: AuthedDevice, address: string | null): void {
    const t = this.now();
    const last = this.lastTouch.get(device.id);
    if (last && t - last.at < 60_000 && last.address === address) return;
    this.lastTouch.set(device.id, { at: t, address });
    this.repo.touch(device.id, t, address);
  }

  // --- devices -----------------------------------------------------------------------------

  list(): RemoteDevice[] {
    return this.repo.list().map((r: RemoteDeviceRow) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      lastAddress: r.lastAddress,
      connected: (this.sockets.get(r.id)?.size ?? 0) > 0,
    }));
  }

  /** Forget a device: its token stops working and its open connections are closed now. */
  revoke(id: string): boolean {
    const removed = this.repo.delete(id);
    for (const [hash, d] of this.byToken) if (d.id === id) this.byToken.delete(hash);
    this.lastTouch.delete(id);
    const open = this.sockets.get(id);
    this.sockets.delete(id);
    for (const s of open ?? []) s.close(WS_CLOSE_UNAUTHORIZED, 'device revoked');
    if (removed) this.changed();
    return removed;
  }

  /** Track a device's realtime connection (for "connected" and for revocation). */
  trackSocket(deviceId: string, socket: ClosableSocket): () => void {
    let set = this.sockets.get(deviceId);
    if (!set) {
      set = new Set();
      this.sockets.set(deviceId, set);
    }
    set.add(socket);
    this.changed();
    return () => {
      const s = this.sockets.get(deviceId);
      if (!s?.delete(socket)) return;
      if (s.size === 0) this.sockets.delete(deviceId);
      this.changed();
    };
  }
}
