import { randomUUID } from 'node:crypto';
import {
  DspPresetSchema,
  MAX_DSP_PRESETS,
  type DspChange,
  type DspPreset,
  type DspPresetValues,
  type DspState,
} from '@hqps/contracts';
import { CapabilityUnavailableError } from '@hqps/hqplayer-adapter';
import type { SettingsRepository } from '@hqps/library';
import { HttpError } from '../http/errors';
import type { StudioLog } from '../logging/studio-log';
import type { EngineService } from './engine-service';

export const DSP_PRESETS_SETTING = 'dsp.presets';

/**
 * DSP presets (Settings → DSP): save HQPlayer's current mode / filters / modulator / rate /
 * invert / adaptive volume under a name and apply it later through the same verified `setDsp`
 * path as the individual controls (D-036): every index is checked against lists read from
 * HQPlayer on the same connection, and every change is read back.
 *
 * Applying: the mode first (the other lists depend on it), then everything else in one change,
 * resolved by name in the new mode's lists. If an item of the preset no longer exists, nothing
 * else is sent and the mode is switched back, so a refused preset leaves HQPlayer as it was.
 */
export class DspPresetService {
  constructor(
    private readonly engine: EngineService,
    private readonly settings: SettingsRepository,
    private readonly log?: StudioLog,
  ) {}

  list(): DspPreset[] {
    const raw = this.settings.get<unknown[]>(DSP_PRESETS_SETTING, []);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p) => {
      const parsed = DspPresetSchema.safeParse(p);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Save what HQPlayer has selected now. A preset with the same name is replaced. */
  async saveCurrent(name: string): Promise<DspPreset> {
    this.engine.require('dsp.read');
    const state = await this.read();
    const values = valuesOf(state);
    const presets = this.list();
    const existing = presets.find((p) => p.name === name);
    const preset: DspPreset = {
      id: existing?.id ?? `dsp_${randomUUID()}`,
      name,
      createdAt: Date.now(),
      values,
    };
    const next = existing
      ? presets.map((p) => (p.id === existing.id ? preset : p))
      : [...presets, preset];
    if (next.length > MAX_DSP_PRESETS) {
      throw new HttpError(409, 'conflict', `At most ${MAX_DSP_PRESETS} DSP presets can be saved`);
    }
    this.settings.set(DSP_PRESETS_SETTING, next);
    return preset;
  }

  remove(id: string): DspPreset[] {
    const next = this.list().filter((p) => p.id !== id);
    this.settings.set(DSP_PRESETS_SETTING, next);
    return next;
  }

  async apply(id: string): Promise<DspState> {
    const preset = this.list().find((p) => p.id === id);
    if (!preset) throw new HttpError(404, 'not_found', 'DSP preset not found');
    this.engine.require('dsp.write');
    const v = preset.values;
    let state = await this.read();
    const originalMode = state.selected?.mode ?? null;

    // 1. the mode (its lists decide what the rest means)
    if (v.mode !== null) {
      const mode = state.modes.find((m) => m.name === v.mode);
      if (!mode) throw missing([`mode "${v.mode}"`]);
      if (state.selected?.mode !== mode.index) state = await this.set({ mode: mode.index });
    }

    // 2. everything else, by name in the (new) mode's lists
    const change: DspChange = {};
    const absent: string[] = [];
    const sel = state.selected;
    const byName = (list: DspState['filters'], name: string | null, label: string) => {
      if (name === null) return undefined;
      const item = list.find((x) => x.name === name);
      if (!item) absent.push(`${label} "${name}"`);
      return item?.index;
    };
    const f1 = byName(state.filters, v.filter1x, '1x filter');
    const fn = byName(state.filters, v.filterNx, 'Nx filter');
    const sh = byName(state.shapers, v.shaper, 'modulator / noise shaping');
    let rate: number | undefined;
    if (v.rate !== null) {
      rate = state.rates.find((r) => r.rate === v.rate)?.index;
      if (rate === undefined) absent.push(`output rate ${v.rate} Hz`);
    }
    if (absent.length > 0) {
      if (originalMode !== null && state.selected?.mode !== originalMode) {
        await this.set({ mode: originalMode }).catch(() => undefined);
      }
      throw missing(absent);
    }
    if (f1 !== undefined && f1 !== sel?.filter1x) change.filter1x = f1;
    if (fn !== undefined && fn !== sel?.filterNx) change.filterNx = fn;
    if (sh !== undefined && sh !== sel?.shaper) change.shaper = sh;
    if (rate !== undefined && rate !== sel?.rate) change.rate = rate;
    if (v.invert !== null && v.invert !== sel?.invert) change.invert = v.invert;
    if (v.adaptiveVolume !== null && v.adaptiveVolume !== sel?.adaptiveVolume) {
      change.adaptiveVolume = v.adaptiveVolume;
    }
    if (Object.keys(change).length > 0) state = await this.set(change);
    this.log?.info('dsp', 'preset applied', { changes: Object.keys(change).length });
    return state;
  }

  private read(): Promise<DspState> {
    return this.engine.run('getDspState', (a) => {
      if (!a.getDspState)
        throw new CapabilityUnavailableError('dsp.read', 'adapter cannot read DSP state');
      return a.getDspState();
    });
  }

  private set(change: DspChange): Promise<DspState> {
    return this.engine.run('setDsp', (a) => {
      if (!a.setDsp) throw new CapabilityUnavailableError('dsp.write', 'adapter cannot change DSP');
      return a.setDsp(change);
    });
  }
}

function missing(items: string[]): HttpError {
  return new HttpError(
    409,
    'conflict',
    `HQPlayer no longer offers ${items.join(', ')}; the preset was not applied`,
    { missing: items },
  );
}

/** Names of what is selected now (null where HQPlayer did not report a selection). */
export function valuesOf(state: DspState): DspPresetValues {
  const s = state.selected;
  const name = (list: DspState['filters'], index: number | null | undefined) =>
    index === null || index === undefined
      ? null
      : (list.find((x) => x.index === index)?.name ?? null);
  return {
    mode: name(state.modes, s?.mode),
    filter1x: name(state.filters, s?.filter1x),
    filterNx: name(state.filters, s?.filterNx),
    shaper: name(state.shapers, s?.shaper),
    rate:
      s?.rate === null || s?.rate === undefined
        ? null
        : (state.rates.find((r) => r.index === s.rate)?.rate ?? null),
    invert: s?.invert ?? null,
    adaptiveVolume: s?.adaptiveVolume ?? null,
  };
}
