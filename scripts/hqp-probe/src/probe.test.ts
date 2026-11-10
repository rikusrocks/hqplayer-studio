import os from 'node:os';
import { HQP_COMMANDS } from '@hqps/hqplayer-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeHqpServer,
  xmlDoc,
  type FakeHqpServer,
} from '../../../packages/hqplayer-adapter/src/testing/fake-hqp-server';
import { READ_ONLY_PLAN, runProbe } from './probe';
import { describeValue } from './sanitize';

// Synthetic responses shaped after SDK 6.0.1 — not recordings of a real HQPlayer.
const SECRET_PATH = 'D:\\私人音乐\\Secret Artist\\01 Hidden Song.flac';
let server: FakeHqpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('read-only probe', () => {
  it('only plans SDK-documented, side-effect-free commands', () => {
    for (const step of READ_ONLY_PLAN) {
      const spec = HQP_COMMANDS.get(step.name);
      expect(spec, step.name).toBeDefined();
      expect(spec!.sideEffect).toBe('none');
    }
    expect(READ_ONLY_PLAN.map((s) => s.name)).not.toContain('GetLicense');
  });

  it('produces a sanitised report and never sends a write command', async () => {
    server = await startFakeHqpServer({
      GetInfo: () =>
        xmlDoc(
          '<GetInfo name="LIVINGROOM-PC" product="HQPlayer Desktop" version="6.0.3" platform="Windows" engine="6.0.3"/>',
        ),
      Status: (req, socket) => {
        if (req.attributes.subscribe === '1') {
          setTimeout(() => socket.write(xmlDoc('<Status state="2" position="1.0"/>')), 40);
          setTimeout(() => socket.write(xmlDoc('<Status state="2" position="1.1"/>')), 90);
        }
        return xmlDoc(
          `<Status state="2" track="0" position="12.5" length="200"><metadata uri="${SECRET_PATH.replace(/&/g, '&amp;')}" song="Hidden Song" artist="Secret Artist" samplerate="44100" bits="16" sdm="0"/></Status>`,
        );
      },
      GetModes: () =>
        xmlDoc(
          '<GetModes><ModesItem index="0" name="[source]" value="-1"/><ModesItem index="1" name="SDM" value="1"/></GetModes>',
        ),
      PlaylistGetList: () =>
        xmlDoc('<PlaylistGetList><Playlist name="My Private Mix"/></PlaylistGetList>'),
      PlaylistGet: () =>
        xmlDoc(
          `<PlaylistGet album="1"><PlaylistItem index="0" uri="file:///D:/%E7%A7%81/01.flac" song="Hidden Song"/></PlaylistGet>`,
        ),
      GetTransport: () => xmlDoc('<GetTransport value="5" arg="C:\\Users\\someone\\Music"/>'),
    });
    const { report } = await runProbe({
      port: server.port,
      timeoutMs: 300,
      subscribeWatchMs: 200,
      passiveListenMs: 20,
    });

    expect(report.summary.reachable).toBe(true);
    expect(report.summary.engine).toMatchObject({ version: '6.0.3', platform: 'Windows' });
    expect(report.statusSubscription.pushes).toBe(2);

    const json = JSON.stringify(report);
    for (const secret of [
      'LIVINGROOM-PC',
      'Hidden Song',
      'Secret Artist',
      '私人音乐',
      'My Private Mix',
      'someone',
      '%E7%A7%81',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(json).toContain('scheme=native-drive');
    expect(json).toContain('"album":"1"'); // numeric flags survive sanitising
    expect(json).toContain('scheme=file-uri');
    expect(json).toContain('"name":"SDM"'); // DSP option names are kept
    expect(json).not.toContain(os.hostname());

    const sentNames = new Set(server.received.map((r) => r.name));
    for (const name of sentNames) expect(HQP_COMMANDS.get(name)?.sideEffect, name).toBe('none');
  });

  it('writes a useful report when HQPlayer is not reachable', async () => {
    const { report } = await runProbe({ port: 1, timeoutMs: 300 });
    expect(report.summary.reachable).toBe(false);
    expect(report.gateA.tcpConnect.ok).toBe(false);
    expect(report.summary.notes.join(' ')).toMatch(/HQPlayer Desktop running/);
  });
});

describe('describeValue', () => {
  it('keeps the shape of paths without revealing them', () => {
    expect(describeValue('D:\\音乐\\A B\\01.dsf')).toBe(
      '[redacted path scheme=native-drive sep=backslash depth=4 ext=dsf nonAscii=yes pct=no spaces=yes len=16]',
    );
    expect(describeValue('\\\\NAS\\music\\x.flac')).toContain('scheme=unc');
    expect(describeValue('Some Title')).toBe('[redacted text len=10 nonAscii=no]');
    // the form observed on HQPlayer Desktop 6.1.0: "file:" + raw Windows path
    expect(describeValue('file:D:\\音乐\\A B\\01.flac')).toContain('prefix="file:" then=drive');
    expect(describeValue('file:///D:/a%20b/01.flac')).toContain('prefix="file:///" then=drive');
  });
});
