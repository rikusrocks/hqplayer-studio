import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCrashHandlers } from './crash-handlers';
import { createRedactor } from './redact';
import { FileLog } from './studio-log';

describe('log privacy filter', () => {
  const redact = createRedactor({
    appRoots: ['C:\\Users\\Mei\\AppData\\Local\\Programs\\hqplayer-studio\\resources\\app.asar'],
    hostname: 'MEI-MUSIC-PC',
    username: 'Mei',
  });

  it('removes paths of every shape, keeping Studio code locations', () => {
    expect(
      redact("ENOENT: no such file, open 'D:\\Music\\周杰伦\\范特西\\01 爱在西元前.flac'"),
    ).toBe("ENOENT: no such file, open '<path>'");
    expect(redact('scan root \\\\NAS\\music\\Jazz failed')).toBe('scan root <path>');
    expect(redact('PlaylistAdd uri file:C:\\Music\\My Album\\02 Song.dsf')).toBe(
      'PlaylistAdd uri <path>',
    );
    expect(redact('cannot read /Users/mei/Music/x.flac')).toBe('cannot read <path>');
    expect(redact('at run (/home/mei/dev/thing.js:1:2)')).toBe('at run (<path>');
    expect(
      redact(
        'at f (file:///C:/Users/Mei/AppData/Local/Programs/hqplayer-studio/resources/app.asar/dist/main/main.mjs:120:7)',
      ),
    ).toBe('at f (<app>/dist/main/main.mjs:120:7)');
    expect(
      redact(
        'at f (C:\\Users\\Mei\\AppData\\Local\\Programs\\hqplayer-studio\\resources\\app.asar\\dist\\main\\main.mjs:5:1)',
      ),
    ).toBe('at f (<app>\\dist\\main\\main.mjs:5:1)');
  });

  it('removes music / cover / lyrics file names, host and user names, LAN addresses, tokens', () => {
    expect(redact('could not parse Track01.flac and cover.JPG and song.lrc')).toBe(
      'could not parse <file.flac> and <file.jpg> and <file.lrc>',
    );
    expect(redact('host MEI-MUSIC-PC.local user mei')).toBe('host <host>.local user <user>');
    expect(redact('listening on 192.168.1.23:47321 and 10.0.0.5, loopback 127.0.0.1')).toBe(
      'listening on <lan-ip>:47321 and <lan-ip>, loopback 127.0.0.1',
    );
    expect(redact('Authorization: Bearer abc.DEF-123 / hqps.auth.xyz')).toBe(
      'Authorization: Bearer <token> / hqps.auth.<token>',
    );
  });

  it('labels HQPlayer metadata attributes like the diagnostics report', () => {
    const out = redact('<Status title="夜曲" artist="周杰伦" track="3" uri="file:D:\\a.flac"/>');
    expect(out).not.toContain('夜曲');
    expect(out).not.toContain('周杰伦');
    expect(out).not.toContain('D:');
    expect(out).toContain('track="3"');
  });

  it('leaves ordinary words alone (short user names are not replaced)', () => {
    const r = createRedactor({ hostname: 'pc', username: 'me', appRoots: [] });
    expect(r('transport playing track=3 of=12 output="DSD512"')).toBe(
      'transport playing track=3 of=12 output="DSD512"',
    );
    expect(r('give me the pc')).toBe('give me the pc');
  });
});

describe('FileLog', () => {
  let dir: string;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hqps-log-'));
    now = Date.UTC(2026, 10, 17, 9, 0, 0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (extra: Partial<ConstructorParameters<typeof FileLog>[0]> = {}) =>
    new FileLog({
      dir,
      appVersion: '0.5.0',
      hostname: 'MEI-MUSIC-PC',
      username: 'Mei',
      now: () => now,
      ...extra,
    });

  it('writes redacted lines and collapses repeats', () => {
    const log = make();
    log.info('engine', 'HQPlayer connected', { adapter: 'live' });
    for (let i = 0; i < 5; i++) log.warn('engine', 'HQPlayer disconnected');
    now += 1000;
    log.error('library', 'scan failed', { error: "EACCES: open 'E:\\Private\\Mei\\a.flac'" });
    const text = readFileSync(join(dir, 'studio.log'), 'utf8');
    expect(text).toContain('INFO  [engine] HQPlayer connected adapter="live"');
    expect(text.match(/HQPlayer disconnected/g)).toHaveLength(1);
    expect(text).toContain('(previous line repeated 4 more times)');
    expect(text).toContain('error="EACCES: open \'<path>');
    expect(text).not.toContain('Private');
    expect(text).not.toMatch(/mei/i);
    const sum = log.summary();
    expect(sum.counts).toEqual({ info: 1, warn: 1, error: 1 });
    expect(sum.problems).toHaveLength(3); // warn, its repeat note, error
  });

  it('rotates files and keeps a fixed number', () => {
    const log = make({ maxBytes: 400, keepFiles: 2 });
    for (let i = 0; i < 60; i++) {
      now += 61_000; // no repeat collapsing
      log.info('test', `line ${i} ${'x'.repeat(40)}`);
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    expect(files).toEqual(['studio.1.log', 'studio.2.log', 'studio.log']);
    for (const f of files) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(400);
    expect(readFileSync(join(dir, 'studio.log'), 'utf8')).toContain('line 59');
  });

  it('writes crash reports with the error, recent lines and no private data', () => {
    const log = make();
    log.info('engine', 'transport playing', { track: 3 });
    const err = new Error('boom while reading D:\\Music\\Album\\01.flac on MEI-MUSIC-PC');
    const name = log.crash('uncaught-exception', { error: err, info: { page: 'main window' } });
    expect(name).toMatch(/^crash-20261117T090000000Z-uncaught-exception\.txt$/);
    const text = readFileSync(join(dir, name!), 'utf8');
    expect(text).toContain('version: 0.5.0');
    expect(text).toContain('boom while reading <path>');
    expect(text).toContain('page: main window');
    expect(text).toContain('[engine] transport playing track=3');
    expect(text).not.toContain('Music');
    expect(text).not.toContain('MEI-MUSIC-PC');
    const [report] = log.summary().crashReports;
    expect(report).toMatchObject({ name, kind: 'uncaught-exception' });
    expect(report!.summary).toContain('boom');
  });

  it('notices when the previous session did not end normally', () => {
    const first = make();
    first.startSession();
    now += 5 * 60_000;
    // no endSession(): the process "crashed"
    const second = make();
    second.startSession();
    const sum = second.summary();
    expect(sum.previousSessionUnclean).toMatchObject({ appVersion: '0.5.0' });
    expect(sum.crashReports.map((c) => c.kind)).toContain('unclean-exit');
    second.endSession();
    const third = make();
    expect(third.summary().previousSessionUnclean).toBeNull();
    first.endSession();
  });

  it('keeps working when the folder cannot be written', () => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, 'x');
    const log = new FileLog({ dir: join(file, 'logs'), appVersion: '0.5.0', now: () => now });
    log.warn('x', 'still works');
    expect(log.summary().counts.warn).toBe(1);
    expect(log.crash('uncaught-exception', { error: new Error('x') })).toBeNull();
  });

  it('turns an uncaught exception into a crash report', () => {
    const log = make();
    let seen: string | null = null;
    const remove = installCrashHandlers(log, { onUncaught: (_e, name) => (seen = name) });
    try {
      const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
      emit('uncaughtException', new Error('handler test'), 'uncaughtException');
      emit('unhandledRejection', new Error('nobody awaited me'), Promise.resolve());
    } finally {
      remove();
    }
    expect(seen).toMatch(/uncaught-exception/);
    expect(existsSync(join(dir, seen!))).toBe(true);
    expect(readFileSync(join(dir, 'studio.log'), 'utf8')).toContain('unhandled promise rejection');
  });
});
