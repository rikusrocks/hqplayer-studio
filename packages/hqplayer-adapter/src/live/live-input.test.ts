import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityUnavailableError } from '../errors';
import { MockHQPlayerAdapter } from '../mock/MockHQPlayerAdapter';
import { startFakeEngine, type FakeEngine, type FakeEngineOptions } from '../testing/fake-engine';
import { LiveHQPlayerAdapter } from './LiveHQPlayerAdapter';

const FILES = Array.from({ length: 3 }, (_, i) => ({
  uri: `file://D:\\Music\\Album\\0${i + 1}.flac`,
  song: `Song ${i + 1}`,
  lengthSec: 300,
}));

let engine: FakeEngine | null = null;
let adapter: LiveHQPlayerAdapter | null = null;
afterEach(async () => {
  await adapter?.disconnect();
  await engine?.close();
  adapter = null;
  engine = null;
});

async function connect(
  policy: { controlEnabled?: boolean; liveInputEnabled?: boolean },
  opts: Partial<FakeEngineOptions> = {},
) {
  engine = await startFakeEngine({ playlist: FILES, pushEveryMs: 10, ...opts });
  adapter = new LiveHQPlayerAdapter({
    port: engine.port,
    policy,
    stopSettleMs: 500,
    clearRetryMs: 10,
    liveStartMs: 300,
  });
  await adapter.connect();
  return { engine, adapter };
}

const ON = { controlEnabled: true, liveInputEnabled: true };
const sent = (e: FakeEngine, name: string) => e.received.filter((r) => r.name === name);

describe('live input (live adapter)', () => {
  it('is unverified, so only the user’s own switch enables it', async () => {
    const { engine, adapter } = await connect({ controlEnabled: true });
    const caps = await adapter.getCapabilities();
    expect(caps.items['input.live']).toMatchObject({
      status: 'untested',
      usable: false,
      note: 'live-input-disabled',
    });
    await expect(adapter.playLiveInput(['audio:default/0/2'])).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );
    expect(sent(engine, 'PlaylistAdd')).toEqual([]);
    expect(sent(engine, 'PlaylistClear')).toEqual([]);

    adapter.setPolicy({ liveInputEnabled: true });
    expect((await adapter.getCapabilities()).items['input.live']).toMatchObject({
      usable: false,
      note: 'control-disabled',
    });
    adapter.setPolicy(ON);
    expect((await adapter.getCapabilities()).items['input.live'].usable).toBe(true);
  });

  it('lists what HQPlayer offers without needing any switch', async () => {
    const { adapter } = await connect({}, { liveInputs: ['audio:default/0/2'] });
    expect(await adapter.getLiveInputs()).toEqual({ uris: ['audio:default/0/2'], names: [] });
  });

  it('stops a playing file, loads ONE live entry and plays it', async () => {
    const { engine, adapter } = await connect(ON, {
      liveInputs: ['audio:default/0/2'],
      startPlaying: true,
      stopDelayMs: 60,
    });
    const result = await adapter.playLiveInput(['audio:default/0/2', 'audio:default/44100/2']);
    expect(result.uri).toBe('audio:default/0/2');
    expect(result.attempts).toEqual([
      {
        uri: 'audio:default/0/2',
        addAccepted: true,
        playAccepted: true,
        reachedPlaying: true,
        error: null,
      },
    ]);
    expect(engine.playlist().map((t) => t.uri)).toEqual(['audio:default/0/2']);
    expect(engine.state().transport).toBe(2);
    const status = await adapter.getStatus();
    expect(status.transport).toBe('playing');
    expect(status.track?.uri).toBe('audio:default/0/2');
    expect(status.trackCount).toBe(1);
  });

  it('moves on when HQPlayer refuses a URI or refuses to play it', async () => {
    const { engine, adapter } = await connect(ON, {
      liveInputs: ['audio:default/0/2', 'audio:default/48000/2'],
      liveInputsFailingPlay: ['audio:default/0/2'],
    });
    const result = await adapter.playLiveInput([
      'audio:cable/0/2',
      'not-live.flac',
      'audio:default/0/2',
      'audio:default/48000/2',
    ]);
    expect(result.uri).toBe('audio:default/48000/2');
    expect(
      result.attempts.map((a) => [a.uri, a.addAccepted, a.playAccepted, a.reachedPlaying]),
    ).toEqual([
      ['audio:cable/0/2', false, null, null],
      ['audio:default/0/2', true, false, null],
      ['audio:default/48000/2', true, true, true],
    ]);
    expect(result.attempts[0]?.error).toContain('no such input');
    // a file path is never sent through this method
    expect(sent(engine, 'PlaylistAdd').map((r) => r.attributes.uri)).not.toContain('not-live.flac');
    expect(engine.playlist().map((t) => t.uri)).toEqual(['audio:default/48000/2']);
  });

  it('leaves HQPlayer stopped with an empty playlist when nothing can be opened', async () => {
    const { engine, adapter } = await connect(ON, { startPlaying: true });
    const result = await adapter.playLiveInput(['audio:default/0/2', 'audio:default/44100/2']);
    expect(result.uri).toBeNull();
    expect(result.attempts).toHaveLength(2);
    expect(engine.playlist()).toEqual([]);
    expect(engine.state().transport).toBe(0);
  });
});

describe('live input (mock adapter)', () => {
  it('simulates one working input and reports it as simulated', async () => {
    const mock = new MockHQPlayerAdapter({ latencyMs: 0 });
    await mock.connect();
    try {
      expect((await mock.getCapabilities()).items['input.live']).toMatchObject({
        status: 'simulated',
        usable: true,
      });
      expect((await mock.getLiveInputs()).uris).toEqual(['audio:default/0/2']);
      const result = await mock.playLiveInput(['audio:nope/0/2', 'audio:default/0/2']);
      expect(result.uri).toBe('audio:default/0/2');
      expect(result.attempts.map((a) => a.reachedPlaying)).toEqual([null, true]);
      const status = await mock.getStatus();
      expect(status).toMatchObject({ transport: 'playing', trackCount: 1, durationMs: null });
      expect(status.track).toMatchObject({ uri: 'audio:default/0/2', title: null, artist: null });
      expect((await mock.playLiveInput(['audio:nope/0/2'])).uri).toBeNull();
      expect((await mock.getStatus()).trackCount).toBe(0);
    } finally {
      mock.dispose();
    }
  });
});
