import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateIO, StepAnswer } from '../gatec/run';
import { GateGuardError } from '../gatec/session';
import { startFakeDspEngine, type FakeDspEngine, type FakeDspOptions } from './fake-dsp-engine';
import { diffState, inferStateRef, pickLowerRate, pickTarget, summarizeTimeline } from './logic';
import { runDspGate } from './run';
import {
  DSP_GATE_ALLOWED,
  DspGateSession,
  type DspItem,
  type DspLiveStatus,
  type DspStateSnapshot,
} from './session';

let dir: string;
let engine: FakeDspEngine | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-dspgate-'));
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
  /** Replies to free-text prompts, in order; default = Enter. */
  texts?: string[];
}

function scriptedIO(script: Script = {}): GateIO & { lines: string[]; asked: string[] } {
  const lines: string[] = [];
  const asked: string[] = [];
  const texts = [...(script.texts ?? [])];
  return {
    lines,
    asked,
    print: (t) => lines.push(t),
    async confirm(id): Promise<StepAnswer> {
      if (id === script.quitAt) return 'quit';
      return script.skip?.includes(id) ? 'skip' : 'go';
    },
    async ask(question, choices) {
      asked.push(question);
      for (const [needle, answer] of Object.entries(script.answers ?? {}))
        if (question.includes(needle)) return answer;
      return Object.keys(choices)[0] as string;
    },
    async text() {
      return texts.shift() ?? '';
    },
  };
}

async function run(io: GateIO, opts: FakeDspOptions = {}) {
  engine = await startFakeDspEngine(opts);
  return runDspGate({
    port: engine.port,
    outDir: dir,
    io,
    stamp: 'test',
    timeScale: 0.01,
    timeoutMs: 2000,
  });
}

const INITIAL = {
  mode: 2,
  filter1x: 3,
  filterNx: 6,
  shaper: 6,
  rate: 0,
  invert: 0,
  convolution: 0,
  adaptive: 0,
};

const results = (report: { steps: { id: string; result: string }[] }) =>
  Object.fromEntries(report.steps.map((s) => [s.id, s.result]));

const item = (index: number, name: string, value: number | null = index): DspItem => ({
  index,
  name,
  value,
});

describe('DSP gate logic', () => {
  it('tells whether State reports a list index or a list value', () => {
    const list = [item(0, 'a', 2), item(1, 'b', 0), item(2, 'c', 1)];
    expect(inferStateRef(list, 2, 'c')).toEqual({ form: 'index', certain: true });
    expect(inferStateRef(list, 2, 'a')).toEqual({ form: 'value', certain: true });
    expect(inferStateRef(list, 2, null)).toEqual({ form: 'index', certain: false });
    // only one reading exists
    expect(inferStateRef([item(0, 'a', 10), item(1, 'b', 11)], 1, null)).toEqual({
      form: 'index',
      certain: true,
    });
    expect(inferStateRef([item(0, 'a', 10), item(1, 'b', 11)], 11, null)).toEqual({
      form: 'value',
      certain: true,
    });
  });

  it('prefers a neighbouring target whose index and value differ', () => {
    const list = [item(0, 'a'), item(1, 'b'), item(2, 'c'), item(3, 'd', 40), item(4, 'e')];
    expect(pickTarget(list, list[2] as DspItem)?.index).toBe(3);
    expect(pickTarget([list[2] as DspItem], list[2] as DspItem)).toBeNull();
    expect(pickTarget(list, list[2] as DspItem, (i) => i.index === 0)?.index).toBe(0);
  });

  it('only ever proposes a lower rate from the same family', () => {
    const rates = [0, 2822400, 3072000, 11289600, 12288000, 22579200, 24576000, 49152000].map(
      (hz, i) => item(i, String(hz), hz),
    );
    // "auto" selected, 24.576 MHz in use → DSD256 of the 48k family, never 22.5792 MHz or higher
    expect(pickLowerRate(rates, rates[0] as DspItem, 24576000)?.value).toBe(12288000);
    expect(pickLowerRate(rates, rates[5] as DspItem, null)?.value).toBe(11289600);
    expect(pickLowerRate(rates, rates[1] as DspItem, null)).toBeNull();
    expect(pickLowerRate(rates, rates[0] as DspItem, null)).toBeNull();
  });

  it('summarises how playback reacted to a change', () => {
    const st = (ms: number, positionMs: number, activeShaper: string): DspLiveStatus => ({
      transport: 'playing',
      positionMs,
      activeMode: null,
      activeFilter: null,
      activeShaper,
      activeRate: null,
      activeBits: null,
      receivedAt: ms,
    });
    const before = st(900, 20000, 'A');
    const smooth = summarizeTimeline(
      [st(1100, 20100, 'A'), st(2100, 21100, 'B')],
      1000,
      'activeShaper',
      before,
    );
    expect(smooth).toMatchObject({
      transports: ['playing'],
      positionJumpedBack: false,
      activeBefore: 'A',
      activeAfter: 'B',
      activeChangedAfterMs: 1100,
    });
    const restarted = summarizeTimeline(
      [st(1100, 20100, 'A'), { ...st(1500, 0, 'A'), transport: 'stopped' }, st(2500, 300, 'B')],
      1000,
      'activeShaper',
      before,
    );
    expect(restarted.positionJumpedBack).toBe(true);
    expect(restarted.transports).toEqual(['playing', 'stopped', 'playing']);
  });

  it('lists the settings that differ from the starting snapshot', () => {
    const base: DspStateSnapshot = {
      transport: 'stopped',
      mode: 2,
      filter: 6,
      filter1x: 3,
      filterNx: 6,
      shaper: 6,
      rate: 0,
      invert: 0,
      convolution: 0,
      adaptive: 0,
      matrixProfile: '',
      raw: {},
    };
    expect(diffState(base, { ...base, transport: 'playing' })).toEqual([]);
    expect(diffState(base, { ...base, shaper: 5, convolution: 1 })).toEqual([
      'shaper',
      'convolution',
    ]);
  });
});

describe('DSP gate session guard', () => {
  it('refuses everything outside the plan before it reaches the socket', async () => {
    engine = await startFakeDspEngine();
    const s = new DspGateSession({ host: '127.0.0.1', port: engine.port });
    await s.open();
    for (const cmd of [
      'Reset',
      'ConfigurationLoad',
      'SetTransport',
      'SetTransportRate',
      'SetDisplay',
      'SetJunkFilter',
      'Volume',
      'PlaylistClear',
      'PlaylistAdd',
      'PlaylistRemove',
      'GetLicense',
    ]) {
      expect(DSP_GATE_ALLOWED.has(cmd), cmd).toBe(false);
      await expect(s.send(cmd, { value: 0 }), cmd).rejects.toBeInstanceOf(GateGuardError);
    }
    expect(engine.received.map((r) => r.name)).toEqual(['Status']);
    s.close();
  });

  it('only sends selector values HQPlayer listed on this connection', async () => {
    engine = await startFakeDspEngine();
    const s = new DspGateSession({ host: '127.0.0.1', port: engine.port });
    await s.open();
    // list not read yet
    await expect(s.send('SetShaping', { value: 1 })).rejects.toBeInstanceOf(GateGuardError);
    await s.readLists();
    await s.matrix();
    await expect(s.send('SetShaping', { value: 99 })).rejects.toBeInstanceOf(GateGuardError);
    await expect(s.send('SetRate', { value: 98304000 })).rejects.toBeInstanceOf(GateGuardError);
    await expect(s.send('SetFilter', { value: 1, value1x: 99 })).rejects.toBeInstanceOf(
      GateGuardError,
    );
    await expect(s.send('SetInvert', { value: 2 })).rejects.toBeInstanceOf(GateGuardError);
    await expect(s.send('MatrixSetProfile', { value: 'anything' })).rejects.toBeInstanceOf(
      GateGuardError,
    );
    expect(engine.received.some((r) => r.name.startsWith('Set'))).toBe(false);
    await s.send('SetShaping', { value: 5 });
    expect(engine.dsp().shaper).toBe(5);
    s.close();
  });
});

describe('DSP gate runner', () => {
  it('runs every step against an index-based engine and leaves the settings untouched', async () => {
    const io = scriptedIO();
    const { report, originalFile, exitCode } = await run(io, {
      listsDependOnMode: true,
      matrixProfiles: ['客厅 Living', 'Headphones 私人'],
      matrixCurrent: '客厅 Living',
    });
    expect(exitCode).toBe(0);
    expect(results(report)).toEqual({
      D1: 'pass',
      D2: 'pass',
      D3: 'pass',
      D4: 'pass',
      D5: 'pass',
      'D6.1': 'pass',
      'D6.2': 'pass',
      'D6.3': 'pass',
      D7: 'pass',
      'D8.1': 'pass',
      'D8.2': 'pass',
      D9: 'pass',
    });
    expect(report.findings).toMatchObject({
      setTakes: { mode: 'index', filter: 'index', shaper: 'index', rate: 'index' },
      'filter.setSingle': { sets1x: true, setsNx: true },
      'mode.set': {
        listsSameInOtherMode: { mode: true, filter: true, shaper: false, rate: false },
      },
      whilePlaying: {
        shaper: { listener: 'c', timeline: { positionJumpedBack: false } },
      },
      restore: { needed: true, verified: true },
      persistsAcrossRestart: 'not-tested',
    });
    expect(report.start?.stateRef.filter).toEqual({ form: 'index', certain: true });
    expect(engine?.dsp()).toMatchObject({ ...INITIAL, matrix: '客厅 Living', transport: 0 });

    // only planned commands, and the rate was only ever lowered within the 48k family
    const names = new Set(engine?.received.map((r) => r.name));
    for (const n of names) expect(DSP_GATE_ALLOWED.has(n), n).toBe(true);
    const rateSets = engine?.received.filter((r) => r.name === 'SetRate') ?? [];
    expect(rateSets.map((r) => r.attributes.value)).toEqual(['6', '0']);

    // the report is shareable: no profile names, no paths
    const json = JSON.stringify(report);
    for (const secret of ['客厅', 'Living', 'Headphones', '私人', 'Music', dir])
      expect(json, secret).not.toContain(secret);
    // the local file is for the user and does name the profile
    expect(readFileSync(originalFile as string, 'utf8')).toContain('[6] sinc-Mx');
    expect(readFileSync(originalFile as string, 'utf8')).toContain('客厅 Living');
  });

  it('discovers an engine whose Set commands take the list value', async () => {
    const io = scriptedIO();
    const { report } = await run(io, { setTakes: 'value', listsDependOnMode: true });
    expect(report.findings).toMatchObject({
      setTakes: { mode: 'value', filter: 'value', shaper: 'value', rate: 'value' },
      restore: { verified: true },
    });
    expect(results(report)).toMatchObject({ D1: 'pass', D2: 'pass', D4: 'pass', D5: 'pass' });
    expect(engine?.dsp()).toMatchObject(INITIAL);
    // the rejected index attempt is kept as evidence
    const d1 = report.steps.find((s) => s.id === 'D1');
    expect(d1?.observations.change).toMatchObject({
      form: 'value',
      attempts: [
        { form: 'index', accepted: false },
        { form: 'value', accepted: true, matched: true },
      ],
    });
  });

  it('reports "ambiguous" when index and value are the same numbers', async () => {
    const { report } = await run(scriptedIO(), { valuesEqualIndex: true });
    expect(report.findings).toMatchObject({
      setTakes: { filter: 'ambiguous', shaper: 'ambiguous' },
      restore: { verified: true },
    });
    expect(engine?.dsp()).toMatchObject(INITIAL);
  });

  it('records a single-value SetFilter that changes only the Nx filter', async () => {
    const { report } = await run(scriptedIO(), { singleFilterSetsBoth: false });
    expect(report.findings).toMatchObject({
      'filter.setSingle': { result: 'pass', sets1x: false, setsNx: true },
    });
    expect(engine?.dsp()).toMatchObject(INITIAL);
  });

  it('records a restart when a change during playback restarts the track', async () => {
    const { report } = await run(scriptedIO({ answers: { 'What did you hear': 'r' } }), {
      restartOnChange: true,
    });
    expect(report.findings).toMatchObject({
      whilePlaying: { shaper: { listener: 'r', timeline: { positionJumpedBack: true } } },
    });
    expect(engine?.dsp()).toMatchObject({ ...INITIAL, transport: 0 });
  });

  it('uses the listener’s own choice of test shaper and filter', async () => {
    const { report } = await run(scriptedIO({ texts: ['2', 'nonsense', '6', '1'] }));
    expect(report.steps.find((s) => s.id === 'D1')?.observations.target).toMatchObject({
      index: 2,
      name: 'ASDM5',
    });
    // "nonsense" and "6" (the current filter) are refused; "1" is taken
    expect(report.steps.find((s) => s.id === 'D2')?.observations.target).toMatchObject({
      index: 1,
    });
    expect(engine?.dsp()).toMatchObject(INITIAL);
  });

  it('skips steps it could not undo and never plays an empty playlist', async () => {
    const { report } = await run(scriptedIO(), {
      playlistLength: 0,
      matrixProfiles: ['only'],
      matrixCurrent: '',
    });
    expect(results(report)).toMatchObject({ D7: 'skipped', 'D8.1': 'skipped', 'D8.2': 'skipped' });
    expect(engine?.received.some((r) => r.name === 'Play')).toBe(false);
    expect(engine?.received.some((r) => r.name === 'MatrixSetProfile')).toBe(false);
  });

  it('aborts on q, runs nothing further and still verifies the settings', async () => {
    const { report } = await run(scriptedIO({ quitAt: 'D4' }));
    expect(report.aborted).toBe(true);
    expect(results(report)).toMatchObject({
      D1: 'pass',
      D3: 'pass',
      D4: 'not-run',
      D5: 'not-run',
      'D8.1': 'not-run',
      D9: 'pass',
    });
    expect(report.restore).toMatchObject({ needed: true, performed: false, verified: true });
    expect(engine?.received.some((r) => r.name === 'SetRate')).toBe(false);
    expect(engine?.dsp()).toMatchObject(INITIAL);
  });

  it('stops and tells the user when a setting can not be put back', async () => {
    const io = scriptedIO();
    const { report } = await run(io, { ignoreAfter: { cmd: 'SetShaping', count: 1 } });
    expect(results(report)).toMatchObject({ D1: 'fail', D2: 'not-run', D9: 'fail' });
    expect(report.restore).toMatchObject({
      performed: true,
      verified: false,
      differencesAfter: ['shaper'],
    });
    expect(io.lines.join('\n')).toContain('Not fully restored');
    expect(io.lines.join('\n')).toContain('[6] ASDM7EC-super 512+fs');
  });

  it('reconnects and restores after the connection drops in the middle of a change', async () => {
    const { report } = await run(scriptedIO(), { dropOn: 'SetRate' });
    expect(results(report)).toMatchObject({ D4: 'fail', D5: 'not-run' });
    expect(report.restore).toMatchObject({
      performed: true,
      verified: true,
      differencesBefore: ['rate'],
    });
    expect(report.restore.notes).toContain('reconnected for restore');
    expect(engine?.dsp()).toMatchObject(INITIAL);
  });

  it('sends no write command when the user declines to start', async () => {
    const { report } = await run(scriptedIO({ answers: { 'Start the DSP test': 'n' } }));
    expect(report.aborted).toBe(true);
    expect(report.steps).toEqual([]);
    expect(engine?.received.some((r) => /^(Set\w+|MatrixSetProfile|Play|Stop)$/.test(r.name))).toBe(
      false,
    );
  });

  it('asks before stopping playback and does not resume it afterwards', async () => {
    const declined = await run(scriptedIO({ answers: { 'Stop now': 'n' } }), {
      startPlaying: true,
    });
    expect(declined.report.aborted).toBe(true);
    expect(engine?.received.some((r) => r.name === 'Stop')).toBe(false);
    expect(engine?.dsp().transport).toBe(2);
    await engine?.close();

    const { report } = await run(scriptedIO({ skip: ['D8.1', 'D8.2'] }), { startPlaying: true });
    expect(report.start?.stoppedByTool).toBe(true);
    expect(results(report)).toMatchObject({ D1: 'pass', D9: 'pass' });
    expect(engine?.dsp()).toMatchObject({ ...INITIAL, transport: 0 });
  });

  it('exits with code 3 and writes nothing when HQPlayer is not reachable', async () => {
    const io = scriptedIO();
    const { report, exitCode, originalFile } = await runDspGate({
      port: 1,
      outDir: dir,
      io,
      stamp: 'test',
      timeoutMs: 500,
    });
    expect(exitCode).toBe(3);
    expect(report.reachable).toBe(false);
    expect(originalFile).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});
