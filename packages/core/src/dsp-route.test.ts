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
