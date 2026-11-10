import { normalizePairingCode, PairRequestSchema } from '@hqps/contracts';
import { describe, expect, it } from 'vitest';
import { classifyIPv4, listLanInterfaces, resolveBindAddress } from './lan-address';
import { FixedWindowLimiter } from './rate-limit';
import { opaqueUri, redactPaths, REDACTED_PATH, sanitizeForLan } from './sanitize';

describe('LAN address rules', () => {
  it('accepts only RFC 1918 private IPv4 addresses', () => {
    expect(classifyIPv4('192.168.1.20')).toBe('private');
    expect(classifyIPv4('10.0.0.5')).toBe('private');
    expect(classifyIPv4('172.16.0.1')).toBe('private');
    expect(classifyIPv4('172.31.255.254')).toBe('private');
    expect(classifyIPv4('172.32.0.1')).toBe('public');
    expect(classifyIPv4('8.8.8.8')).toBe('public');
    expect(classifyIPv4('0.0.0.0')).toBe('unspecified');
    expect(classifyIPv4('127.0.0.1')).toBe('loopback');
    expect(classifyIPv4('169.254.10.1')).toBe('link_local');
    expect(classifyIPv4('100.64.0.1')).toBe('cgnat');
    expect(classifyIPv4('224.0.0.1')).toBe('other');
    expect(classifyIPv4('::')).toBe('other');
    expect(classifyIPv4('fd00::1')).toBe('other');
  });

  it('lists IPv4 interfaces without loopback, private first', () => {
    const list = listLanInterfaces(() => ({
      'Wi-Fi': [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      Ethernet: [
        { address: '192.168.1.20', family: 4, internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    }));
    expect(list.map((i) => [i.name, i.address, i.usable])).toEqual([
      ['Ethernet', '192.168.1.20', true],
      ['Wi-Fi', '203.0.113.7', false],
    ]);
  });

  it('binds the saved address, follows its interface, and never falls back elsewhere', () => {
    const ifaces = [
      { name: 'Ethernet', address: '192.168.1.33', kind: 'private' as const, usable: true },
      { name: 'Wi-Fi', address: '10.0.0.8', kind: 'private' as const, usable: true },
      { name: 'WAN', address: '203.0.113.7', kind: 'public' as const, usable: false },
    ];
    expect(resolveBindAddress({ address: '10.0.0.8', interfaceName: 'Wi-Fi' }, ifaces)).toEqual({
      ok: true,
      address: '10.0.0.8',
      interfaceName: 'Wi-Fi',
    });
    // DHCP moved Ethernet from .20 to .33
    expect(
      resolveBindAddress({ address: '192.168.1.20', interfaceName: 'Ethernet' }, ifaces),
    ).toMatchObject({ ok: true, address: '192.168.1.33' });
    // gone: no other interface is picked instead
    expect(
      resolveBindAddress({ address: '192.168.1.20', interfaceName: 'USB LAN' }, ifaces),
    ).toEqual({ ok: false, error: 'address_unavailable' });
    expect(resolveBindAddress({ address: '203.0.113.7', interfaceName: 'WAN' }, ifaces)).toEqual({
      ok: false,
      error: 'address_not_private',
    });
    expect(resolveBindAddress({ address: '0.0.0.0', interfaceName: null }, ifaces)).toMatchObject({
      ok: false,
    });
    expect(resolveBindAddress({ address: null, interfaceName: null }, ifaces)).toEqual({
      ok: false,
      error: 'address_unavailable',
    });
  });
});

describe('LAN sanitiser', () => {
  it('removes Windows, UNC, file: and home paths from text', () => {
    expect(redactPaths("ENOENT: no such file or directory, scandir 'D:\\Music\\新しい'")).toBe(
      `ENOENT: no such file or directory, scandir '${REDACTED_PATH}'`,
    );
    // unquoted paths with spaces take the rest of the line with them
    expect(redactPaths('cannot read \\\\NAS\\music\\a b.flac now')).toBe(
      `cannot read ${REDACTED_PATH}`,
    );
    expect(redactPaths('"D:\\My Music\\x.flac" failed')).toBe(`"${REDACTED_PATH}" failed`);
    expect(redactPaths('file://E:\\x.flac')).toBe(REDACTED_PATH);
    expect(redactPaths('open /Users/someone/Music/a.flac')).toBe(`open ${REDACTED_PATH}`);
    // ordinary titles are left alone
    for (const s of ['AC/DC', 'Op. 9: Nocturne', 'Disc 1/2', 'Live at Home', 'C: The Album']) {
      expect(redactPaths(s)).toBe(s);
    }
  });

  it('turns uri fields into opaque ids and walks nested payloads', () => {
    const out = sanitizeForLan({
      status: { track: { uri: 'file://D:\\Music\\a.flac', title: 'A' }, lastError: 'D:\\x' },
      list: [{ uri: null }, 'Z:\\y'],
      n: 3,
    });
    expect(out).toEqual({
      status: {
        track: { uri: opaqueUri('file://D:\\Music\\a.flac'), title: 'A' },
        lastError: REDACTED_PATH,
      },
      list: [{ uri: null }, REDACTED_PATH],
      n: 3,
    });
    expect(opaqueUri('a')).toBe(opaqueUri('a'));
    expect(opaqueUri('a')).not.toBe(opaqueUri('b'));
  });
});

describe('rate limiter', () => {
  it('counts per key in fixed windows', () => {
    let t = 0;
    const l = new FixedWindowLimiter(2, 1000, () => t);
    expect(l.hit('a').ok).toBe(true);
    expect(l.hit('a').ok).toBe(true);
    expect(l.blocked('a').blocked).toBe(true);
    expect(l.hit('a')).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(l.hit('b').ok).toBe(true);
    t = 999;
    expect(l.hit('a').ok).toBe(false);
    t = 1000;
    expect(l.hit('a').ok).toBe(true);
    l.reset('a');
    expect(l.blocked('a').blocked).toBe(false);
  });
});

describe('pairing request validation', () => {
  it('normalises codes and cleans device names', () => {
    expect(normalizePairingCode('482 913')).toBe('482913');
    expect(normalizePairingCode('482-913')).toBe('482913');
    expect(PairRequestSchema.parse({ code: '482 913', deviceName: ' iPhone\n ' })).toEqual({
      code: '482913',
      deviceName: 'iPhone',
    });
    expect(PairRequestSchema.safeParse({ code: '12345', deviceName: 'x' }).success).toBe(false);
    expect(PairRequestSchema.safeParse({ code: 'abcdef', deviceName: 'x' }).success).toBe(false);
    expect(PairRequestSchema.safeParse({ code: '123456', deviceName: '' }).success).toBe(false);
    expect(
      PairRequestSchema.safeParse({ code: '123456', deviceName: 'x'.repeat(61) }).success,
    ).toBe(false);
  });
});
