import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DspState, EngineSettings } from '@hqps/contracts';
import { LiveHQPlayerAdapter } from '@hqps/hqplayer-adapter';
import { openLibrary, type LibraryContext } from '@hqps/library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startFakeDspEngine,
  type FakeDspEngine,
} from '../../hqplayer-adapter/src/testing/fake-dsp-engine';
import { createStudioServer, type StudioServer } from './server';

let dir: string;
let ctx: LibraryContext;
let engine: FakeDspEngine;
let server: StudioServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hqps-dsp-'));
  ctx = openLibrary(join(dir, 'data'));
  ctx.settings.set('engine.allowControl', true); // as bootstrap would have it
  engine = await startFakeDspEngine({ setTakes: 'index', listsDependOnMode: true });
  server = await createStudioServer({
    adapter: new LiveHQPlayerAdapter({ port: engine.port, policy: { controlEnabled: true } }),
    ctx,
    appVersion: 'test',
    port: 0,
  });
  await server.engine.start();
});

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

describe('POST /engine/dsp', () => {
  it('is refused until the DSP switch is on, then changes HQPlayer and returns the new state', async () => {
    expect((await call<EngineSettings>('GET', '/settings/engine')).body.allowDsp).toBe(false);
    const refused = await call('POST', '/engine/dsp', { shaper: 2 });
    expect(refused.status).toBe(409);
    expect(engine.received.some((r) => r.name === 'SetShaping')).toBe(false);

    const on = await call<EngineSettings>('POST', '/settings/engine', { allowDsp: true });
    expect(on.body).toMatchObject({ allowControl: true, allowDsp: true });
    expect(ctx.settings.get('engine.allowDsp', false)).toBe(true);

    const res = await call<DspState>('POST', '/engine/dsp', { shaper: 2 });
    expect(res.status).toBe(200);
    expect(res.body.selected?.shaper).toBe(2);
    expect(engine.dsp().shaper).toBe(2);

    const bad = await call<{ error: { message: string } }>('POST', '/engine/dsp', { rate: 99 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.error.message).toMatch(/not offered/);

    expect((await call('POST', '/engine/dsp', {})).status).toBe(400); // nothing to change
  });
});

describe('DSP presets', () => {
  type Presets = { presets: { id: string; name: string; values: Record<string, unknown> }[] };

  it('saves the current selections by name and applies them back (mode first)', async () => {
    await call('POST', '/settings/engine', { allowDsp: true });
    // SDM with a chosen modulator and rate
    await call('POST', '/engine/dsp', { shaper: 5, rate: 8 });
    const saved = await call<Presets>('POST', '/engine/dsp/presets', { name: 'DSD512 evening' });
    expect(saved.status).toBe(201);
    expect(saved.body.presets).toHaveLength(1);
    expect(saved.body.presets[0]!.values).toMatchObject({
      mode: 'SDM (DSD)',
      shaper: 'ASDM7EC-super',
      rate: 24_576_000,
    });
    const id = saved.body.presets[0]!.id;

    // switch to PCM with other selections, then apply the preset
    await call('POST', '/engine/dsp', { mode: 1 });
    await call('POST', '/engine/dsp', { shaper: 2 });
    expect(engine.dsp().mode).toBe(1);
    const applied = await call<DspState>('POST', `/engine/dsp/presets/${id}/apply`);
    expect(applied.status).toBe(200);
    expect(engine.dsp()).toMatchObject({ mode: 2, shaper: 5, rate: 8 });
    expect(applied.body.selected).toMatchObject({ mode: 2, shaper: 5, rate: 8 });

    // same name replaces; listing and deleting
    const again = await call<Presets>('POST', '/engine/dsp/presets', { name: 'DSD512 evening' });
    expect(again.body.presets).toHaveLength(1);
    const list = await call<Presets>('GET', '/engine/dsp/presets');
    expect(list.body.presets.map((p) => p.name)).toEqual(['DSD512 evening']);
    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/engine/dsp/presets/${id}`,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      payload: '{}',
      remoteAddress: '127.0.0.1',
    });
    expect(res.json()).toEqual({ presets: [] });
  });

  it('refuses a preset whose items HQPlayer no longer offers and leaves HQPlayer as it was', async () => {
    await call('POST', '/settings/engine', { allowDsp: true });
    await call('POST', '/engine/dsp', { mode: 1 }); // PCM
    const before = engine.dsp();
    ctx.settings.set('dsp.presets', [
      {
        id: 'dsp_gone',
        name: 'Old filter',
        createdAt: 1,
        values: {
          mode: 'SDM (DSD)',
          filter1x: 'poly-sinc-gauss-xla',
          filterNx: null,
          shaper: null,
          rate: null,
          invert: null,
          adaptiveVolume: null,
        },
      },
    ]);
    const res = await call<{ error: { message: string } }>(
      'POST',
      '/engine/dsp/presets/dsp_gone/apply',
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('poly-sinc-gauss-xla');
    expect(engine.dsp()).toMatchObject({ mode: before.mode, shaper: before.shaper });
    expect((await call('POST', '/engine/dsp/presets/nope/apply')).status).toBe(404);
  });

  it('needs the DSP switch to apply, and only reads to save', async () => {
    const saved = await call<Presets>('POST', '/engine/dsp/presets', { name: 'Read only' });
    expect(saved.status).toBe(201);
    const sent = engine.received.length;
    const refused = await call('POST', `/engine/dsp/presets/${saved.body.presets[0]!.id}/apply`);
    expect(refused.status).toBe(409);
    expect(engine.received.slice(sent).some((r) => r.name.startsWith('Set'))).toBe(false);
    expect((await call('POST', '/engine/dsp/presets', { name: ' ' })).status).toBe(400);
  });
});
