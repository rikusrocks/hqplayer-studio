import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  exeFromUninstallEntries,
  normalizePrefs,
  parseRegQuery,
  windowControl,
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

// Real Win32 calls on the Windows CI runner, with Notepad standing in for HQPlayer.
describe.runIf(process.platform === 'win32')('window control (Windows)', () => {
  it('hides and shows a program window', async () => {
    const child = spawn('notepad.exe', [], { stdio: 'ignore' });
    try {
      let visible = false;
      for (let i = 0; i < 40 && !visible; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        visible = (await windowControl('notepad', 'list')).windows.some((w) => w.visible);
      }
      if (!visible) {
        console.warn('notepad window never appeared (no interactive desktop?) — skipped');
        return;
      }
      await windowControl('notepad', 'hide');
      expect((await windowControl('notepad', 'list')).windows.some((w) => w.visible)).toBe(false);
      await windowControl('notepad', 'show', 'Notepad');
      expect((await windowControl('notepad', 'list')).windows.some((w) => w.visible)).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);
});
