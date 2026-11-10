import type { EngineStatus } from '@hqps/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayableTrack } from '../adapter';
import { EngineCommandError, EngineTimeoutError, EngineUnavailableError } from '../errors';
import { MockHQPlayerAdapter } from './MockHQPlayerAdapter';

function track(n: number, durationMs = 10_000, isDsd = false): PlayableTrack {
  return {
    studioTrackId: `t${n}`,
    uri: `D:\\Music\\Album\\0${n}.flac`,
    title: `Track ${n}`,
    artist: 'Artist',
    album: 'Album',
    durationMs,
    format: isDsd
      ? { sampleRate: 2_822_400, bitDepth: 1, channels: 2, isDsd: true }
      : { sampleRate: 96_000, bitDepth: 24, channels: 2, isDsd: false },
  };
}

describe('MockHQPlayerAdapter', () => {
  let mock: MockHQPlayerAdapter;
  let statuses: EngineStatus[];

  beforeEach(async () => {
    vi.useFakeTimers();
    mock = new MockHQPlayerAdapter({ latencyMs: 0, tickMs: 500 });
    statuses = [];
    mock.subscribeStatus((s) => statuses.push(s));
    await mock.connect();
  });

  afterEach(() => {
    mock.dispose();
    vi.useRealTimers();
  });

  it('reports every capability as simulated or unsupported — never confirmed', async () => {
    const caps = await mock.getCapabilities();
    expect(caps.adapter).toBe('mock');
    const statusesSeen = new Set(Object.values(caps.items).map((c) => c.status));
    expect([...statusesSeen].sort()).toEqual(['simulated', 'unsupported']);
    expect(caps.items['dsp.write'].usable).toBe(false);
  });

  it('loads a queue, plays, advances position and auto-advances at track end', async () => {
    await mock.replaceQueue([track(1, 2000), track(2, 5000)], {
      startIndex: 0,
      autoplay: true,
      albumMode: true,
    });
    let s = await mock.getStatus();
    expect(s.transport).toBe('playing');
    expect(s.track?.title).toBe('Track 1');
    expect(s.albumMode).toBe(true);
    expect(s.input?.label).toBe('PCM 96 kHz / 24-bit');
    expect(s.output?.label).toBe('DSD512 (48k)');

    vi.advanceTimersByTime(1000);
    s = await mock.getStatus();
    expect(s.positionMs).toBeGreaterThanOrEqual(1000);

    vi.advanceTimersByTime(1500);
    s = await mock.getStatus();
    expect(s.trackIndex).toBe(1);
    expect(s.track?.title).toBe('Track 2');
    expect(statuses.length).toBeGreaterThan(2);
  });

  it('stops after the last track when repeat is off', async () => {
    await mock.replaceQueue([track(1, 1000)], { startIndex: 0, autoplay: true, albumMode: false });
    vi.advanceTimersByTime(1500);
    expect((await mock.getStatus()).transport).toBe('stopped');
  });

  it('pause toggles and freezes position; seek is clamped to the track', async () => {
    await mock.replaceQueue([track(1, 60_000)], {
      startIndex: 0,
      autoplay: true,
      albumMode: false,
    });
    vi.advanceTimersByTime(2000);
    await mock.pause();
    const paused = await mock.getStatus();
    expect(paused.transport).toBe('paused');
    vi.advanceTimersByTime(5000);
    expect((await mock.getStatus()).positionMs).toBe(paused.positionMs);
    await mock.seek(999_999);
    expect((await mock.getStatus()).positionMs).toBeLessThan(60_000);
    await mock.pause();
    expect((await mock.getStatus()).transport).toBe('playing');
  });

  it('previous restarts the track after 3 s, otherwise goes back', async () => {
    await mock.replaceQueue([track(1, 60_000), track(2, 60_000)], {
      startIndex: 1,
      autoplay: true,
      albumMode: false,
    });
    vi.advanceTimersByTime(4000);
    await mock.previous();
    expect((await mock.getStatus()).trackIndex).toBe(1);
    await mock.previous();
    expect((await mock.getStatus()).trackIndex).toBe(0);
  });

  it('rejects commands while disconnected and keeps playing underneath', async () => {
    await mock.replaceQueue([track(1, 60_000)], {
      startIndex: 0,
      autoplay: true,
      albumMode: false,
    });
    mock.simulateDisconnect();
    expect((await mock.getStatus()).connection).toBe('disconnected');
    await expect(mock.pause()).rejects.toBeInstanceOf(EngineUnavailableError);
    vi.advanceTimersByTime(3000);
    mock.simulateReconnect();
    const s = await mock.getStatus();
    expect(s.connection).toBe('connected');
    expect(s.transport).toBe('playing');
    expect(s.positionMs).toBeGreaterThanOrEqual(3000);
  });

  it('can simulate an ACK timeout for the next command', async () => {
    await mock.replaceQueue([track(1)], { startIndex: 0, autoplay: false, albumMode: false });
    mock.failNextCommand();
    await expect(mock.play()).rejects.toBeInstanceOf(EngineTimeoutError);
    expect((await mock.getStatus()).transport).toBe('stopped');
    await mock.play();
    expect((await mock.getStatus()).transport).toBe('playing');
  });

  it('refuses to play an empty playlist', async () => {
    await expect(mock.play()).rejects.toBeInstanceOf(EngineCommandError);
  });

  it('supports Play Next / append / remove / select', async () => {
    await mock.replaceQueue([track(1), track(2)], {
      startIndex: 0,
      autoplay: false,
      albumMode: false,
    });
    await mock.insertNext([track(9)]);
    await mock.appendToQueue([track(5)]);
    let q = await mock.getEngineQueue();
    expect(q.entries.map((e) => e.title)).toEqual(['Track 1', 'Track 9', 'Track 2', 'Track 5']);
    await mock.removeFromQueue(2);
    await mock.selectIndex(1, true);
    q = await mock.getEngineQueue();
    expect(q.entries.map((e) => e.title)).toEqual(['Track 1', 'Track 9', 'Track 5']);
    const s = await mock.getStatus();
    expect(s.trackIndex).toBe(1);
    expect(s.transport).toBe('playing');
  });

  it('labels DSD input correctly', async () => {
    await mock.replaceQueue([track(1, 10_000, true)], {
      startIndex: 0,
      autoplay: true,
      albumMode: false,
    });
    const s = await mock.getStatus();
    expect(s.input?.label).toBe('DSD64');
    expect(s.output?.label).toBe('DSD512');
  });

  it('simulates an external change made in the native HQPlayer UI', async () => {
    await mock.replaceQueue([track(1)], { startIndex: 0, autoplay: true, albumMode: false });
    mock.simulateExternalChange();
    const s = await mock.getStatus();
    expect(s.track?.uri).toContain('Other Music');
  });
});
