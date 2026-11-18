import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countElements,
  defaultSettingsPath,
  HqpSettingsBackups,
  type HqpProcessControl,
} from './hqp-settings-backup';

/** A settings file with `n` elements (HQPlayer's real layout is not assumed). */
const settings = (n: number, tag = 'v') =>
  `<?xml version="1.0"?>\n<settings>${Array.from({ length: n - 1 }, (_, i) => `<${tag} i="${i}"/>`).join('')}</settings>`;

let dir: string;
let hqpDir: string;
let file: string;
let clock: number;
let store: HqpSettingsBackups;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-hqpset-'));
  hqpDir = join(dir, 'HQPlayer');
  mkdirSync(hqpDir);
  file = join(hqpDir, 'settings.xml');
  clock = Date.UTC(2026, 10, 18, 9, 0, 0);
  store = new HqpSettingsBackups({
    dir: join(dir, 'backups'),
    settingsPath: () => file,
    now: () => (clock += 1000),
    sleep: async () => {
      clock += 500;
    },
    closeTimeoutMs: 5_000,
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeHqp(opts: { quits?: boolean; writesOnExit?: string } = {}) {
  const calls: string[] = [];
  let running = true;
  const ctl: HqpProcessControl = {
    isRunning: async () => running,
    close: async () => {
      calls.push('close');
      if (opts.quits === false) return;
      if (opts.writesOnExit) writeFileSync(file, opts.writesOnExit);
      running = false;
    },
    start: async () => {
      calls.push('start');
      running = true;
    },
  };
  return { ctl, calls, isRunning: () => running };
}

describe('HQPlayer settings backups', () => {
  it('finds the settings file where HQPlayer keeps it', () => {
    expect(defaultSettingsPath('win32', { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' })).toBe(
      'C:\\Users\\A\\AppData\\Local\\HQPlayer\\settings.xml',
    );
    expect(defaultSettingsPath('darwin', {}, '/Users/a')).toBe('/Users/a/.hqplayer/settings.xml');
    expect(countElements(settings(40))).toBe(40);
  });

  it('copies the file only when it changes and reports a missing file', async () => {
    let s = await store.check();
    expect(s).toMatchObject({ found: false, backups: [] });
    writeFileSync(file, settings(80));
    s = await store.check();
    expect(s.found).toBe(true);
    expect(s.backups).toHaveLength(1);
    expect(s.backups[0]).toMatchObject({ elements: 80, suspect: false, reason: 'auto' });
    s = await store.check();
    expect(s.backups).toHaveLength(1); // unchanged
    writeFileSync(file, settings(81));
    s = await store.check();
    expect(s.backups).toHaveLength(2);
    expect(s.resetWarning).toBeNull();
  });

  it('flags a file that shrank to defaults and keeps the good copy', async () => {
    writeFileSync(file, settings(120));
    const good = (await store.check()).backups[0]!;
    writeFileSync(file, settings(25)); // HQPlayer came back with blank defaults
    const s = await store.check();
    expect(s.backups[0]).toMatchObject({ suspect: true, elements: 25 });
    expect(s.resetWarning).toMatchObject({ goodId: good.id, currentId: s.backups[0]!.id });
    // the warning survives Studio restarting
    const again = new HqpSettingsBackups({ dir: join(dir, 'backups'), settingsPath: () => file });
    expect((await again.state()).resetWarning?.goodId).toBe(good.id);
  });

  it('restores: closes HQPlayer first, keeps the current file, writes the copy, starts it again', async () => {
    writeFileSync(file, settings(120));
    const good = (await store.check()).backups[0]!;
    writeFileSync(file, settings(25));
    await store.check();
    // HQPlayer writes its (blank) settings once more while quitting
    const hqp = fakeHqp({ writesOnExit: settings(26) });
    const report = await store.restore(good.id, hqp.ctl);
    expect(report.ok).toBe(true);
    expect(hqp.calls).toEqual(['close', 'start']);
    expect(report.steps.map((s) => s.id)).toEqual([
      'read',
      'close',
      'keep-current',
      'write',
      'start',
    ]);
    expect(readFileSync(file, 'utf8')).toBe(settings(120));
    const s = await store.state();
    expect(s.resetWarning).toBeNull();
    // what HQPlayer wrote on exit was kept as a copy too
    expect(s.backups.some((b) => b.reason === 'before-restore' && b.elements === 26)).toBe(true);
  });

  it('never writes while HQPlayer is still running', async () => {
    writeFileSync(file, settings(120));
    const good = (await store.check()).backups[0]!;
    writeFileSync(file, settings(25));
    const hqp = fakeHqp({ quits: false });
    const report = await store.restore(good.id, hqp.ctl);
    expect(report).toMatchObject({ ok: false, error: 'still_running' });
    expect(readFileSync(file, 'utf8')).toBe(settings(25));
    expect(hqp.calls).toEqual(['close']);
  });

  it('refuses a damaged copy and leaves HQPlayer alone', async () => {
    writeFileSync(file, settings(120));
    const good = (await store.check()).backups[0]!;
    writeFileSync(join(dir, 'backups', `${good.id}.xml`), 'tampered');
    const hqp = fakeHqp();
    const report = await store.restore(good.id, hqp.ctl);
    expect(report).toMatchObject({ ok: false, error: 'damaged' });
    expect(hqp.calls).toEqual([]);
  });

  it('prunes old copies but never pinned ones or the best good one', async () => {
    const small = new HqpSettingsBackups({
      dir: join(dir, 'b2'),
      settingsPath: () => file,
      now: () => (clock += 1000),
      keep: 3,
    });
    writeFileSync(file, settings(200));
    const best = (await small.check()).backups[0]!;
    writeFileSync(file, settings(150));
    const pinned = (await small.check()).backups[0]!;
    await small.setPinned(pinned.id, true);
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(file, settings(150 + i + 1));
      await small.check();
    }
    const ids = (await small.state()).backups.map((b) => b.id);
    expect(ids).toContain(best.id);
    expect(ids).toContain(pinned.id);
    expect(ids).toHaveLength(5); // 3 newest + best + pinned
  });
});
