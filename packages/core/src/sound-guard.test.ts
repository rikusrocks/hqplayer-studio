import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppleMusicState, StudioEvent } from '@hqps/contracts';
import { MockHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, seedDemoLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioLog } from './logging/studio-log';
import { createStudioServer, type StudioServer } from './server';
import { SOUND_GUARD_HELD_SETTING, SoundGuard } from './services/sound-guard';
import {
  isSoundOutputId,
  parseSound,
  windowsSound,
  type SoundDefaults,
  type SoundOutput,
  type SoundOutputs,
  type SoundRole,
  type WindowsSound,
} from './services/windows-sound';

const id = (n: number): string => `{0.0.0.00000000}.{00000000-0000-4000-8000-00000000000${n}}`;
const DAC = id(1);
const CABLE = id(2);
const SPEAKERS = id(3);
const HEADSET = id(4);

/** A scriptable stand-in for Windows' sound outputs. */
class FakeSound implements WindowsSound {
  readonly supported = true;
  readonly simulated = false;
  outputs: SoundOutput[] = [
    { id: DAC, name: 'Digital Output (AudioByte)' },
    { id: CABLE, name: 'CABLE Input (VB-Audio Virtual Cable)' },
    { id: SPEAKERS, name: 'Speakers (Realtek Audio)' },
    { id: HEADSET, name: 'Headset (USB)' },
  ];
  defaults: SoundDefaults = { console: DAC, multimedia: DAC, communications: DAC };
  failSet = false;
  /** Windows answers OK but changes nothing. */
  ignoreSet = false;
  calls: string[] = [];

  async read(): Promise<SoundOutputs> {
    return { outputs: this.outputs.map((o) => ({ ...o })), defaults: { ...this.defaults } };
  }
  async setDefault(target: string, roles: readonly SoundRole[]): Promise<SoundOutputs> {
    this.calls.push(
      `${target === SPEAKERS ? 'speakers' : target === DAC ? 'dac' : target}:${roles.join('+')}`,
    );
    if (this.failSet) throw new Error('Access is denied.');
    if (!this.ignoreSet) for (const role of roles) this.defaults[role] = target;
    return this.read();
  }
}

function memorySettings(): { settings: LibraryContext['settings']; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const settings = {
    get: <T>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key: string, value: unknown) => void store.set(key, value),
  } as unknown as LibraryContext['settings'];
  return { settings, store };
}

const quietLog = { info: () => undefined, warn: () => undefined } as unknown as StudioLog;

function guardWith(sound: FakeSound, kept = memorySettings()) {
  let changes = 0;
  const guard = new SoundGuard(sound, kept.settings, quietLog, () => {
    changes += 1;
  });
  guard.init();
  return { guard, kept, changes: () => changes };
}

describe('Windows sound outputs', () => {
  it('reads the PowerShell answer, also when there is a single output', () => {
    const one = parseSound(
      JSON.stringify({
        outputs: { id: SPEAKERS, name: 'Speakers (Realtek Audio)' },
        console: SPEAKERS,
        multimedia: SPEAKERS,
        communications: '',
      }),
    );
    expect(one.outputs).toEqual([{ id: SPEAKERS, name: 'Speakers (Realtek Audio)' }]);
    expect(one.defaults).toEqual({ console: SPEAKERS, multimedia: SPEAKERS, communications: null });

    const noisy = parseSound(
      `WARNING: something\n${JSON.stringify({
        outputs: [
          { id: DAC, name: '' },
          { id: "x'; Remove-Item", name: 'bad' },
        ],
        console: DAC,
      })}`,
    );
    // an unnamed output is shown by its id; anything that is not an endpoint id is dropped
    expect(noisy.outputs).toEqual([{ id: DAC, name: DAC }]);
    expect(noisy.defaults.multimedia).toBeNull();
    expect(() => parseSound('')).toThrow();
  });

  it('only lets endpoint ids near a script, and does nothing off Windows', async () => {
    expect(isSoundOutputId(DAC)).toBe(true);
    expect(isSoundOutputId("{0.0.0.00000000}.{x}'; calc")).toBe(false);
    expect(isSoundOutputId('Speakers')).toBe(false);
    const mac = windowsSound('darwin');
    expect(mac.supported).toBe(false);
    expect((await mac.read()).outputs).toEqual([]);
    await expect(mac.setDefault(DAC, ['console'])).rejects.toThrow();
  });
});

describe('Sound guard', () => {
  it('switches only to the output the user chose, and puts the old one back', async () => {
    const sound = new FakeSound();
    const { guard, kept } = guardWith(sound);
    await expect(guard.protect()).rejects.toThrow(/Choose/);
    expect(sound.calls).toEqual([]);

    await guard.update({ outputId: SPEAKERS });
    await guard.protect();
    expect(sound.defaults).toEqual({
      console: SPEAKERS,
      multimedia: SPEAKERS,
      communications: SPEAKERS,
    });
    const state = guard.get();
    expect(state.held?.previous).toEqual({ console: DAC, multimedia: DAC, communications: DAC });
    expect(state.outputs?.find((o) => o.id === CABLE)?.cable).toBe(true);
    expect(state.outputs?.find((o) => o.id === SPEAKERS)?.cable).toBe(false);
    expect(kept.store.get(SOUND_GUARD_HELD_SETTING)).toMatchObject({ previous: { console: DAC } });

    // a second switch keeps the first record: "before" stays the DAC, not the speakers
    await guard.protect();
    expect(guard.get().held?.previous.console).toBe(DAC);
    expect(sound.calls).toHaveLength(1);

    await guard.restore();
    expect(sound.defaults).toEqual({ console: DAC, multimedia: DAC, communications: DAC });
    expect(guard.get().held).toBeNull();
    expect(kept.store.get(SOUND_GUARD_HELD_SETTING)).toBeNull();
  });

  it('changes nothing when the chosen output is already the default', async () => {
    const sound = new FakeSound();
    sound.defaults = { console: SPEAKERS, multimedia: SPEAKERS, communications: SPEAKERS };
    const { guard } = guardWith(sound);
    await guard.update({ outputId: SPEAKERS });
    await guard.protect();
    expect(sound.calls).toEqual([]);
    expect(guard.get().held).toBeNull();
    await guard.restore(); // nothing held: nothing to do
    expect(sound.calls).toEqual([]);
  });

  it('leaves alone what the user changed by hand in the meantime', async () => {
    const sound = new FakeSound();
    const { guard } = guardWith(sound);
    await guard.update({ outputId: SPEAKERS });
    await guard.protect();
    sound.defaults.communications = HEADSET; // the user picked a headset for calls
    sound.calls = [];
    await guard.restore();
    expect(sound.defaults).toEqual({ console: DAC, multimedia: DAC, communications: HEADSET });
    expect(sound.calls).toEqual(['dac:console+multimedia']);
  });

  it('does not go back to an output that has disappeared', async () => {
    const sound = new FakeSound();
    const { guard } = guardWith(sound);
    await guard.update({ outputId: SPEAKERS });
    await guard.protect();
    sound.outputs = sound.outputs.filter((o) => o.id !== DAC); // DAC switched off
    sound.calls = [];
    await guard.restore();
    expect(sound.calls).toEqual([]);
    expect(sound.defaults.console).toBe(SPEAKERS);
    expect(guard.get().held).toBeNull();
  });

  it('acts by itself only in automatic mode', async () => {
    const sound = new FakeSound();
    const { guard } = guardWith(sound);
    await guard.update({ outputId: SPEAKERS });
    expect(await guard.liveStarted()).toBe(true);
    expect(sound.calls).toEqual([]);

    await guard.update({ auto: true });
    expect(await guard.liveStarted()).toBe(true);
    expect(sound.defaults.console).toBe(SPEAKERS);
    expect(await guard.liveEnded()).toBe(true);
    expect(sound.defaults.console).toBe(DAC);
  });

  it('keeps a failure as text, never throws from the automatic path, and can retry', async () => {
    const sound = new FakeSound();
    const { guard } = guardWith(sound);
    await guard.update({ outputId: SPEAKERS, auto: true });
    sound.failSet = true;
    expect(await guard.liveStarted()).toBe(false);
    expect(guard.get().error).toMatch(/Access is denied/);
    await expect(guard.protect()).rejects.toThrow(/Access is denied/);

    // Windows says OK but nothing changed: that is a failure too
    sound.failSet = false;
    sound.ignoreSet = true;
    await expect(guard.protect()).rejects.toThrow(/did not switch/);

    sound.ignoreSet = false;
    await guard.protect();
    expect(guard.get().error).toBeNull();
    expect(sound.defaults.console).toBe(SPEAKERS);

    // a chosen output that is gone is refused before anything is touched
    sound.outputs = sound.outputs.filter((o) => o.id !== SPEAKERS);
    await expect(guard.protect()).rejects.toThrow(/not available/);
    await expect(guard.update({ outputId: 'Speakers' })).rejects.toThrow();
  });

  it('remembers across a restart what it still has to put back', async () => {
    const sound = new FakeSound();
    const first = guardWith(sound);
    await first.guard.update({ outputId: SPEAKERS, auto: true });
    await first.guard.liveStarted();

    const second = guardWith(sound, first.kept); // Studio restarted
    expect(second.guard.get()).toMatchObject({ auto: true, outputId: SPEAKERS });
    expect(second.guard.get().held?.previous.console).toBe(DAC);
    await second.guard.liveEnded();
    expect(sound.defaults.console).toBe(DAC);
  });
});

// --- through the server -------------------------------------------------------------------------

let dir: string;
let ctx: LibraryContext;
let server: StudioServer;
let sound: FakeSound;
let events: StudioEvent[];
let booted = false;

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1:47321' };

async function api(url: string, payload?: unknown) {
  const res = await server.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: JSON_HEADERS,
    payload: JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  return { status: res.statusCode, body: res.json() as AppleMusicState };
}

async function boot() {
  booted = true;
  dir = mkdtempSync(join(tmpdir(), 'hqps-guard-'));
  ctx = openLibrary(dir);
  seedDemoLibrary(ctx.library, ctx.playlists, ctx.artwork);
  sound = new FakeSound();
  server = await createStudioServer({
    adapter: new MockHQPlayerAdapter({ latencyMs: 2, tickMs: 40 }),
    ctx,
    appVersion: 'test',
    port: 0,
    demoMode: true,
    engine: { commandTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 50 },
    queue: { settleMs: 0 },
    appleMusic: { sound },
  });
  events = [];
  server.hub.subscribe((e) => events.push(e));
  await server.engine.start();
}

afterEach(async () => {
  if (!booted) return;
  booted = false;
  await server.close();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Sound guard on the Apple Music page', () => {
  it('reads Windows, switches by button and puts Windows back', { timeout: 30_000 }, async () => {
    await boot();
    const read = await api('/apple-music/guard/refresh');
    expect(read.status).toBe(200);
    expect(read.body.guard).toMatchObject({ supported: true, auto: false, outputId: null });
    expect(read.body.guard.defaults?.console).toBe(DAC);
    expect(read.body.guard.outputs).toHaveLength(4);

    expect((await api('/apple-music/guard/protect')).status).toBe(409);
    expect((await api('/apple-music/guard', {})).status).toBe(400);
    expect((await api('/apple-music/guard', { outputId: 'nonsense' })).status).toBe(409);

    await api('/apple-music/guard', { outputId: SPEAKERS });
    const switched = await api('/apple-music/guard/protect');
    expect(switched.body.guard.defaults?.console).toBe(SPEAKERS);
    expect(switched.body.guard.held?.previous.console).toBe(DAC);
    // the page hears about it without asking
    expect(
      events.some(
        (e) => e.type === 'applemusic.changed' && e.state.guard.defaults?.console === SPEAKERS,
      ),
    ).toBe(true);

    const back = await api('/apple-music/guard/restore');
    expect(back.body.guard.defaults?.console).toBe(DAC);
    expect(back.body.guard.held).toBeNull();
  });

  it(
    'in automatic mode switches when Apple Music starts and puts Windows back when it stops',
    { timeout: 30_000 },
    async () => {
      await boot();
      await api('/apple-music/settings', { enabled: true });
      await api('/apple-music/guard', { outputId: SPEAKERS, auto: true });
      expect(sound.defaults.console).toBe(DAC); // nothing happens until Start

      const started = await api('/apple-music/start');
      expect(started.body.phase).toBe('active');
      expect(sound.defaults).toEqual({
        console: SPEAKERS,
        multimedia: SPEAKERS,
        communications: SPEAKERS,
      });
      expect(started.body.guard.held?.previous.console).toBe(DAC);

      const stopped = await api('/apple-music/stop');
      expect(stopped.body.phase).toBe('idle');
      expect(sound.defaults.console).toBe(DAC);
      expect(stopped.body.guard.held).toBeNull();
    },
  );

  it(
    'still starts the music when Windows refuses the switch, and says so',
    { timeout: 30_000 },
    async () => {
      await boot();
      await api('/apple-music/settings', { enabled: true });
      await api('/apple-music/guard', { outputId: SPEAKERS, auto: true });
      sound.failSet = true;
      const started = await api('/apple-music/start');
      expect(started.body.phase).toBe('active');
      expect(started.body.guard.error).toMatch(/Access is denied/);
      expect(events.some((e) => e.type === 'notice' && e.code === 'applemusic_guard_failed')).toBe(
        true,
      );
    },
  );
});
