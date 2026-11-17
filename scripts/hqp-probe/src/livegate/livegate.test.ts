import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseXmlDocument } from '@hqps/hqplayer-adapter';
import type { GateIO, StepAnswer } from '../gatec/run';
import { GateGuardError } from '../gatec/session';
import {
  startFakeEngine,
  type FakeEngine,
} from '../../../../packages/hqplayer-adapter/src/testing/fake-engine';
import {
  isAppleMusicApp,
  parseMediaSessions,
  windowsMediaProbe,
  type MediaProbe,
  type MediaSessionInfo,
} from './media-sessions';
import { DEFAULT_LIVE_URIS, runLiveGate, type LiveAttempt } from './run';
import { findLiveUris, LIVE_GATE_ALLOWED, LiveGateSession, sanitizeLive } from './session';

const ORIGINAL = Array.from({ length: 4 }, (_, i) => ({
  uri: `file://D:\\Music\\私人 Album\\0${i + 1} Song.flac`,
  song: `Secret Song ${i + 1}`,
  lengthSec: 300,
}));

const APPLE = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';

let dir: string;
let engine: FakeEngine | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-livegate-'));
});

afterEach(async () => {
  await engine?.close();
  engine = null;
  rmSync(dir, { recursive: true, force: true });
});

interface Script {
  quitAt?: string;
  skip?: string[];
  /** Answer for a question containing this text; default = the first choice. */
  answers?: Record<string, string>;
}

function scriptedIO(script: Script = {}): GateIO & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (t) => lines.push(t),
    async confirm(id): Promise<StepAnswer> {
      if (id === script.quitAt) return 'quit';
      return script.skip?.includes(id) ? 'skip' : 'go';
    },
    async ask(question, choices) {
      for (const [needle, answer] of Object.entries(script.answers ?? {}))
        if (question.includes(needle)) return answer;
      return Object.keys(choices)[0] as string;
    },
    async text() {
      return '';
    },
  };
}

function fakeMedia(
  sessions: Partial<MediaSessionInfo>[] = [{ app: APPLE }],
  supported = true,
): MediaProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    supported,
    async list() {
      calls.push('list');
      return sessions.map((m) => ({
        app: 'Other.App',
        current: true,
        status: 'Playing',
        title: 'Private Title 秘密',
        artist: 'Private Artist',
        album: 'Private Album',
        thumbnailBytes: 34567,
        positionSec: 12,
        endSec: 240,
        controls: { play: true, pause: true, next: true, previous: true },
        ...m,
      }));
    },
    async control(app, action) {
      calls.push(`${action}:${app}`);
      return true;
    },
  };
}

async function run(
  io: GateIO,
  extra: Partial<Parameters<typeof startFakeEngine>[0]> = {},
  media: MediaProbe = fakeMedia(),
  uris: string[] = [],
) {
  engine = await startFakeEngine({ playlist: ORIGINAL, speed: 20, pushEveryMs: 10, ...extra });
  return runLiveGate({
    port: engine.port,
    outDir: dir,
    io,
    stamp: 'test',
    timeScale: 0.01,
    timeoutMs: 3000,
    media,
    uris,
  });
}

const sent = () => (engine?.received ?? []).map((r) => r.name);
const stepResult = (report: Awaited<ReturnType<typeof run>>['report'], id: string) =>
  report.steps.find((x) => x.id === id)?.result;

describe('live-input gate', () => {
  it('plays the live input, checks Apple Music through Windows and restores the playlist', async () => {
    const media = fakeMedia();
    const { report, exitCode } = await run(
      scriptedIO(),
      { liveInputs: ['audio:default/0/2'], startPlaying: true },
      media,
    );
    expect(exitCode).toBe(0);
    expect(report.steps.map((x) => [x.id, x.result])).toEqual([
      ['W1', 'pass'],
      ['L1', 'pass'],
      ['L2', 'pass'],
      ['L3', 'pass'],
      ['W2', 'pass'],
      ['L4', 'pass'],
      ['L5', 'pass'],
      ['L6', 'pass'],
    ]);
    expect(report.findings['live.uri']).toBe('audio:default/0/2');
    expect(report.findings['live.storedUri']).toBe('audio:default/0/2');
    expect(report.inputs.listedLiveUris).toEqual(['audio:default/0/2']);
    expect(media.calls).toEqual(['list', `pause:${APPLE}`, `play:${APPLE}`]);
    // the original playlist is back, in order, and nothing is playing
    expect(report.restore).toMatchObject({ needed: true, performed: true, verified: true });
    expect(engine?.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
    expect(engine?.state().transport).toBe(0);
    // only commands from the allowlist ever reached the engine
    for (const name of sent()) expect(LIVE_GATE_ALLOWED.has(name)).toBe(true);
  });

  it('keeps titles, artists and paths out of the report', async () => {
    const { report } = await run(scriptedIO(), { liveInputs: ['audio:default/0/2'] });
    const json = JSON.stringify(report);
    for (const secret of ['Private', '秘密', 'Secret Song', '私人', 'D:\\\\Music', 'Song.flac'])
      expect(json).not.toContain(secret);
    expect(json).toContain('audio:default/0/2');
    expect(json).toContain(APPLE);
    const w1 = report.steps.find((x) => x.id === 'W1');
    expect(w1?.observations.sessions).toEqual([
      expect.objectContaining({
        appleMusic: true,
        hasTitle: true,
        hasArtist: true,
        hasAlbum: true,
        thumbnailBytes: 34567,
      }),
    ]);
    // the backup (which does contain the paths) stays in its own local files
    expect(readdirSync(dir).sort()).toEqual([
      'hqp-livegate-backup-test.json',
      'hqp-livegate-backup-test.m3u8',
    ]);
  });

  it('tries an input that HQPlayer itself lists before the defaults', async () => {
    const { report } = await run(scriptedIO(), { liveInputs: ['audio:default/44100/2'] });
    const attempts = report.steps.find((x) => x.id === 'L2')?.observations
      .attempts as LiveAttempt[];
    // GetInputs lists the working one, so it is tried first; a --uri would come before it
    expect(attempts.map((a) => [a.uri, a.addAccepted, a.reachedPlaying])).toEqual([
      ['audio:default/44100/2', true, true],
    ]);
    expect(report.findings['live.uri']).toBe('audio:default/44100/2');
  });

  it('tries --uri first, then the defaults, and moves on when Play fails', async () => {
    const { report } = await run(
      scriptedIO(),
      {
        liveInputs: ['audio:default/0/2', 'audio:default/48000/2'],
        liveInputsFailingPlay: ['audio:default/0/2'],
      },
      fakeMedia(),
      ['audio:cable/0/2', 'not-a-live-uri'],
    );
    const attempts = report.steps.find((x) => x.id === 'L2')?.observations
      .attempts as LiveAttempt[];
    expect(report.inputs.candidates[0]).toBe('audio:cable/0/2');
    expect(report.inputs.candidates).not.toContain('not-a-live-uri');
    expect(attempts.map((a) => [a.uri, a.addAccepted, a.playAccepted, a.reachedPlaying])).toEqual([
      ['audio:cable/0/2', false, null, null],
      ['audio:default/0/2', true, false, null],
      ['audio:default/48000/2', true, true, true],
    ]);
    expect(report.findings['live.rejectedUris']).toEqual(['audio:cable/0/2', 'audio:default/0/2']);
    expect(report.restore.verified).toBe(true);
  });

  it('fails L2 cleanly and still restores when no live input can be opened', async () => {
    const { report } = await run(scriptedIO(), {});
    expect(stepResult(report, 'L2')).toBe('fail');
    for (const id of ['L3', 'W2', 'L4', 'L5']) expect(stepResult(report, id)).toBe('skipped');
    expect(report.findings['live.uri']).toBeNull();
    expect(report.restore.verified).toBe(true);
    expect(engine?.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
    expect(
      (report.steps.find((x) => x.id === 'L2')?.observations.attempts as LiveAttempt[]).length,
    ).toBe(DEFAULT_LIVE_URIS.length);
  });

  it('sends no write command when the listener declines at the start', async () => {
    const { report } = await run(scriptedIO({ answers: { 'Start the live-input test': 'n' } }), {
      liveInputs: ['audio:default/0/2'],
      startPlaying: true,
    });
    expect(report.aborted).toBe(true);
    expect(report.steps).toEqual([]);
    expect(new Set(sent())).toEqual(
      new Set(['Status', 'GetInfo', 'State', 'PlaylistGet', 'GetInputs', 'GetTransport']),
    );
    expect(engine?.state().transport).toBe(2);
  });

  it('restores when the listener quits in the middle', async () => {
    const { report } = await run(scriptedIO({ quitAt: 'L4' }), {
      liveInputs: ['audio:default/0/2'],
    });
    expect(report.aborted).toBe(true);
    expect(stepResult(report, 'L4')).toBe('not-run');
    expect(stepResult(report, 'L5')).toBe('not-run');
    expect(report.restore.verified).toBe(true);
    expect(engine?.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
    expect(engine?.state().transport).toBe(0);
  });

  it('does not touch the playlist when HQPlayer is left playing (L1 skipped)', async () => {
    const { report } = await run(scriptedIO({ skip: ['L1'] }), {
      liveInputs: ['audio:default/0/2'],
      startPlaying: true,
    });
    expect(stepResult(report, 'L2')).toBe('skipped');
    expect(sent()).not.toContain('PlaylistClear');
    expect(sent()).not.toContain('PlaylistAdd');
    expect(stepResult(report, 'L6')).toBe('skipped');
    expect(engine?.state().transport).toBe(2);
  });

  it('waits for a slow Stop before it clears, so the live entry is not left behind', async () => {
    const { report } = await run(scriptedIO(), {
      liveInputs: ['audio:default/0/2'],
      startPlaying: true,
      stopDelayMs: 40,
    });
    expect(stepResult(report, 'L2')).toBe('pass');
    expect(report.restore.verified).toBe(true);
    expect(engine?.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
  });

  it('records what the listener heard', async () => {
    const { report } = await run(
      scriptedIO({ answers: { 'How does it sound': 'd', 'Any dropouts': 'y' } }),
      { liveInputs: ['audio:default/0/2'] },
    );
    expect(stepResult(report, 'L3')).toBe('fail');
    expect(stepResult(report, 'L4')).toBe('fail');
    expect(report.findings['live.heard']).toMatchObject({ heard: 'y', quality: 'd', pitch: 'y' });
    expect(report.findings['live.stableOneMinute']).toMatchObject({ dropouts: 'y' });
  });

  it('skips the Windows steps off Windows and when Apple Music is not among the sessions', async () => {
    const off = await run(
      scriptedIO(),
      { liveInputs: ['audio:default/0/2'] },
      fakeMedia([], false),
    );
    expect(stepResult(off.report, 'W1')).toBe('skipped');
    expect(stepResult(off.report, 'W2')).toBe('skipped');
    expect(stepResult(off.report, 'L3')).toBe('pass');
    await engine?.close();

    const media = fakeMedia([{ app: 'Spotify.exe' }]);
    const none = await run(scriptedIO(), { liveInputs: ['audio:default/0/2'] }, media);
    expect(stepResult(none.report, 'W1')).toBe('fail');
    expect(stepResult(none.report, 'W2')).toBe('skipped');
    expect(media.calls).toEqual(['list']);
  });

  it('asks Apple Music to play again even when the pause step goes wrong', async () => {
    const media = fakeMedia();
    media.control = async (app, action) => {
      media.calls.push(`${action}:${app}`);
      if (action === 'pause') throw new Error('Windows media query failed: boom');
      return true;
    };
    const { report } = await run(scriptedIO(), { liveInputs: ['audio:default/0/2'] }, media);
    expect(stepResult(report, 'W2')).toBe('fail');
    expect(media.calls).toEqual(['list', `pause:${APPLE}`, `play:${APPLE}`]);
    expect(stepResult(report, 'L4')).toBe('pass');
  });

  it('exits with code 3 and writes nothing when HQPlayer is not reachable', async () => {
    const { report, exitCode, backup } = await runLiveGate({
      port: 1,
      outDir: dir,
      io: scriptedIO(),
      stamp: 'test',
      timeoutMs: 500,
      media: fakeMedia(),
    });
    expect(exitCode).toBe(3);
    expect(report.reachable).toBe(false);
    expect(backup).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('live-input gate guard', () => {
  it('refuses commands outside the plan and URIs that were not permitted', async () => {
    engine = await startFakeEngine({ playlist: ORIGINAL, liveInputs: ['audio:default/0/2'] });
    const s = new LiveGateSession({ host: '127.0.0.1', port: engine.port });
    await s.open();
    try {
      for (const name of ['SetTransport', 'SetTransportRate', 'Volume', 'SetFilter', 'Reset'])
        await expect(s.send(name, { value: 1 })).rejects.toBeInstanceOf(GateGuardError);
      await expect(
        s.send('PlaylistAdd', { uri: 'audio:default/0/2', queued: 1, clear: 0 }),
      ).rejects.toBeInstanceOf(GateGuardError);
      s.permit('audio:default/0/2');
      await s.send('PlaylistAdd', { uri: 'audio:default/0/2', queued: 1, clear: 0 });
      await expect(
        s.send('PlaylistAdd', { uri: 'D:\\Other\\file.flac', queued: 1, clear: 0 }),
      ).rejects.toBeInstanceOf(GateGuardError);
      expect(engine.received.map((r) => r.name)).toEqual(['Status', 'PlaylistAdd']);
    } finally {
      s.close();
    }
  });
});

describe('live-input helpers', () => {
  it('finds audio: values and keeps them when a reply is sanitised', () => {
    const doc = parseXmlDocument(
      '<?xml version="1.0" encoding="UTF-8"?><GetInputs path="D:\\Music\\x.flac"><InputsItem name="audio:default/0/2" uri="file://D:\\Music\\a.flac"/><InputsItem value="audio:CABLE Output/48000/2"/></GetInputs>',
    );
    expect(findLiveUris(doc)).toEqual(['audio:default/0/2', 'audio:CABLE Output/48000/2']);
    const clean = sanitizeLive(doc);
    const json = JSON.stringify(clean);
    expect(json).toContain('audio:default/0/2');
    expect(json).toContain('audio:CABLE Output/48000/2');
    expect(json).not.toContain('Music');
  });

  it('parses the Windows media-session JSON and tolerates odd shapes', () => {
    const one = parseMediaSessions(
      JSON.stringify({
        app: APPLE,
        current: true,
        status: 'Playing',
        title: 'T',
        artist: 'A',
        album: 'B',
        thumbnailBytes: 10,
        positionSec: 1.5,
        endSec: 200,
        controls: { play: true, pause: true, next: false, previous: false },
      }),
    );
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ app: APPLE, current: true, endSec: 200 });
    expect(one[0]?.controls).toEqual({ play: true, pause: true, next: false, previous: false });
    expect(parseMediaSessions('')).toEqual([]);
    expect(parseMediaSessions('[{"app":""},{"app":"X","title":5,"controls":null}]')).toEqual([
      expect.objectContaining({ app: 'X', title: '', thumbnailBytes: 0, positionSec: null }),
    ]);
  });

  it('recognises Apple Music (and iTunes) and is Windows-only', () => {
    expect(isAppleMusicApp(APPLE)).toBe(true);
    expect(isAppleMusicApp('Apple.iTunes')).toBe(true);
    expect(isAppleMusicApp('Spotify.exe')).toBe(false);
    expect(windowsMediaProbe('darwin').supported).toBe(false);
    expect(windowsMediaProbe('win32').supported).toBe(true);
  });
});
