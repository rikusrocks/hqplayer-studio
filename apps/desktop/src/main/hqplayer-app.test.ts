import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  describeWindowError,
  detectHqplayerExe,
  ensureHqplayer,
  exeFromUninstallEntries,
  findHqplayerProcess,
  launchHqplayer,
  normalizePrefs,
  parseRegQuery,
  parseTasklist,
  rememberReport,
  reportsForDiagnostics,
  resolveHqplayerExe,
  scrubPaths,
  watchWindows,
  windowControl,
  type DetectDeps,
  type EnsureDeps,
  type HqpLaunchResult,
  type HqpRunReport,
  type HqpWindowAction,
  type HqpWindowInfo,
  type WindowControlResult,
} from './hqplayer-app';

// Shape of `reg query <Uninstall> /s /f HQPlayer /d` output (values are illustrative).
const REG = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HQPlayer 6 Desktop',
  '    DisplayName    REG_SZ    HQPlayer 6 Desktop',
  '    DisplayIcon    REG_SZ    "C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe",0',
  '    InstallLocation    REG_SZ    C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HQPlayer Studio',
  '    DisplayName    REG_SZ    HQPlayer Studio',
  '',
  'End of search: 2 match(es) found.',
].join('\r\n');

describe('HQPlayer program detection', () => {
  it('parses reg query output into keys', () => {
    const entries = parseRegQuery(REG);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      DisplayName: 'HQPlayer 6 Desktop',
      InstallLocation: 'C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop',
    });
  });

  it('finds the HQPlayer Desktop executable, never Studio itself', () => {
    expect(exeFromUninstallEntries(parseRegQuery(REG), () => [])).toBe(
      'C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe',
    );
    const noIcon = parseRegQuery(REG.replace(/^.*DisplayIcon.*$/m, ''));
    expect(
      exeFromUninstallEntries(noIcon, () => [
        'unins000.exe',
        'hqp-control.exe',
        'HQPlayer6Desktop.exe',
      ]),
    ).toBe('C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe');
    const studioOnly = parseRegQuery(REG.split('\r\n').slice(6).join('\r\n'));
    expect(exeFromUninstallEntries(studioOnly, () => ['HQPlayer Studio.exe'])).toBeNull();
  });

  it('normalizes preferences', () => {
    expect(normalizePrefs(null)).toEqual({ exePath: null, autoStart: false, windowMode: 'normal' });
    expect(
      normalizePrefs({ exePath: ' C:\\x.exe ', autoStart: true, windowMode: 'hidden' }),
    ).toEqual({
      exePath: 'C:\\x.exe',
      autoStart: true,
      windowMode: 'hidden',
    });
    expect(normalizePrefs({ windowMode: 'weird' }).windowMode).toBe('normal');
  });
});

const EXE = 'C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop\\HQPlayer6Desktop.exe';
const DIR = 'C:\\Program Files\\Signalyst\\HQPlayer 6 Desktop';
const UNINSTALL = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

function detectDeps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    env: {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    },
    exists: () => true,
    listDir: () => [],
    regQuery: async () => {
      throw Object.assign(new Error('no match'), { code: 1 });
    },
    ...over,
  };
}

describe('HQPlayer program detection (injected registry / folders / shortcuts)', () => {
  it('keeps empty registry values', () => {
    const [entry] = parseRegQuery(
      ['HKEY_LOCAL_MACHINE\\X', '    InstallLocation    REG_SZ', '    Name    REG_SZ    a'].join(
        '\r\n',
      ),
    );
    expect(entry).toMatchObject({ InstallLocation: '', Name: 'a' });
  });

  it('reads each matching key in full: the install folder need not contain "HQPlayer"', async () => {
    const key = `${UNINSTALL}\\{1F2E3D4C}`;
    const calls: string[][] = [];
    const found = await detectHqplayerExe(
      detectDeps({
        regQuery: async (args) => {
          calls.push(args);
          if (args.includes('/f')) {
            if (!args[0]?.startsWith('HKLM\\SOFTWARE\\Microsoft')) {
              throw Object.assign(new Error('no match'), { code: 1 });
            }
            // the filtered search only prints the value that contains "HQPlayer"
            return [key, '    DisplayName    REG_SZ    HQPlayer 6 Desktop', ''].join('\r\n');
          }
          return [
            key,
            '    DisplayName    REG_SZ    HQPlayer 6 Desktop',
            '    DisplayIcon    REG_SZ    C:\\Windows\\Installer\\{1F2E3D4C}\\icon.ico',
            '    InstallLocation    REG_SZ    D:\\Audio\\Player',
          ].join('\r\n');
        },
        listDir: (dir) => (dir === 'D:\\Audio\\Player' ? ['HQPlayer6Desktop.exe'] : []),
      }),
    );
    expect(found.exePath).toBe('D:\\Audio\\Player\\HQPlayer6Desktop.exe');
    expect(found.source).toBe('registry');
    expect(calls).toContainEqual([key]);
  });

  it('falls back to a Start-menu shortcut when the registry entry has no usable path', async () => {
    const key = `${UNINSTALL}\\{1F2E3D4C}`;
    const menu = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
    const found = await detectHqplayerExe(
      detectDeps({
        regQuery: async (args) => {
          if (args.includes('/f') && !args[0]?.startsWith('HKLM\\SOFTWARE\\Microsoft')) {
            throw Object.assign(new Error('no match'), { code: 1 });
          }
          return [key, '    DisplayName    REG_SZ    HQPlayer 6 Desktop'].join('\r\n');
        },
        listDir: (dir) =>
          dir === menu
            ? ['HQPlayer 6.1']
            : dir === `${menu}\\HQPlayer 6.1`
              ? ['HQPlayer 6 Client.lnk', 'HQPlayer 6 Desktop.lnk', 'HQPlayer manual.lnk']
              : [],
        readShortcut: (lnk) => (lnk.endsWith('Desktop.lnk') ? EXE : 'C:\\other.exe'),
      }),
    );
    expect(found).toMatchObject({ exePath: EXE, source: 'shortcut' });
    expect(found.searched[0]).toEqual({
      where: 'registry',
      result: 'missing',
      detail: 'HQPlayer 6 Desktop',
    });
  });

  it('falls back to Program Files\\Signalyst', async () => {
    const found = await detectHqplayerExe(
      detectDeps({
        listDir: (dir) =>
          dir === 'C:\\Program Files\\Signalyst'
            ? ['HQPlayer 6 Desktop']
            : dir === DIR
              ? ['unins000.exe', 'HQPlayer6Client.exe', 'HQPlayer6Desktop.exe']
              : [],
      }),
    );
    expect(found).toMatchObject({ exePath: EXE, source: 'folder' });
  });

  it('says where it looked when nothing is found', async () => {
    const found = await detectHqplayerExe(detectDeps({ readShortcut: () => null }));
    expect(found.exePath).toBeNull();
    expect(found.searched).toEqual([
      { where: 'registry', result: 'none' },
      { where: 'shortcut', result: 'none' },
      { where: 'folder', result: 'none' },
    ]);
  });

  it('prefers the user’s choice, and learns the location from a running HQPlayer', async () => {
    const base = {
      exists: (p: string) => p === EXE,
      detect: async () => ({ exePath: null, source: null, searched: [] }),
      remembered: () => null,
      remember: () => undefined,
      listProcesses: async () => [{ image: 'HQPlayer6Desktop.exe', pid: 42 }],
      processPath: async () => EXE,
    };
    expect(await resolveHqplayerExe({ ...base, preferred: EXE })).toMatchObject({
      exePath: EXE,
      source: 'preference',
    });
    let saved = '';
    const learned = await resolveHqplayerExe({
      ...base,
      preferred: 'C:\\Old\\HQPlayer5Desktop.exe', // uninstalled
      remember: (p) => (saved = p),
    });
    expect(learned).toMatchObject({ exePath: EXE, source: 'running' });
    expect(learned.searched[0]).toEqual({ where: 'preference', result: 'missing' });
    expect(saved).toBe(EXE);
    const remembered = await resolveHqplayerExe({
      ...base,
      preferred: null,
      remembered: () => EXE,
      listProcesses: async () => [],
    });
    expect(remembered).toMatchObject({ exePath: EXE, source: 'remembered' });
  });
});

describe('process list', () => {
  const TASKLIST = [
    '"System Idle Process","0","Services","0","8 K"',
    '"HQPlayer Studio.exe","900","Console","1","90,000 K"',
    '"HQPlayer6Client.exe","901","Console","1","90,000 K"',
    '"HQPlayer6Desktop.exe","4242","Console","1","512,000 K"',
    '',
  ].join('\r\n');

  it('parses tasklist CSV and ignores localized messages', () => {
    expect(parseTasklist(TASKLIST)).toHaveLength(4);
    expect(parseTasklist('信息: 没有运行的任务匹配指定标准。\r\n')).toEqual([]);
  });

  it('finds HQPlayer Desktop — never Studio or the Client', () => {
    const list = parseTasklist(TASKLIST);
    expect(findHqplayerProcess(list, EXE)).toEqual({ image: 'HQPlayer6Desktop.exe', pid: 4242 });
    expect(findHqplayerProcess(list, null)?.pid).toBe(4242);
    // another executable is configured, but an HQPlayer is up: do not start a second one
    expect(findHqplayerProcess(list, 'C:\\x\\HQPlayer5Desktop.exe')?.pid).toBe(4242);
    expect(findHqplayerProcess(list.slice(0, 3), EXE)).toBeNull();
  });
});

describe('starting HQPlayer', () => {
  const child = (event: 'spawn' | 'error', err?: Error) => ({
    once(name: string, cb: (e?: Error) => void) {
      if (name === event) queueMicrotask(() => cb(err));
      return this;
    },
    unref() {},
  });
  const enoent = new Error(`spawn ${EXE} ENOENT`);

  it('reports a direct start', async () => {
    const seen: { windowsHide: boolean; cwd: string }[] = [];
    const deps = {
      spawn: ((_c: string, _a: string[], o: { windowsHide: boolean; cwd: string }) => {
        seen.push(o);
        return child('spawn');
      }) as never,
    };
    expect(await launchHqplayer(EXE, { hidden: true }, deps)).toEqual({
      ok: true,
      method: 'direct',
    });
    expect(seen[0]).toMatchObject({ windowsHide: true, cwd: DIR });
  });

  it('reports the spawn error, without the folder', async () => {
    const res = await launchHqplayer(EXE, {}, { spawn: (() => child('error', enoent)) as never });
    expect(res).toEqual({
      ok: false,
      method: 'direct',
      error: 'spawn …\\HQPlayer6Desktop.exe ENOENT',
    });
  });

  it('falls back to the Windows shell when the direct start is refused', async () => {
    const spawnFails = (() => child('error', new Error('spawn EACCES'))) as never;
    expect(await launchHqplayer(EXE, {}, { spawn: spawnFails, openPath: async () => '' })).toEqual({
      ok: true,
      method: 'shell',
      error: 'spawn EACCES',
    });
    const both = await launchHqplayer(
      EXE,
      {},
      { spawn: spawnFails, openPath: async () => 'Failed to open path' },
    );
    expect(both).toMatchObject({ ok: false, error: 'spawn EACCES; Failed to open path' });
  });
});

/** A fake HQPlayer: `at(ms)` says which windows exist; hide / minimize act on visible ones. */
function fakeWindows(at: (ms: number) => { pids: number[]; windows: HqpWindowInfo[] } | Error) {
  let t = 0;
  const hidden = new Set<number>();
  const actions: HqpWindowAction[] = [];
  return {
    actions,
    hidden,
    elapsed: () => t,
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      control: async (_name: string, action: HqpWindowAction): Promise<WindowControlResult> => {
        actions.push(action);
        t += 300; // PowerShell is not instant
        const state = at(t);
        if (state instanceof Error) throw state;
        return {
          pids: state.pids,
          windows: state.windows.map((w) => {
            const visible = w.visible && !hidden.has(w.handle);
            const act = action !== 'list' && visible && !(action === 'minimize' && w.minimized);
            if (act && action === 'hide') hidden.add(w.handle);
            return { ...w, visible: visible && action !== 'hide', changed: act };
          }),
        };
      },
    },
  };
}
const win = (handle: number, title: string, visible = true): HqpWindowInfo => ({
  handle,
  title,
  className: 'Qt6QWindowIcon',
  visible,
});
const TIMING = { minMs: 30_000, settleMs: 10_000, maxMs: 90_000, pollMs: 700 };

describe('window watcher', () => {
  const helper = win(1, 'HQPlayer helper', false);

  it('hides a splash screen and the main window that appears later', async () => {
    const hq = fakeWindows((ms) => ({
      pids: ms < 1500 ? [] : [7],
      windows:
        ms < 2500
          ? []
          : ms < 9000
            ? [helper, win(2, 'HQPlayer splash')]
            : [helper, win(3, 'HQPlayer 6 Desktop')], // main window, long after the splash
    }));
    const res = await watchWindows(
      { processName: 'HQPlayer6Desktop', mode: 'hidden', ...TIMING, expectStart: true },
      hq.deps,
    );
    expect(res.status).toBe('done');
    expect(res.changed).toBe(2);
    expect(res.windows.map((w) => w.title)).toEqual(['HQPlayer splash', 'HQPlayer 6 Desktop']);
    expect([...hq.hidden]).toEqual([2, 3]);
    expect(hq.actions.every((a) => a === 'hide')).toBe(true);
    // stopped by "quiet for 10 s after 30 s", not by the 90 s limit
    expect(hq.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(hq.elapsed()).toBeLessThan(40_000);
  });

  it('does not take an invisible helper window for "already hidden"', async () => {
    // only a helper window for 25 s, then the real one
    const hq = fakeWindows((ms) => ({
      pids: [7],
      windows: ms < 25_000 ? [helper] : [helper, win(3, 'HQPlayer 6 Desktop')],
    }));
    const res = await watchWindows(
      { processName: 'HQPlayer6Desktop', mode: 'hidden', ...TIMING, expectStart: true },
      hq.deps,
    );
    expect(res).toMatchObject({ status: 'done', changed: 1 });
    expect(hq.hidden.has(3)).toBe(true);
  });

  it('is short when HQPlayer was already running, and minimizes only once', async () => {
    let minimized = false;
    const hq = fakeWindows(() => ({
      pids: [7],
      windows: [{ ...win(3, 'HQPlayer 6 Desktop'), minimized }],
    }));
    const control = hq.deps.control;
    hq.deps.control = async (name, action) => {
      const r = await control(name, action);
      if (r.windows.some((w) => w.changed)) minimized = true;
      return r;
    };
    const res = await watchWindows(
      {
        processName: 'HQPlayer6Desktop',
        mode: 'minimized',
        minMs: 0,
        settleMs: 6000,
        maxMs: 20_000,
        pollMs: 700,
        expectStart: false,
      },
      hq.deps,
    );
    expect(res).toMatchObject({ status: 'done', changed: 1 });
    expect(hq.actions.every((a) => a === 'minimize')).toBe(true);
    expect(hq.elapsed()).toBeLessThan(9000);
  });

  it('reports "not running" at once when nothing was started', async () => {
    const hq = fakeWindows(() => ({ pids: [], windows: [] }));
    const res = await watchWindows(
      { processName: 'x', mode: 'hidden', ...TIMING, expectStart: false },
      hq.deps,
    );
    expect(res.status).toBe('not-running');
    expect(hq.actions).toHaveLength(1);
  });

  it('gives up with the error text after two failed polls, but survives one', async () => {
    const broken = fakeWindows(() => new Error('Window control (hide) failed: Cannot add type'));
    const res = await watchWindows(
      { processName: 'x', mode: 'hidden', ...TIMING, expectStart: true },
      broken.deps,
    );
    expect(res).toMatchObject({
      status: 'failed',
      changed: 0,
      error: 'Window control (hide) failed: Cannot add type',
    });
    expect(broken.actions).toHaveLength(2);

    let calls = 0;
    const flaky = fakeWindows(() => {
      calls += 1;
      return calls === 2
        ? new Error('timed out')
        : { pids: [7], windows: [win(3, 'HQPlayer 6 Desktop')] };
    });
    const ok = await watchWindows(
      { processName: 'x', mode: 'hidden', ...TIMING, expectStart: true },
      flaky.deps,
    );
    expect(ok).toMatchObject({ status: 'done', changed: 1 });
  });

  it('stops when a newer action cancels it', async () => {
    const cancel = { cancelled: false };
    const hq = fakeWindows((ms) => {
      if (ms > 5000) cancel.cancelled = true;
      return { pids: [7], windows: [win(3, 'HQPlayer 6 Desktop')] };
    });
    const res = await watchWindows(
      { processName: 'x', mode: 'hidden', ...TIMING, expectStart: true, cancel },
      hq.deps,
    );
    expect(res.status).toBe('cancelled');
    expect(hq.elapsed()).toBeLessThan(7000);
  });
});

describe('one run: find, start, tidy the window', () => {
  function world(
    over: Partial<EnsureDeps> & { running?: boolean; launchResult?: HqpLaunchResult },
  ) {
    const hq = fakeWindows(() => ({ pids: [7], windows: [win(3, 'HQPlayer 6 Desktop')] }));
    const launched: { exe: string; hidden: boolean }[] = [];
    let running = over.running ?? false;
    const deps: EnsureDeps = {
      ...hq.deps,
      resolveExe: async () => ({
        exePath: EXE,
        source: 'registry',
        searched: [{ where: 'registry', result: 'found', detail: 'HQPlayer 6 Desktop' }],
      }),
      listProcesses: async () => (running ? [{ image: 'HQPlayer6Desktop.exe', pid: 7 }] : []),
      probeEngine: async () => false,
      launch: async (exe, o) => {
        launched.push({ exe, hidden: o.hidden });
        const result = over.launchResult ?? { ok: true, method: 'direct' };
        if (result.ok) running = true;
        return result;
      },
      ...over,
    };
    return { deps, hq, launched };
  }
  const startup = { trigger: 'startup', launchIfStopped: true, windowMode: 'hidden' } as const;

  it('starts HQPlayer and hides its window', async () => {
    const { deps, hq, launched } = world({});
    const { report, settled } = await ensureHqplayer(startup, deps);
    expect(launched).toEqual([{ exe: EXE, hidden: true }]);
    expect(report.process).toMatchObject({ status: 'started', method: 'direct', seen: true });
    expect(report.window.status).toBe('watching');
    const final = await settled;
    expect(final.window).toMatchObject({ status: 'done', changed: 1 });
    expect(hq.hidden.has(3)).toBe(true);
  });

  it('still starts HQPlayer when the window step throws', async () => {
    const { deps, launched } = world({
      control: async () => {
        throw new Error('Window control (hide) failed: [ConstrainedLanguage] Cannot add type');
      },
    });
    const { report, settled } = await ensureHqplayer(startup, deps);
    expect(launched).toHaveLength(1);
    expect(report.process.status).toBe('started');
    const final = await settled;
    expect(final.process.status).toBe('started');
    expect(final.window).toMatchObject({
      status: 'failed',
      error: 'Window control (hide) failed: [ConstrainedLanguage] Cannot add type',
    });
  });

  it('reports "not found" with the places it looked, and starts nothing', async () => {
    const searched = [
      { where: 'registry', result: 'none' },
      { where: 'shortcut', result: 'none' },
      { where: 'folder', result: 'none' },
      { where: 'running', result: 'none' },
    ] as const;
    const { deps, launched } = world({
      resolveExe: async () => ({ exePath: null, source: null, searched: [...searched] }),
    });
    const { report } = await ensureHqplayer(startup, deps);
    expect(launched).toHaveLength(0);
    expect(report.exe).toEqual({ status: 'not-found', source: null, path: null, searched });
    expect(report.process.status).toBe('no-exe');
    expect(report.window.status).toBe('skipped');
  });

  it('reports a failed start with the error text, and skips the window step', async () => {
    const { deps, hq } = world({
      launchResult: { ok: false, method: 'shell', error: 'spawn EACCES; Access is denied.' },
    });
    const { report } = await ensureHqplayer(startup, deps);
    expect(report.process).toMatchObject({
      status: 'start-failed',
      error: 'spawn EACCES; Access is denied.',
    });
    expect(report.window.status).toBe('skipped');
    expect(hq.actions).toHaveLength(0);
  });

  it('does not start a second HQPlayer, and only tidies the window', async () => {
    const { deps, launched } = world({ running: true });
    const { report, settled } = await ensureHqplayer({ ...startup, trigger: 'connected' }, deps);
    expect(launched).toHaveLength(0);
    expect(report.process).toMatchObject({ status: 'running', image: 'HQPlayer6Desktop.exe' });
    expect((await settled).window).toMatchObject({ status: 'done', changed: 1 });
  });

  it('leaves a stopped HQPlayer alone when starting was not asked for', async () => {
    const { deps, launched, hq } = world({});
    const { report } = await ensureHqplayer({ ...startup, launchIfStopped: false }, deps);
    expect(launched).toHaveLength(0);
    expect(report.process.status).toBe('not-running');
    expect(hq.actions).toHaveLength(0);
  });

  it('uses the control port when the process list cannot be read', async () => {
    const failing = async () => {
      throw new Error('tasklist: access denied');
    };
    // port answers: HQPlayer is up, so it is not started again
    const up = world({ listProcesses: failing, probeEngine: async () => true });
    const a = await ensureHqplayer(startup, up.deps);
    expect(up.launched).toHaveLength(0);
    expect(a.report.process).toMatchObject({
      status: 'running',
      checkError: 'tasklist: access denied',
    });
    // port silent: start it anyway — an unreadable process list must not block the start
    const down = world({ listProcesses: failing });
    const b = await ensureHqplayer(startup, down.deps);
    expect(down.launched).toHaveLength(1);
    expect(b.report.process).toMatchObject({ status: 'started', seen: null });
  });

  it('leaves the window alone in "normal" mode', async () => {
    const { deps, hq } = world({});
    const { report } = await ensureHqplayer({ ...startup, windowMode: 'normal' }, deps);
    expect(report.process.status).toBe('started');
    expect(report.window.status).toBe('skipped');
    expect(hq.actions).toHaveLength(0);
  });
});

describe('reports', () => {
  const report = (id: number, trigger: HqpRunReport['trigger']): HqpRunReport => ({
    id,
    at: 1_700_000_000_000 + id,
    trigger,
    launchRequested: true,
    windowMode: 'hidden',
    exe: {
      status: 'found',
      source: 'preference',
      path: 'C:\\Users\\someone\\Apps\\HQPlayer6Desktop.exe',
      searched: [{ where: 'preference', result: 'found' }],
    },
    process: {
      status: 'start-failed',
      image: 'HQPlayer6Desktop.exe',
      error: 'spawn C:\\Users\\someone\\Apps\\HQPlayer6Desktop.exe EACCES',
    },
    window: {
      status: 'done',
      changed: 1,
      windows: [{ title: 'Some Artist - Some Song', className: 'Qt6QWindowIcon' }],
    },
  });

  it('keeps the startup report, and one line for repeated reconnects', () => {
    let list: HqpRunReport[] = [];
    list = rememberReport(list, report(1, 'startup'));
    for (let id = 2; id <= 5; id += 1) list = rememberReport(list, report(id, 'connected'));
    expect(list.map((r) => r.id)).toEqual([5, 1]);
    for (let id = 6; id <= 20; id += 1) list = rememberReport(list, report(id, 'manual'));
    expect(list).toHaveLength(6);
    expect(list[0]?.id).toBe(20);
    expect(list.some((r) => r.trigger === 'startup')).toBe(true);
    const updated = { ...report(20, 'manual'), windowMode: 'minimized' as const };
    expect(rememberReport(list, updated)[0]?.windowMode).toBe('minimized');
  });

  it('copies no folder names and no window titles into the diagnostics', () => {
    const text = JSON.stringify(reportsForDiagnostics([report(1, 'startup')]));
    expect(text).not.toContain('someone');
    expect(text).not.toContain('Some Song');
    expect(text).toContain('HQPlayer6Desktop.exe');
    expect(text).toContain('"titleLength":23');
    expect(text).toContain('EACCES');
    expect(scrubPaths('open "D:\\My Music\\a b\\x.exe" failed')).toBe('open "…\\x.exe" failed');
  });

  it('extracts the useful line from a failed PowerShell call', () => {
    expect(describeWindowError({ killed: true }, 30_000)).toBe('timed out after 30 s');
    expect(describeWindowError({ code: 'ENOENT' }, 1)).toBe('powershell.exe was not found');
    expect(
      describeWindowError(
        { code: 3, stdout: 'HQPS_ERROR [ConstrainedLanguage] Cannot add type.\r\n' },
        1,
      ),
    ).toBe('[ConstrainedLanguage] Cannot add type.');
    expect(
      describeWindowError(
        {
          code: 1,
          stderr:
            '#< CLIXML\r\n<Objs Version="1.1"><S S="Error">Access is denied_x000D__x000A_</S></Objs>',
        },
        1,
      ),
    ).toBe('Access is denied');
    expect(describeWindowError({ code: 5 }, 1)).toBe('PowerShell exited with code 5');
  });
});

// Real Win32 calls on the Windows CI runner, with Notepad standing in for HQPlayer.
// Shared runners can be very slow to start PowerShell: generous timeouts and two retries.
const SLOW = 60_000;
describe.runIf(process.platform === 'win32')('window control (Windows)', () => {
  it('hides and shows a program window', { timeout: 240_000, retry: 2 }, async () => {
    const child = spawn('notepad.exe', [], { stdio: 'ignore' });
    const anyVisible = async () =>
      (await windowControl('notepad', 'list', undefined, SLOW)).windows.some((w) => w.visible);
    try {
      let visible = false;
      for (let i = 0; i < 40 && !visible; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        visible = await anyVisible();
      }
      if (!visible) {
        console.warn('notepad window never appeared (no interactive desktop?) — skipped');
        return;
      }
      await windowControl('notepad', 'hide', undefined, SLOW);
      expect(await anyVisible()).toBe(false);
      await windowControl('notepad', 'show', 'Notepad', SLOW);
      expect(await anyVisible()).toBe(true);
    } finally {
      child.kill();
    }
  });

  // The watcher must also hide a window that becomes visible after the first one was hidden
  // (HQPlayer's main window after its splash screen): the same window is shown again here.
  it('keeps hiding a window that turns up later', { timeout: 420_000, retry: 2 }, async () => {
    const child = spawn('notepad.exe', [], { stdio: 'ignore' });
    const list = async () => (await windowControl('notepad', 'list', undefined, SLOW)).windows;
    const anyVisible = async () => (await list()).some((w) => w.visible);
    try {
      let visible = false;
      for (let i = 0; i < 40 && !visible; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        visible = await anyVisible();
      }
      if (!visible) {
        console.warn('notepad window never appeared (no interactive desktop?) — skipped');
        return;
      }
      const watching = watchWindows(
        {
          processName: 'notepad',
          mode: 'hidden',
          minMs: 0,
          settleMs: 45_000,
          maxMs: 240_000,
          pollMs: 500,
          expectStart: true,
        },
        {
          control: (name, action) => windowControl(name, action, undefined, SLOW),
          now: Date.now,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
      );
      for (let i = 0; i < 20 && (await anyVisible()); i += 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await windowControl('notepad', 'show', 'Notepad', SLOW); // "appears" again
      const result = await watching;
      expect(result.status).toBe('done');
      expect(result.changed).toBeGreaterThanOrEqual(2);
      expect(await anyVisible()).toBe(false);
    } finally {
      child.kill();
    }
  });
});
