import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EqCheckStart, EqConfig, EqStatus } from '@hqps/contracts';
import { LiveHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeDspEngine,
  type FakeDspEngine,
  type FakeDspOptions,
} from '../../hqplayer-adapter/src/testing/fake-dsp-engine';
import { createStudioServer, type StudioServer } from './server';

let dir: string;
let ctx: LibraryContext;
let engine: FakeDspEngine;
let server: StudioServer;

async function setup(opts: FakeDspOptions = {}, allowDsp = true) {
  dir = mkdtempSync(join(tmpdir(), 'hqps-eq-'));
  ctx = openLibrary(join(dir, 'data'));
  ctx.settings.set('engine.allowControl', true);
  ctx.settings.set('engine.allowDsp', allowDsp);
  engine = await startFakeDspEngine({ setTakes: 'index', listsDependOnMode: true, ...opts });
  server = await createStudioServer({
    adapter: new LiveHQPlayerAdapter({
      port: engine.port,
      policy: { controlEnabled: true, dspEnabled: allowDsp },
    }),
    ctx,
    appVersion: 'test',
    port: 0,
    eqDir: join(dir, 'eq'),
  });
  await server.engine.start();
}

afterEach(async () => {
  await server.close();
  await engine.close();
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers:
      method === 'GET'
        ? { host: '127.0.0.1' }
        : { host: '127.0.0.1', 'content-type': 'application/json' },
    payload: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
    remoteAddress: '127.0.0.1',
  });
  return { status: res.statusCode, body: res.json() as T };
}

const BOOST: EqConfig = {
  preampDb: 0,
  bands: [{ type: 'lowShelf', enabled: true, freq: 100, gainDb: 6, q: 0.7 }],
};
const convolutionSets = () =>
  engine.received.filter((r) => r.name === 'SetConvolution').map((r) => r.attributes.value);

describe('Studio EQ', () => {
  it('saves the curve and writes the filter file with headroom for the boost', async () => {
    await setup();
    const before = await call<EqStatus>('GET', '/eq');
    expect(before.body).toMatchObject({ file: null, convolution: false, canSwitch: true });
    expect(before.body.filePath).toBe(join(dir, 'eq', 'studio-eq.wav'));

    const res = await call<EqStatus>('POST', '/eq', { config: BOOST });
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual(BOOST);
    expect(res.body.file!.preampDb).toBeLessThanOrEqual(-6);
    expect(res.body.file!.peakDb).toBeLessThanOrEqual(0);
    const wav = readFileSync(res.body.filePath!);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    // convolution was off: nothing is sent to HQPlayer
    expect(convolutionSets()).toEqual([]);
    expect(existsSync(`${res.body.filePath}.tmp`)).toBe(false);
  });

  it('switches convolution off and on around a save while it is on', async () => {
    await setup();
    const on = await call<EqStatus>('POST', '/eq/convolution', { enabled: true });
    expect(on.body.convolution).toBe(true);
    expect(on.body.file).not.toBeNull(); // a file is there before HQPlayer looks for it
    await call<EqStatus>('POST', '/eq', { config: BOOST });
    expect(convolutionSets()).toEqual(['1', '0', '1']);
    expect(engine.dsp().convolution).toBe(1);
  });

  it('refuses the convolution switch without the DSP permission', async () => {
    await setup({}, false);
    const res = await call('POST', '/eq/convolution', { enabled: true });
    expect(res.status).toBe(409);
    expect(convolutionSets()).toEqual([]);
    // the curve can still be saved (it only writes Studio's own file)
    expect((await call('POST', '/eq', { config: BOOST })).status).toBe(200);
  });

  it('explains when HQPlayer has no convolution filter set up', async () => {
    await setup({ convolutionConfigured: false });
    const res = await call<{ error: { message: string } }>('POST', '/eq/convolution', {
      enabled: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no convolution filter is set up/);
  });

  it('listening check: test filter in, answer recorded, the user’s curve back', async () => {
    await setup();
    await call('POST', '/eq', { config: BOOST });
    const userFile = readFileSync(join(dir, 'eq', 'studio-eq.wav'));

    const start = await call<EqCheckStart>('POST', '/eq/check');
    expect(start.body.started).toBe(true);
    expect(start.body.status.checkRunning).toBe(true);
    expect(engine.dsp().convolution).toBe(1);
    expect(readFileSync(join(dir, 'eq', 'studio-eq.wav')).equals(userFile)).toBe(false);
    // saving is blocked while the check runs
    expect((await call('POST', '/eq', { config: BOOST })).status).toBe(409);

    const done = await call<EqStatus>('POST', '/eq/check/answer', { heard: true });
    expect(done.body.reloadCheck?.result).toBe('reloads');
    expect(done.body.checkRunning).toBe(false);
    expect(readFileSync(join(dir, 'eq', 'studio-eq.wav')).equals(userFile)).toBe(true);
    // convolution was off before the check, so it is off again
    expect(engine.dsp().convolution).toBe(0);
  });

  it('listening check: reports “not configured” without leaving the test filter', async () => {
    await setup({ convolutionConfigured: false });
    await call('POST', '/eq', { config: BOOST });
    const userFile = readFileSync(join(dir, 'eq', 'studio-eq.wav'));
    const start = await call<EqCheckStart>('POST', '/eq/check');
    expect(start.body.started).toBe(false);
    expect(start.body.status.reloadCheck?.result).toBe('not-configured');
    expect(readFileSync(join(dir, 'eq', 'studio-eq.wav')).equals(userFile)).toBe(true);
  });

  it('saves and deletes named curves', async () => {
    await setup();
    type Profiles = { profiles: { id: string; name: string }[] };
    const a = await call<Profiles>('POST', '/eq/profiles', { name: 'Headphones', config: BOOST });
    expect(a.status).toBe(201);
    const again = await call<Profiles>('POST', '/eq/profiles', {
      name: 'Headphones',
      config: BOOST,
    });
    expect(again.body.profiles).toHaveLength(1);
    const id = again.body.profiles[0]!.id;
    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/eq/profiles/${id}`,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      payload: '{}',
      remoteAddress: '127.0.0.1',
    });
    expect((res.json() as Profiles).profiles).toEqual([]);
  });
});
