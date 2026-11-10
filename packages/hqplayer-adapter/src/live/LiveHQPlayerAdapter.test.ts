import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityUnavailableError,
  EngineCommandError,
  EngineTimeoutError,
  ProtocolError,
} from '../errors';
import { HqpConnection } from '../protocol/connection';
import { startFakeHqpServer, xmlDoc, type FakeHqpServer } from '../testing/fake-hqp-server';
import { LiveHQPlayerAdapter } from './LiveHQPlayerAdapter';

// NOTE: all server responses here are synthetic, shaped after SDK 6.0.1's parser expectations.
const INFO = xmlDoc(
  '<GetInfo name="PC" product="HQPlayer Desktop" version="6.0.1" platform="Windows" engine="6.0.1"/>',
);
// Attribute sets mirror what HQPlayer Desktop 6 / engine 6.1.0 returned to hqp-probe (2026-11-10):
// 1-based PlaylistItem indexes, tracks_total that does not reflect the playlist length,
// "file:" + raw Windows path URIs, VolumeRange enabled="0". Values are synthetic.
const VOLUME_RANGE = xmlDoc('<VolumeRange adaptive="0" enabled="0" max="0.000" min="-12.000"/>');
const playlistGet = (album = '0') =>
  xmlDoc(
    `<PlaylistGet album="${album}">` +
      '<PlaylistItem index="1" uri="file:D:\\Music\\A\\01.flac" song="Opening &amp;amp; Theme" artist="林夏" album="城市漫游者" length="244" rate="96000" bits="24" channels="2"/>' +
      '<PlaylistItem index="2" uri="file:D:\\Music\\A\\02 南方的风.flac" song="南方的风" artist="林夏" album="城市漫游者" length="230" rate="96000" bits="24" channels="2"/>' +
      '<PlaylistItem index="3" uri="file:D:\\Music\\A\\03.flac" song="午夜地铁" artist="林夏" album="城市漫游者" length="105" rate="96000" bits="24" channels="2"/>' +
      '</PlaylistGet>',
  );
const STOPPED = xmlDoc(
  '<Status state="0" track="2" tracks_total="0" position="0.000" length="0.000" volume="-6.02" active_mode="SDM (DSD)" active_filter="sinc-Mx" active_shaper="ASDM7EC-super 512+fs" active_rate="24576000" active_bits="1" active_channels="2" track_serial="56" transport_serial="6" repeat="0" random="0"/>',
);
const STATUS = xmlDoc(
  '<Status state="2" track="1" tracks_total="0" track_serial="56" transport_serial="6" position="12.5" length="200" volume="-14.5" active_mode="SDM" active_filter="poly-sinc-gauss-xla" active_shaper="ASDM7EC-ul" active_rate="22579200" active_bits="1" active_channels="2" repeat="0" random="0">' +
    '<metadata uri="D:\\Music\\A\\01.flac" song="Opening &amp;amp; Theme" artist="林夏" album="城市漫游者" samplerate="96000" bits="24" channels="2" sdm="0"/></Status>',
);

let server: FakeHqpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('HqpConnection', () => {
  it('matches responses to requests and survives split writes', async () => {
    server = await startFakeHqpServer({ GetInfo: () => INFO }, { splitWrites: true });
    const conn = new HqpConnection({ host: '127.0.0.1', port: server.port });
    await conn.connect();
    const info = await conn.request('GetInfo');
    expect(info.attributes.version).toBe('6.0.1');
    conn.close();
  });

  it('refuses side-effect commands on a read-only connection (safety interlock)', async () => {
    server = await startFakeHqpServer({});
    const conn = new HqpConnection({ host: '127.0.0.1', port: server.port });
    await conn.connect();
    expect(() => conn.request('Play')).toThrow(ProtocolError);
    expect(() => conn.request('SetFilter', { value: 1 })).toThrow(ProtocolError);
    expect(server.received).toHaveLength(0);
    conn.close();
  });

  it('rejects unknown (non-SDK) commands', async () => {
    server = await startFakeHqpServer({});
    const conn = new HqpConnection({ host: '127.0.0.1', port: server.port });
    await conn.connect();
    expect(() => conn.request('MadeUpCommand')).toThrow(/not in SDK/);
    conn.close();
  });

  it('times out without retrying and routes a late answer as unsolicited', async () => {
    server = await startFakeHqpServer({
      State: (_req, socket) => {
        setTimeout(() => socket.write(xmlDoc('<State state="0"/>')), 120);
        return null;
      },
    });
    const conn = new HqpConnection({ host: '127.0.0.1', port: server.port, requestTimeoutMs: 50 });
    const late: string[] = [];
    conn.onUnsolicited((doc) => late.push(doc.name));
    await conn.connect();
    await expect(conn.request('State')).rejects.toBeInstanceOf(EngineTimeoutError);
    await new Promise((r) => setTimeout(r, 150));
    expect(late).toEqual(['State']);
    expect(server.received.filter((r) => r.name === 'State')).toHaveLength(1);
    conn.close();
  });

  it('turns result="Error" into EngineCommandError', async () => {
    server = await startFakeHqpServer({ Play: () => xmlDoc('<Play result="Error">empty</Play>') });
    const conn = new HqpConnection({
      host: '127.0.0.1',
      port: server.port,
      allowSideEffects: true,
    });
    await conn.connect();
    await expect(conn.request('Play', { last: 0 })).rejects.toBeInstanceOf(EngineCommandError);
    conn.close();
  });

  it('fails fast when nothing listens on the port', async () => {
    const conn = new HqpConnection({ host: '127.0.0.1', port: 1, connectTimeoutMs: 500 });
    await expect(conn.connect()).rejects.toThrow(/Cannot connect|Timed out/);
  });
});

describe('LiveHQPlayerAdapter (experimental)', () => {
  it('connects read-only, maps identity and status, and receives Status pushes', async () => {
    server = await startFakeHqpServer({
      GetInfo: () => INFO,
      VolumeRange: () => VOLUME_RANGE,
      PlaylistGet: () => playlistGet('1'),
      Status: () => STATUS,
      State: () => xmlDoc('<State state="2" repeat="2" random="1"/>'),
    });
    const adapter = new LiveHQPlayerAdapter({ port: server.port });
    const seen: number[] = [];
    adapter.subscribeStatus((s) => seen.push(s.positionMs));
    await adapter.connect();

    const caps = await adapter.getCapabilities();
    expect(caps.engine?.version).toBe('6.0.1');
    expect(caps.items['status.read']).toMatchObject({ status: 'confirmed', usable: true });
    expect(caps.items['transport.play']).toMatchObject({ status: 'untested', usable: false });
    expect(caps.items['mode.album'].status).toBe('unsupported');

    const s = await adapter.getStatus();
    expect(s.connection).toBe('connected');
    expect(s.transport).toBe('playing');
    expect(s.positionMs).toBe(12_500);
    expect(s.durationMs).toBe(200_000);
    expect(s.track?.title).toBe('Opening & Theme');
    expect(s.track?.artist).toBe('林夏');
    expect(s.input?.label).toBe('PCM 96 kHz / 24-bit');
    expect(s.output?.label).toBe('DSD512');
    expect(s.repeat).toBe('all');
    expect(s.random).toBe(true);
    expect(s.trackIndex).toBe(0); // engine track="1" → Studio index 0
    expect(s.trackCount).toBe(3); // from PlaylistGet, not tracks_total="0"
    expect(s.albumMode).toBe(true);
    expect(s.volumeRange).toEqual({ min: -12, max: 0 });

    server.push(STATUS.replace('position="12.5"', 'position="13.5"'));
    await vi.waitFor(() => expect(seen.at(-1)).toBe(13_500), { timeout: 3000 });

    expect(server.received.map((r) => r.name)).toEqual([
      'GetInfo',
      'VolumeRange',
      'PlaylistGet',
      'Status',
      'State',
    ]);
    expect(server.received[3]?.attributes.subscribe).toBe('1');
    await adapter.disconnect();
  });

  it('blocks untested write commands by default (no engine traffic)', async () => {
    server = await startFakeHqpServer({
      GetInfo: () => INFO,
      VolumeRange: () => VOLUME_RANGE,
      PlaylistGet: () => playlistGet(),
      Status: () => STATUS,
    });
    const adapter = new LiveHQPlayerAdapter({ port: server.port });
    await adapter.connect();
    const before = server.received.length;
    await expect(adapter.play()).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(adapter.seek(1000)).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(
      adapter.replaceQueue([], { startIndex: 0, autoplay: true, albumMode: false }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
    expect(server.received.length).toBe(before);
    await adapter.disconnect();
  });

  it('with explicit Gate C consent, loads a queue via PlaylistClear/PlaylistAdd/SelectTrack/Play', async () => {
    server = await startFakeHqpServer({
      GetInfo: () => INFO,
      VolumeRange: () => VOLUME_RANGE,
      PlaylistGet: () => playlistGet(),
      Status: () => STATUS,
    });
    const adapter = new LiveHQPlayerAdapter({
      port: server.port,
      policy: { allowUntestedWrites: true },
    });
    await adapter.connect();
    await adapter.replaceQueue(
      [
        {
          studioTrackId: 'a',
          uri: 'D:\\音乐\\01 「光」.flac',
          title: 'a',
          artist: 'x',
          album: 'y',
          durationMs: 1,
        },
        {
          studioTrackId: 'b',
          uri: 'D:\\音乐\\02.dsf',
          title: 'b',
          artist: 'x',
          album: 'y',
          durationMs: 1,
        },
      ],
      { startIndex: 1, autoplay: true, albumMode: true },
    );
    const sent = server.received.slice(5).map((r) => [r.name, r.attributes]);
    expect(sent).toEqual([
      ['PlaylistClear', {}],
      ['PlaylistAdd', { uri: 'D:\\音乐\\01 「光」.flac', queued: '1', clear: '0' }],
      ['PlaylistAdd', { uri: 'D:\\音乐\\02.dsf', queued: '1', clear: '0' }],
      ['SelectTrack', { index: '2' }], // Studio index 1 → engine index 2 (1-based)
      ['Play', { last: '0' }],
    ]);
    await adapter.disconnect();
  });

  it('publishes a disconnected status when the engine goes away', async () => {
    server = await startFakeHqpServer({
      GetInfo: () => INFO,
      VolumeRange: () => VOLUME_RANGE,
      PlaylistGet: () => playlistGet(),
      Status: () => STATUS,
    });
    const adapter = new LiveHQPlayerAdapter({ port: server.port });
    await adapter.connect();
    await server.close();
    server = null;
    await vi.waitFor(
      async () => expect((await adapter.getStatus()).connection).toBe('disconnected'),
      {
        timeout: 3000,
      },
    );
    expect(adapter.isConnected()).toBe(false);
  });

  it('describes the selected track from the playlist while stopped, and maps 1-based indexes', async () => {
    let album = '0';
    server = await startFakeHqpServer({
      GetInfo: () => INFO,
      VolumeRange: () => VOLUME_RANGE,
      PlaylistGet: () => playlistGet(album),
      Status: () => STOPPED,
    });
    const adapter = new LiveHQPlayerAdapter({ port: server.port });
    await adapter.connect();
    const s = await adapter.getStatus();
    expect(s.transport).toBe('stopped');
    expect(s.trackIndex).toBe(1);
    expect(s.track).toMatchObject({
      title: '南方的风',
      uri: 'file:D:\\Music\\A\\02 南方的风.flac',
    });
    expect(s.durationMs).toBe(230_000);
    expect(s.trackCount).toBe(3);
    expect(s.output?.label).toBe('DSD512 (48k)');

    const queue = await adapter.getEngineQueue();
    expect(queue.entries.map((e) => e.index)).toEqual([0, 1, 2]);

    // a serial change (track/playlist changed elsewhere) triggers a read-only playlist refresh
    album = '1';
    const before = server.received.filter((r) => r.name === 'PlaylistGet').length;
    server.push(STOPPED.replace('track_serial="56"', 'track_serial="57"'));
    await vi.waitFor(async () => expect((await adapter.getStatus()).albumMode).toBe(true), {
      timeout: 3000,
    });
    expect(server.received.filter((r) => r.name === 'PlaylistGet').length).toBe(before + 1);
    await adapter.disconnect();
  });
});
