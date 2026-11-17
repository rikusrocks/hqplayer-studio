import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disconnectedStatus,
  type EngineCapabilities,
  type EngineStatus,
  type ScanJob,
} from '@hqps/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../event-hub';
import type { EngineCommandEvent } from './engine-service';
import { SoakRecorder } from './soak-recorder';

/** Stand-in for EngineService: statuses and command events are pushed by the test. */
class FakeEngine {
  adapter = { kind: 'live' };
  status: EngineStatus;
  private readonly statusListeners = new Set<(s: EngineStatus) => void>();
  private readonly commandListeners = new Set<(e: EngineCommandEvent) => void>();
  private serial = 0;
  private commandId = 0;

  constructor(private readonly clock: () => number) {
    this.status = {
      ...disconnectedStatus(),
      connection: 'connected',
      transport: 'playing',
      positionMs: 0,
      outputDelayMs: 4413,
      durationMs: 240_000,
      trackIndex: 1,
      trackCount: 12,
      track: {
        index: 1,
        uri: 'file:D:\\Secret Music\\Hidden Album\\01 Private Song.flac',
        title: 'Private Song',
        artist: 'Secret Artist',
        album: 'Hidden Album',
        durationMs: 240_000,
        studioTrackId: null,
      },
      output: { kind: 'DSD', sampleRate: 24_576_000, bits: 1, channels: 2, label: 'DSD512' },
    };
  }

  getStatus = () => this.status;
  getCapabilities = async () =>
    ({
      engine: { product: 'HQPlayer Desktop', version: '6.1.0' },
    }) as unknown as EngineCapabilities;
  onStatus = (l: (s: EngineStatus) => void) => {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  };
  onCommand = (l: (e: EngineCommandEvent) => void) => {
    this.commandListeners.add(l);
    return () => this.commandListeners.delete(l);
  };

  push(patch: Partial<EngineStatus> = {}): void {
    this.status = { ...this.status, ...patch, serial: ++this.serial, observedAt: this.clock() };
    for (const l of this.statusListeners) l(this.status);
  }

  command(label: string, ok = true, durationMs = 50, errorName?: string): void {
    const id = ++this.commandId;
    const at = this.clock();
    for (const l of this.commandListeners) l({ id, label, phase: 'start', at });
    for (const l of this.commandListeners) {
      l({
        id,
        label,
        phase: 'end',
        at: at + durationMs,
        ok,
        durationMs,
        ...(ok ? {} : { errorName: errorName ?? 'EngineCommandError', error: 'refused' }),
      });
    }
  }
}

function scanJob(id: string, state: ScanJob['state'], trigger: ScanJob['trigger']): ScanJob {
  return {
    id,
    rootId: 'root_1',
    state,
    trigger,
    startedAt: 0,
    finishedAt: state === 'running' ? null : 1,
    filesSeen: 10,
    filesParsed: 2,
    filesUnchanged: 8,
    added: 0,
    updated: 0,
    moved: 0,
    markedUnavailable: 0,
    errors: 0,
    currentFolder: 'Secret Folder',
    message: null,
  };
}

let dir: string;
let clock: number;
let engine: FakeEngine;
let hub: EventHub;
let rec: SoakRecorder;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-soak-'));
  clock = Date.UTC(2026, 10, 17, 20, 0, 0);
  engine = new FakeEngine(() => clock);
  hub = new EventHub();
  rec = new SoakRecorder(engine, hub, {
    dir,
    appVersion: '0.5.0',
    now: () => clock,
    timers: false,
  });
  await rec.start(null);
});

afterEach(() => {
  if (rec.isRunning()) rec.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** HQPlayer playing normally: one status per second with the position advancing. */
function play(seconds: number, opts: { push?: boolean } = {}): void {
  for (let i = 0; i < seconds; i++) {
    clock += 1000;
    if (opts.push !== false) {
      const s = engine.status;
      engine.push(
        s.transport === 'playing' && s.connection === 'connected'
          ? { positionMs: s.positionMs + 1000 }
          : {},
      );
    }
    rec.tick();
  }
}

describe('soak-test recorder', () => {
  it('records normal listening (with a natural track change) as clean', () => {
    play(230);
    engine.push({ positionMs: 239_000 });
    clock += 1000;
    engine.push({ trackIndex: 2, positionMs: 0 }); // next track by itself
    play(120);
    const s = rec.stop();
    expect(s.verdict).toBe('clean');
    expect(s.warnings).toBe(0);
    expect(s.playingMs).toBeGreaterThanOrEqual(350_000);
    expect(s.statusUpdates).toBeGreaterThan(340);
    expect(s.maxStatusIntervalMs).toBeLessThanOrEqual(1000);
    const report = rec.report() as { totals: { trackChanges: Record<string, number> } };
    expect(report.totals.trackChanges).toEqual({ natural: 1, studio: 0, external: 0 });
  });

  it('flags a status gap while playing, and says Studio was idle', () => {
    play(30);
    play(8, { push: false }); // HQPlayer silent for 8 s
    play(5);
    const s = rec.stop();
    expect(s.incidentCounts.status_gap).toBe(1);
    const gap = s.recent.find((i) => i.kind === 'status_gap')!;
    expect(gap.durationMs).toBeGreaterThanOrEqual(8000);
    expect(gap.studioActivity).toBe(false);
    expect(s.verdict).toBe('issues-without-studio-activity');
  });

  it('attributes a gap during a folder-watch rescan to Studio activity and counts the overlap', () => {
    play(10);
    hub.publish({ type: 'library.scan', job: scanJob('job_1', 'running', 'watch') });
    play(20);
    play(6, { push: false });
    play(4);
    hub.publish({ type: 'library.scan', job: scanJob('job_1', 'completed', 'watch') });
    play(10);
    const s = rec.stop();
    expect(s.playingWhileScanningMs).toBeGreaterThanOrEqual(29_000);
    expect(s.scanMs).toBe(s.playingWhileScanningMs);
    const gap = s.recent.find((i) => i.kind === 'status_gap')!;
    expect(gap.context.scans).toEqual(['watch']);
    expect(gap.studioActivity).toBe(true);
    expect(s.verdict).toBe('issues-with-studio-activity');
  });

  it('tells Studio-initiated, natural and unexplained stops apart', () => {
    play(20);
    // 1. the user pressed Stop in Studio
    engine.command('stop');
    clock += 500;
    engine.push({ transport: 'stopped' });
    play(30);
    engine.command('play');
    engine.push({ transport: 'playing', positionMs: 0 });
    play(40);
    // 2. playback stopped mid-track with no command from Studio
    clock += 1000;
    engine.push({ transport: 'stopped' });
    play(30);
    // 3. the last track ran to its end
    engine.command('play');
    engine.push({ transport: 'playing', trackIndex: 12, positionMs: 230_000 });
    play(25);
    clock += 1000;
    engine.push({ transport: 'stopped', positionMs: 0 });
    play(5);
    const s = rec.stop();
    const report = rec.report() as { totals: { transportChanges: Record<string, number> } };
    expect(report.totals.transportChanges).toMatchObject({ studio: 3, natural: 1, external: 1 });
    expect(s.incidentCounts.transport_external).toBe(1);
    const ext = s.recent.find((i) => i.kind === 'transport_external')!;
    expect(ext.severity).toBe('warning');
    expect(ext.detail).toContain('playing → stopped');
    expect(ext.studioActivity).toBe(false);
  });

  it('notes mid-track skips without a Studio command as information, not as faults', () => {
    play(20);
    engine.push({ trackIndex: 2, positionMs: 0 }); // e.g. skipped in HQPlayer's own window
    play(20);
    engine.command('next');
    engine.push({ trackIndex: 3, positionMs: 0 });
    play(20);
    const s = rec.stop();
    expect(s.incidentCounts.track_external).toBe(1);
    expect(s.warnings).toBe(0);
    expect((rec.report() as { totals: { trackChanges: unknown } }).totals.trackChanges).toEqual({
      natural: 0,
      studio: 1,
      external: 1,
    });
  });

  it('records failed commands, Studio stalls and connection drops', () => {
    play(5);
    engine.command('replaceQueue', false, 20_000, 'EngineTimeoutError');
    rec.noteLag(650);
    play(5);
    engine.push({ connection: 'disconnected', transport: 'unknown' });
    play(12);
    engine.push({ connection: 'connected', transport: 'playing' });
    play(5);
    const s = rec.stop();
    expect(s.incidentCounts).toMatchObject({
      command_failed: 1,
      studio_stall: 1,
      disconnect: 1,
      reconnect: 1,
    });
    const failed = s.recent.find((i) => i.kind === 'command_failed')!;
    expect(failed.severity).toBe('error');
    expect(failed.context.studioCommand).toBe('replaceQueue');
    const reconnect = s.recent.find((i) => i.kind === 'reconnect')!;
    expect(reconnect.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(s.verdict).toBe('issues-with-studio-activity');
  });

  it('detects a position that stops moving while statuses keep arriving', () => {
    play(30);
    for (let i = 0; i < 12; i++) {
      clock += 1000;
      engine.push({}); // same position
      rec.tick();
    }
    play(5);
    const s = rec.stop();
    expect(s.incidentCounts.position_stall).toBe(1);
    expect(s.recent.find((i) => i.kind === 'position_stall')!.durationMs).toBeGreaterThanOrEqual(
      8000,
    );
  });

  it('ignores the silent start of a track (output buffer) and Studio seeks', () => {
    engine.command('play');
    engine.push({ positionMs: 0 });
    // HQPlayer reports position 0 while the 4.4 s output buffer fills
    for (let i = 0; i < 6; i++) {
      clock += 1000;
      engine.push({ positionMs: 0 });
      rec.tick();
    }
    play(30);
    engine.command('seek');
    engine.push({ positionMs: 120_000 });
    play(10);
    const s = rec.stop();
    expect(s.warnings).toBe(0);
    expect(s.incidentCounts.position_jump).toBeUndefined();
  });

  it('writes a report without titles, artists, albums, folders or paths', () => {
    hub.publish({ type: 'library.scan', job: scanJob('job_9', 'running', 'manual') });
    play(10);
    play(7, { push: false });
    play(3);
    rec.stop();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^soak-\d{8}T\d{6}Z\.json$/);
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    const report = JSON.parse(text) as Record<string, unknown>;
    expect(report).toMatchObject({
      kind: 'hqplayer-studio-soak-report',
      engine: { product: 'HQPlayer Desktop', version: '6.1.0', adapter: 'live' },
      stopReason: 'user',
      inProgress: false,
    });
    expect(text).toContain('DSD512');
    for (const secret of ['Private Song', 'Secret', 'Hidden Album', 'D:\\', 'Music']) {
      expect(text).not.toContain(secret);
    }
  });

  it('stops by itself after the chosen duration and keeps the report up to date meanwhile', async () => {
    rec.stop();
    rmSync(dir, { recursive: true, force: true });
    rec = new SoakRecorder(engine, hub, {
      dir,
      appVersion: '0.5.0',
      now: () => clock,
      timers: false,
      writeEveryMs: 10_000,
    });
    await rec.start(0.01); // 36 s
    play(15);
    const partial = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')) as {
      inProgress: boolean;
    };
    expect(partial.inProgress).toBe(true);
    play(30);
    expect(rec.isRunning()).toBe(false);
    expect(rec.snapshot().stopReason).toBe('time-limit');
  });
});
