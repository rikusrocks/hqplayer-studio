import type { DspChange, DspState, EngineSettings } from '@hqps/contracts';
import { Icon, Spinner, useAsync, useCapabilityGate, useI18n, useStudio } from '@hqps/ui';
import { useEffect, useState } from 'react';
import { BlockHead } from './SettingsSections';

/**
 * Change HQPlayer's DSP selections from Studio (DSP gate verified, 2026-11-17): mode, 1x / Nx
 * filter, modulator (SDM) or noise shaping (PCM), output rate, invert and adaptive volume. Its
 * own switch on top of “允许 Studio 控制 HQPlayer”; everything is read back from HQPlayer.
 */
export function DspControls() {
  const { t } = useI18n();
  const { client, run, capabilities, status } = useStudio();
  const gate = useCapabilityGate();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const live = capabilities?.adapter === 'live';
  const readable = Boolean(capabilities?.items['dsp.read']?.usable);
  const writeReason = gate('dsp.write');

  useEffect(() => {
    let alive = true;
    void client.settings.engine().then(
      (s) => alive && setSettings(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, tick]);

  const dsp = useAsync<DspState | null>(
    () => (readable ? client.engine.dsp() : Promise.resolve(null)),
    // re-read when HQPlayer reports a different active mode/filter/modulator/rate
    [
      client,
      readable,
      tick,
      status.dsp?.mode,
      status.dsp?.filter,
      status.dsp?.shaper,
      status.dsp?.outputRate,
    ],
  );
  const [state, setState] = useState<DspState | null>(null);
  useEffect(() => setState(dsp.data ?? null), [dsp.data]);

  if (!live) return null;

  const toggleAllowed = async (on: boolean) => {
    setBusy('switch');
    const res = await run(() => client.settings.setDspAllowed(on));
    setBusy(null);
    if (res) setSettings(res);
    setTick((n) => n + 1);
  };

  const apply = async (key: string, change: DspChange) => {
    setBusy(key);
    const next = await run(() => client.engine.setDsp(change), { success: t('dsp.applied') });
    setBusy(null);
    if (next) setState(next);
    else setTick((n) => n + 1); // re-read what HQPlayer really has
  };

  const sel = state?.selected ?? null;
  const modeName = state?.modes.find((m) => m.index === sel?.mode)?.name ?? '';
  const isPcm = /pcm/i.test(modeName);
  const disabled = !!writeReason || !state?.writable;

  const select = (
    key: keyof DspChange,
    label: string,
    options: { index: number; label: string; title?: string }[],
    value: number | null | undefined,
  ) => (
    <label className="dsp-field" key={key}>
      <span>{label}</span>
      <span className="dsp-field__control">
        <select
          className="hq-input"
          value={value ?? ''}
          disabled={disabled || busy !== null || value === null || value === undefined}
          title={writeReason ?? undefined}
          onChange={(e) => void apply(key, { [key]: Number(e.target.value) })}
        >
          {(value === null || value === undefined) && <option value="">—</option>}
          {options.map((o) => (
            <option key={o.index} value={o.index} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
        {busy === key && <Spinner size={14} />}
      </span>
    </label>
  );

  const toggle = (key: 'invert' | 'adaptiveVolume', label: string, value: boolean | null) => (
    <label className={`dsp-toggle${disabled ? ' is-disabled' : ''}`} key={key}>
      <input
        type="checkbox"
        checked={value ?? false}
        disabled={disabled || busy !== null || value === null}
        onChange={(e) => void apply(key, { [key]: e.target.checked })}
      />
      <span>{label}</span>
      {busy === key && <Spinner size={14} />}
    </label>
  );

  return (
    <div className="settings-block">
      <BlockHead title={t('dsp.title')} layer="control" />
      <label
        className={`engine-option engine-control${settings?.allowControl ? '' : ' is-disabled'}`}
      >
        <input
          type="checkbox"
          role="switch"
          checked={Boolean(settings?.allowDsp)}
          disabled={!settings?.allowControl || busy !== null}
          onChange={(e) => void toggleAllowed(e.target.checked)}
        />
        <span>
          <strong>{t('dsp.allow')}</strong>
          <span className="hint">
            {settings?.allowControl ? t('dsp.allowHint') : t('dsp.needsControl')}
          </span>
        </span>
      </label>
      {settings?.allowDsp && status.transport === 'playing' && (
        <p className="hint dsp-note">
          <Icon name="info" size={14} /> {t('dsp.whilePlaying')}
        </p>
      )}
      {readable && !state && dsp.loading && <Spinner size={16} />}
      {state && sel && (
        <div className="dsp-grid">
          {select(
            'mode',
            t('settings.dspMode'),
            state.modes.map((m) => ({ index: m.index, label: modeLabel(m.name, t) })),
            sel.mode,
          )}
          {select(
            'filter1x',
            t('dsp.filter1x'),
            state.filters.map((f) => ({
              index: f.index,
              label: f.name,
              title: f.description ?? undefined,
            })),
            sel.filter1x,
          )}
          {select(
            'filterNx',
            t('dsp.filterNx'),
            state.filters.map((f) => ({
              index: f.index,
              label: f.name,
              title: f.description ?? undefined,
            })),
            sel.filterNx,
          )}
          {select(
            'shaper',
            isPcm ? t('dsp.shaperPcm') : t('dsp.shaperSdm'),
            state.shapers.map((s) => ({ index: s.index, label: s.name })),
            sel.shaper,
          )}
          {select(
            'rate',
            t('settings.dspRate'),
            state.rates.map((r) => ({ index: r.index, label: rateLabel(r.rate, t) })),
            sel.rate,
          )}
          <div className="dsp-toggles">
            {toggle('invert', t('dsp.invert'), sel.invert)}
            {toggle('adaptiveVolume', t('dsp.adaptiveVolume'), sel.adaptiveVolume)}
            <span className="hint hq-muted">
              {t('dsp.convolution', {
                state: sel.convolution ? t('common.on') : t('common.off'),
              })}
            </span>
          </div>
        </div>
      )}
      <p className="hint hq-muted">{t('dsp.notHere')}</p>
    </div>
  );
}

type T = ReturnType<typeof useI18n>['t'];

function modeLabel(name: string, t: T): string {
  return name === '[source]' ? t('dsp.mode.source') : name;
}

/** 0 → automatic; DSD rates as DSD64…DSD1024 (44.1k / 48k families); PCM in kHz. */
export function rateLabel(rate: number, t: T): string {
  if (!rate) return t('dsp.rate.auto');
  for (const base of [44_100, 48_000]) {
    const m = rate / base;
    if (Number.isInteger(m) && m >= 64 && (m & (m - 1)) === 0) {
      return `DSD${m}${base === 48_000 ? ' (48k)' : ''} · ${(rate / 1e6).toFixed(4).replace(/0+$/, '')} MHz`;
    }
  }
  return rate >= 1e6 ? `${(rate / 1e6).toFixed(4).replace(/0+$/, '')} MHz` : `${rate / 1000} kHz`;
}
