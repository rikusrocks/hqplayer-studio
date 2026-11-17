import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityUnavailableError, EngineCommandError } from '../errors';
import {
  startFakeDspEngine,
  type FakeDspEngine,
  type FakeDspOptions,
} from '../testing/fake-dsp-engine';
import { LiveHQPlayerAdapter } from './LiveHQPlayerAdapter';

// The stand-in behaves the way the user's DSP gate report showed (engine 6.1.0, 2026-11-17):
// Set* take list indexes, the shaper/rate lists depend on the mode.
const AS_OBSERVED: FakeDspOptions = { setTakes: 'index', listsDependOnMode: true };

let engine: FakeDspEngine | null = null;
let adapter: LiveHQPlayerAdapter | null = null;
afterEach(async () => {
  await adapter?.disconnect();
  await engine?.close();
  adapter = null;
  engine = null;
});

async function connect(
  policy: { controlEnabled?: boolean; dspEnabled?: boolean },
  opts = AS_OBSERVED,
) {
  engine = await startFakeDspEngine(opts);
  adapter = new LiveHQPlayerAdapter({ port: engine.port, policy });
  await adapter.connect();
  return { engine, adapter };
}

const sentSets = (e: FakeDspEngine) =>
  e.received.map((r) => r.name).filter((n) => n.startsWith('Set'));

describe('DSP control (live adapter)', () => {
  it('needs its own switch on top of the control switch', async () => {
    const { engine, adapter } = await connect({ controlEnabled: true });
    const caps = await adapter.getCapabilities();
    expect(caps.items['dsp.write']).toMatchObject({ usable: false, note: 'dsp-disabled' });
    await expect(adapter.setDsp({ shaper: 1 })).rejects.toBeInstanceOf(CapabilityUnavailableError);
    expect(sentSets(engine)).toEqual([]);
    expect((await adapter.getDspState()).writable).toBe(false);
  });

  it('reads the selections and changes modulator, rate and toggles with read-back', async () => {
    const { engine, adapter } = await connect({ controlEnabled: true, dspEnabled: true });
    const before = await adapter.getDspState();
    expect(before.writable).toBe(true);
    expect(before.selected).toMatchObject({ mode: 2, shaper: 6, rate: 0, invert: false });

    const after = await adapter.setDsp({ shaper: 3, rate: 7, invert: true, adaptiveVolume: true });
    expect(engine.dsp()).toMatchObject({ shaper: 3, rate: 7, invert: 1, adaptive: 1 });
    expect(after.selected).toMatchObject({
      shaper: 3,
      rate: 7,
      invert: true,
      adaptiveVolume: true,
    });
    expect(engine.received.find((r) => r.name === 'SetShaping')?.attributes).toEqual({
      value: '3',
    });
  });

  it('keeps the 1x and Nx filters separate (value = Nx, value1x = 1x)', async () => {
    const { engine, adapter } = await connect({ controlEnabled: true, dspEnabled: true });
    const { filter1x, filterNx } = engine.dsp();
    await adapter.setDsp({ filter1x: 5 });
    expect(engine.dsp()).toMatchObject({ filter1x: 5, filterNx });
    expect(engine.received.find((r) => r.name === 'SetFilter')?.attributes).toEqual({
      value: String(filterNx),
      value1x: '5',
    });
    await adapter.setDsp({ filterNx: 2 });
    expect(engine.dsp()).toMatchObject({ filter1x: 5, filterNx: 2 });
    expect(filter1x).not.toBe(5);
  });

  it('switches the mode first and offers the lists of the new mode', async () => {
    const { engine, adapter } = await connect({ controlEnabled: true, dspEnabled: true });
    const pcm = await adapter.setDsp({ mode: 1 });
    expect(engine.dsp().mode).toBe(1);
    expect(pcm.shapers.map((s) => s.name)).toEqual(['none', 'TPDF', 'NS9', 'LNS15']);
    expect(pcm.rates.map((r) => r.rate)).toContain(768000);
    // an index valid only in the SDM list is refused in PCM mode — nothing is sent
    const sets = sentSets(engine).length;
    await expect(adapter.setDsp({ shaper: 6 })).rejects.toBeInstanceOf(EngineCommandError);
    expect(sentSets(engine).length).toBe(sets);
    // back to SDM: HQPlayer remembered the SDM selections
    const sdm = await adapter.setDsp({ mode: 2 });
    expect(sdm.selected).toMatchObject({ mode: 2, shaper: 6 });
  });

  it('reports a change HQPlayer accepted but did not apply', async () => {
    const { adapter } = await connect(
      { controlEnabled: true, dspEnabled: true },
      { ...AS_OBSERVED, ignoreAfter: { cmd: 'SetShaping', count: 0 } },
    );
    await expect(adapter.setDsp({ shaper: 2 })).rejects.toThrow(/did not apply/);
  });
});
