import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Keeps phones able to find this PC on the Wi-Fi.
 *
 * Some Windows Wi-Fi drivers (seen with a MediaTek MT7902, 2026-11-18) stop answering ARP —
 * "who has 192.168.x.y?" — while their power saving is active. A phone then cannot reach the
 * remote at all, although the PC itself loads it fine; it starts working the moment the PC sends
 * the phone anything, because the PC's own ARP request tells the phone where the PC is.
 *
 * So while the LAN listener runs, Studio sends one empty UDP datagram (port 9, "discard") to
 * every paired device's last address once a minute, and — while a pairing code is shown, when a
 * phone's address is not known yet — to every address of the local /24 (at most 254 tiny
 * packets every 20 s, only on a home-sized network). Nothing is listened for and nothing is
 * read; the packets only make Windows announce the PC on the network.
 */
export interface LanAnnouncer {
  /** Send one empty datagram from `from` to each address in `to` (errors are ignored). */
  send(from: string, to: string[]): Promise<void>;
}

/** Datagrams go to the discard port: any reply is at most "port unreachable". */
export const ANNOUNCE_PORT = 9;

export const udpAnnouncer: LanAnnouncer = {
  send(from, to) {
    return new Promise((resolve) => {
      if (to.length === 0) return resolve();
      const socket = createSocket('udp4');
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve();
      };
      socket.on('error', done);
      socket.bind({ address: from, port: 0, exclusive: true }, () => {
        const payload = Buffer.alloc(1);
        let pending = to.length;
        for (const address of to) {
          socket.send(payload, ANNOUNCE_PORT, address, () => {
            pending -= 1;
            if (pending === 0) setTimeout(done, 50);
          });
        }
      });
      // never hold the event loop or a socket for long
      setTimeout(done, 5_000).unref?.();
    });
  },
};

const toInt = (ip: string): number =>
  ip.split('.').reduce((acc, part) => ((acc << 8) | (Number(part) & 255)) >>> 0, 0);
const toIp = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Prefix length of a dotted netmask (255.255.255.0 → 24), or null. */
export function prefixLength(netmask: string | null | undefined): number | null {
  if (!netmask || !isIPv4(netmask)) return null;
  const bits = toInt(netmask);
  let n = 0;
  while (n < 32 && bits & (0x8000_0000 >>> n)) n += 1;
  // a valid mask is contiguous ones
  return (bits << n) >>> 0 === 0 ? n : null;
}

/** Same network as `address` under `prefix`. */
export function inSubnet(address: string, candidate: string, prefix: number): boolean {
  if (!isIPv4(address) || !isIPv4(candidate)) return false;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (toInt(address) & mask) >>> 0 === (toInt(candidate) & mask) >>> 0;
}

/**
 * Every host address of `address`'s network, except `address` itself — only for a /24 or
 * smaller network (never sweeps anything bigger than 254 addresses).
 */
export function sweepTargets(address: string, prefix: number | null): string[] {
  if (prefix === null || prefix < 24 || prefix > 30 || !isIPv4(address)) return [];
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  const network = (toInt(address) & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const out: string[] = [];
  for (let i = 1; i < size - 1; i += 1) {
    const ip = toIp((network + i) >>> 0);
    if (ip !== address) out.push(ip);
  }
  return out;
}

/** Paired devices' last addresses that are on the same network (no duplicates, never self). */
export function deviceTargets(
  address: string,
  prefix: number | null,
  lastAddresses: Array<string | null>,
): string[] {
  const out = new Set<string>();
  for (const raw of lastAddresses) {
    if (!raw) continue;
    const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (ip === address || !isIPv4(ip)) continue;
    if (prefix !== null && !inSubnet(address, ip, prefix)) continue;
    out.add(ip);
  }
  return [...out];
}

/** Netmask of the interface that has `address`, from the system (null when not found). */
export function systemNetmask(address: string): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.address === address && (a.family === 'IPv4' || (a.family as unknown) === 4)) {
        return a.netmask;
      }
    }
  }
  return null;
}
