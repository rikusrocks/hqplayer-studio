import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { RemoteAddressKind, RemoteInterface } from '@hqps/contracts';

/** Raw interface list in the shape of `os.networkInterfaces()` (injectable for tests). */
export type InterfaceProvider = () => NodeJS.Dict<
  Array<{ address: string; family: string | number; internal: boolean }>
>;

export const systemInterfaces: InterfaceProvider = () => networkInterfaces();

/**
 * Classify an IPv4 address. Only `private` (RFC 1918: 10/8, 172.16/12, 192.168/16) is accepted
 * for the Web Remote listener: Studio must never listen on a public address, on every interface
 * (0.0.0.0), or on carrier-grade NAT / VPN overlay ranges (100.64/10) by accident.
 */
export function classifyIPv4(address: string): RemoteAddressKind {
  if (!isIPv4(address)) return 'other';
  const [a, b] = address.split('.').map(Number) as [number, number, number, number];
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a >= 224) return 'other'; // multicast / reserved
  return 'public';
}

export function isPrivateLanAddress(address: string): boolean {
  return classifyIPv4(address) === 'private';
}

/** IPv4 interfaces of this computer (loopback excluded), private ones first. */
export function listLanInterfaces(
  provider: InterfaceProvider = systemInterfaces,
): RemoteInterface[] {
  const out: RemoteInterface[] = [];
  for (const [name, addrs] of Object.entries(provider())) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      const kind = classifyIPv4(a.address);
      if (kind === 'loopback') continue;
      out.push({ name, address: a.address, kind, usable: kind === 'private' });
    }
  }
  return out.sort((x, y) => Number(y.usable) - Number(x.usable));
}

export type BindResolution =
  | { ok: true; address: string; interfaceName: string }
  | { ok: false; error: 'address_unavailable' | 'address_not_private' };

/**
 * Decide where the LAN listener binds. The exact saved address wins; if the network changed
 * (DHCP gave the same interface a new address) the interface's current private address is used.
 * Never falls back to another interface or to 0.0.0.0.
 */
export function resolveBindAddress(
  pref: { address: string | null; interfaceName: string | null },
  interfaces: RemoteInterface[],
): BindResolution {
  if (pref.address) {
    const exact = interfaces.find((i) => i.address === pref.address);
    if (exact) {
      return exact.usable
        ? { ok: true, address: exact.address, interfaceName: exact.name }
        : { ok: false, error: 'address_not_private' };
    }
    if (!isPrivateLanAddress(pref.address) && classifyIPv4(pref.address) !== 'other') {
      return { ok: false, error: 'address_not_private' };
    }
  }
  if (pref.interfaceName) {
    const same = interfaces.find((i) => i.name === pref.interfaceName && i.usable);
    if (same) return { ok: true, address: same.address, interfaceName: same.name };
  }
  return { ok: false, error: 'address_unavailable' };
}
