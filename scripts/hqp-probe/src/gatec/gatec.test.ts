import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_C_ALLOWED, GateCSession, GateGuardError } from './session';
import { runGateC, scrub, type GateIO, type StepAnswer } from './run';
import { startFakeEngine, type FakeEngine } from './testing/fake-engine';
import { storedForm, toM3u8 } from './files';

const ORIGINAL = Array.from({ length: 5 }, (_, i) => ({
  uri: `file://D:\\Music\\私人 Album\\0${i + 1} Song.flac`,
  song: `Song ${i + 1}`,
  lengthSec: 300,
}));

let dir: string;
let testFolder: string;
let engine: FakeEngine | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-gatec-'));
  testFolder = join(dir, 'HQPS 测试', 'テスト アルバム');
  mkdirSync(testFolder, { recursive: true });
  for (const n of [
    '01 First long.flac',
    '02 Second.flac',
    '03 Third.flac',
    '04 Deep.dsf',
    'cover.jpg',
  ]) {
    writeFileSync(join(testFolder, n), 'x');
  }
});

afterEach(async () => {
  await engine?.close();
  engine = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Scripted listener: runs every step and answers the first (affirmative / restore) choice. */
function scriptedIO(opts: { folder?: string; quitAt?: string } = {}): GateIO & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (t) => lines.push(t),
    async confirm(id): Promise<StepAnswer> {
      return id === opts.quitAt ? 'quit' : 'go';
    },
    async ask(_q, choices) {
      return Object.keys(choices)[0] as string;
    },
    async text() {
      return opts.folder ?? '';
    },
  };
}

async function run(io: GateIO, extra: Partial<Parameters<typeof startFakeEngine>[0]> = {}) {
  engine = await startFakeEngine({ playlist: ORIGINAL, speed: 20, pushEveryMs: 20, ...extra });
  return runGateC({
    port: engine.port,
    outDir: dir,
    io,
    stamp: 'test',
    timeScale: 0.05,
    timeoutMs: 3000,
  });
}

function expectNoPrivateData(report: unknown) {
  const json = JSON.stringify(report);
  for (const secret of [
    '私人',
    'Music',
    'テスト',
    '测试',
    'First long',
    'Second.flac',
    'Deep.dsf',
    dir,
  ]) {
    expect(json, secret).not.toContain(secret);
  }
}

describe('Gate C runner', () => {
  it('runs the approved plan end to end and restores the original playlist exactly', async () => {
    const io = scriptedIO({ folder: `"${testFolder}"` }); // quotes as pasted from "Copy as path"
    const { report, backup, exitCode } = await run(io);
    expect(exitCode).toBe(0);
    expect(report.reachable).toBe(true);

    const results = Object.fromEntries(report.steps.map((s) => [s.id, s.result]));
    expect(results).toMatchObject({
      'C1.1': 'pass',
      'C1.2': 'pass',
      'C1.3': 'pass',
      'C1.4': 'pass',
      'C1.5': 'pass',
      O1: 'pass',
      O2: 'pass',
      'C2.1': 'pass',
      'C2.2': 'pass',
      'C2.3': 'pass',
      'C2.4': 'pass',
      'C2.5': 'pass',
      'C2.6': 'info',
      'C3.1': 'pass',
      'C3.2': 'pass',
      C4: 'pass',
    });
    expect(report.findings).toMatchObject({
      'transport.pause': { semantics: 'toggle' },
      'transport.previous': { behaviour: 'restart-current' },
      'queue.append.nativePath': true,
      'queue.append.fileUri': true,
      'queue.select': { base: 1, statusTrackEqualsEngineIndex: true },
      'queue.remove': { removedIntended: true },
      'playlistAdd.clear1queued0': { cleared: true, startedPlaying: true },
      restore: { needed: true, verified: true },
    });
    const adds = report.steps.find((s) => s.id === 'C2.2')?.observations.adds as {
      storedForm: string;
    }[];
    expect(adds.map((a) => a.storedForm)).toEqual([
      'file://+as-sent',
      'file://+as-sent',
      'file://+as-sent',
    ]);

    // HQPlayer ends with the original playlist, stopped, repeat/random/volume untouched.
    expect(engine!.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
    expect(engine!.state()).toMatchObject({
      transport: 0,
      repeat: 0,
      random: 0,
      volume: '-6.02059991327962418',
    });
    // Only approved commands ever reached the engine.
    for (const r of engine!.received) expect(GATE_C_ALLOWED.has(r.name), r.name).toBe(true);
    expect(
      engine!.received.some(
        (r) => r.name === 'Volume' && r.attributes.value !== '-6.02059991327962418',
      ),
    ).toBe(false);

    expectNoPrivateData(report);
    const m3u = readFileSync(backup!.m3u8, 'utf8');
    expect(m3u.startsWith('#EXTM3U')).toBe(true);
    expect(m3u).toContain('D:\\Music\\私人 Album\\01 Song.flac'); // native path, local file only
    expect(m3u).not.toContain('file://');
  });

  it('aborting mid-way stops further steps and still restores', async () => {
    const { report } = await run(scriptedIO({ folder: testFolder, quitAt: 'C2.3' }));
    expect(report.aborted).toBe(true);
    const results = Object.fromEntries(report.steps.map((s) => [s.id, s.result]));
    expect(results['C2.2']).toBe('pass');
    expect(results['C2.3']).toBe('not-run');
    expect(results['C3.2']).toBe('not-run');
    expect(report.restore).toMatchObject({ needed: true, performed: true, verified: true });
    expect(engine!.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
  });

  it('falls back to the file:// form for restore when native paths are rejected', async () => {
    const { report } = await run(scriptedIO({ folder: testFolder }), { rejectNativePaths: true });
    expect(report.findings).toMatchObject({
      'queue.append.nativePath': false,
      'queue.append.fileUri': true,
    });
    expect(report.restore).toMatchObject({ form: 'file', verified: true });
    expect(engine!.playlist().map((t) => t.uri)).toEqual(ORIGINAL.map((t) => t.uri));
    expectNoPrivateData(report); // HQPlayer's error text echoed the path; it must be scrubbed
  });

  it('without a test folder it never modifies the playlist', async () => {
    const { report } = await run(scriptedIO({ folder: '' }));
    expect(
      report.steps
        .filter((s) => s.id.startsWith('C2') || s.id.startsWith('C3'))
        .every((s) => s.result === 'skipped'),
    ).toBe(true);
    expect(report.restore.needed).toBe(false);
    expect(
      engine!.received.some((r) =>
        ['PlaylistClear', 'PlaylistAdd', 'PlaylistRemove'].includes(r.name),
      ),
    ).toBe(false);
  });

  it('exits cleanly without a backup when HQPlayer is not reachable', async () => {
    const res = await runGateC({
      port: 1,
      outDir: dir,
      io: scriptedIO(),
      stamp: 't',
      timeoutMs: 300,
    });
    expect(res.exitCode).toBe(3);
    expect(res.backup).toBeNull();
  });
});

describe('Gate C guards', () => {
  it('refuses commands outside the approved plan and any volume other than the original', async () => {
    engine = await startFakeEngine({ playlist: ORIGINAL });
    const s = new GateCSession({ host: '127.0.0.1', port: engine.port });
    await s.open();
    for (const forbidden of [
      'SetFilter',
      'SetMode',
      'SetRate',
      'SetShaping',
      'ConfigurationLoad',
      'Reset',
      'PlaylistSave',
      'MatrixSetProfile',
    ]) {
      await expect(s.send(forbidden, { value: 1 })).rejects.toBeInstanceOf(GateGuardError);
    }
    await expect(s.send('Volume', { value: '0' })).rejects.toBeInstanceOf(GateGuardError);
    s.permitVolume('-6.02059991327962418');
    await expect(s.send('Volume', { value: '-3' })).rejects.toBeInstanceOf(GateGuardError);
    await expect(s.send('Volume', { value: '-6.02059991327962418' })).resolves.toBeTruthy();
    expect(engine.received.map((r) => r.name)).not.toContain('SetFilter');
    s.close();
  });

  it('scrubs paths from free text and classifies stored URI forms', () => {
    expect(scrub('HQPlayer rejected "PlaylistAdd": bad uri D:\\私人\\a b.flac')).toBe(
      'HQPlayer rejected "PlaylistAdd": bad uri [path]',
    );
    expect(scrub('x file://D:\\a.flac y')).toBe('x [path] y');
    expect(storedForm('file://D:\\a b.flac', 'D:\\a b.flac')).toBe('file://+as-sent');
    expect(storedForm('D:\\a.flac', 'D:\\a.flac')).toBe('as-sent');
    expect(storedForm('file://D:\\other.flac', 'D:\\a.flac')).toBe('different-file');
    expect(
      toM3u8({
        createdAt: 'x',
        engine: {},
        albumMode: null,
        transport: 'stopped',
        statusTrack: 0,
        currentEngineIndex: null,
        repeat: '0',
        random: '0',
        volume: null,
        entries: [{ engineIndex: 1, uri: 'file://D:\\a.flac', lengthMs: 61_000 }],
      }),
    ).toBe('#EXTM3U\r\n# HQPlayer Studio Gate C backup x\r\n#EXTINF:61,#1\r\nD:\\a.flac\r\n');
  });
});
