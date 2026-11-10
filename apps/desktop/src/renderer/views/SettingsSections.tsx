import {
  canUse,
  type CoverProviderId,
  type CoverSettings as CoverSettingsDto,
  type LyricsSettings as LyricsSettingsDto,
  type OnlineLyricsProviderId,
} from '@hqps/contracts';
import {
  EmptyState,
  ErrorBlock,
  FormatBadge,
  Icon,
  LoadingBlock,
  formatVolume,
  useAsync,
  useCapabilityGate,
  useDialogs,
  useI18n,
  useNowPlaying,
  useStudio,
  useToasts,
  type MessageKey,
} from '@hqps/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { getShell, type DesktopShellState, type HqpAppState } from '../shell';

/**
 * Who owns a setting (handoff §8.5):
 *  - `studio`: stored by Studio, changeable here;
 *  - `control`: a command Studio may send to HQPlayer (only Gate C-confirmed ones, only while
 *    “允许 Studio 控制 HQPlayer” is on);
 *  - `readonly`: read from HQPlayer, changeable only in HQPlayer;
 *  - `native`: Studio can neither read nor change it — HQPlayer's own settings only.
 */
export type SettingLayer = 'studio' | 'control' | 'readonly' | 'native';

const LAYER_ICON = {
  studio: 'settings',
  control: 'plug',
  readonly: 'info',
  native: 'external',
} as const;

export function LayerTag({ layer }: { layer: SettingLayer }) {
  const { t } = useI18n();
  return (
    <span
      className={`layer-tag layer-tag--${layer}`}
      title={t(`settings.layer.${layer}.hint` as MessageKey)}
    >
      <Icon name={LAYER_ICON[layer]} size={12} />
      {t(`settings.layer.${layer}` as MessageKey)}
    </span>
  );
}

export function SettingsLegend() {
  const { t } = useI18n();
  return (
    <div className="settings-legend" aria-label={t('settings.legend')}>
      {(['studio', 'control', 'readonly', 'native'] as const).map((l) => (
        <div key={l} className="settings-legend__item">
          <LayerTag layer={l} />
          <span>{t(`settings.layer.${l}.hint` as MessageKey)}</span>
        </div>
      ))}
    </div>
  );
}

export function BlockHead({
  title,
  layer,
  aside,
}: {
  title: string;
  layer: SettingLayer;
  aside?: ReactNode;
}) {
  return (
    <div className="settings-block__head">
      <h3 className="settings-block__title">
        {title}
        <LayerTag layer={layer} />
      </h3>
      {aside}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title: string;
  hint?: ReactNode;
}) {
  return (
    <label className={`engine-option engine-control${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <strong>{title}</strong>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

// ------------------------------------------------------------------------- desktop (General)

/** Mini Player, media keys and tray — Electron only. */
export function DesktopIntegration() {
  const { t } = useI18n();
  const shell = getShell();
  const toasts = useToasts();
  const [state, setState] = useState<DesktopShellState | null>(null);
  const [onTop, setOnTop] = useState<boolean | null>(null);

  useEffect(() => {
    if (!shell) return;
    let alive = true;
    void shell.desktop.get().then((s) => alive && setState(s));
    void shell.getAlwaysOnTop().then((v) => alive && setOnTop(v));
    return () => {
      alive = false;
    };
  }, [shell]);

  if (!shell) {
    return (
      <div className="settings-block">
        <BlockHead title={t('settings.desktop')} layer="studio" />
        <p className="hint">{t('settings.desktopBrowser')}</p>
      </div>
    );
  }
  const set = async (patch: Partial<DesktopShellState['prefs']>) => {
    try {
      const next = await shell.desktop.set(patch);
      if (next) setState(next);
    } catch (err) {
      toasts.push('error', (err as Error).message);
    }
  };
  const keys = state?.mediaKeys;
  return (
    <div className="settings-block">
      <BlockHead title={t('settings.desktop')} layer="studio" />
      <Switch
        checked={onTop ?? true}
        onChange={async (v) => setOnTop(await shell.setAlwaysOnTop(v))}
        title={t('settings.mini.onTop')}
        hint={t('settings.mini.onTopHint')}
      />
      {state && (
        <>
          <Switch
            checked={state.prefs.mediaKeys}
            disabled={!state.mediaKeys.supported}
            onChange={(v) => void set({ mediaKeys: v })}
            title={t('settings.mediaKeys')}
            hint={
              <>
                {state.mediaKeys.supported
                  ? t('settings.mediaKeysHint')
                  : t('settings.mediaKeys.unsupported')}
                {keys && keys.enabled && keys.registered.length > 0 && (
                  <span className="hq-ok-text">
                    {' '}
                    {t('settings.mediaKeys.active', { count: keys.registered.length })}
                  </span>
                )}
              </>
            }
          />
          {keys && keys.unavailable.length > 0 && (
            <div className="hq-banner hq-banner--warn">
              <Icon name="warning" size={16} />
              <span>
                {t('settings.mediaKeys.taken', {
                  keys: keys.unavailable
                    .map((k) => t(`settings.mediaKey.${k}` as MessageKey))
                    .join('、'),
                })}
              </span>
            </div>
          )}
          <p className="hint">{t('settings.mediaKeys.smtc')}</p>
          <Switch
            checked={state.prefs.tray}
            disabled={!state.tray.supported}
            onChange={(v) => void set({ tray: v, ...(v ? {} : { closeToTray: false }) })}
            title={t('settings.tray')}
            hint={t('settings.trayHint')}
          />
          <Switch
            checked={state.prefs.closeToTray}
            disabled={!state.prefs.tray}
            onChange={(v) => void set({ closeToTray: v })}
            title={t('settings.closeToTray')}
            hint={t('settings.closeToTrayHint')}
          />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------ DSP / Output

/** “Open in HQPlayer” (handoff §8.5): show its window when Studio can, otherwise say how. */
function OpenHqplayer() {
  const { t } = useI18n();
  const api = getShell()?.hqplayerApp;
  const toasts = useToasts();
  const [state, setState] = useState<HqpAppState | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.get().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, [api]);
  if (!api || !state?.supported || !state.running) {
    return <p className="hint">{t('settings.openHqplayerManual')}</p>;
  }
  return (
    <div className="button-row">
      <button
        type="button"
        className="hq-btn"
        onClick={() =>
          void api
            .window('show')
            .then((s) => s && setState(s))
            .catch((err: Error) => toasts.push('error', err.message))
        }
      >
        <Icon name="external" size={14} />
        {t('settings.openHqplayer')}
      </button>
      <span className="hint">{t('settings.openHqplayerHint')}</span>
    </div>
  );
}

export function DspSettings() {
  const { t } = useI18n();
  const { status } = useStudio();
  const dsp = status.dsp;
  const rows: Array<[MessageKey, string | null, 'readonly' | 'native']> = [
    ['settings.dspMode', dsp?.mode ?? null, 'readonly'],
    ['settings.dspFilter', dsp?.filter ?? null, 'readonly'],
    ['settings.dspShaper', dsp?.shaper ?? null, 'readonly'],
    [
      'settings.dspRate',
      dsp?.outputRate
        ? `${dsp.outputRate.toLocaleString('en')} Hz`
        : (status.output?.label ?? null),
      'readonly',
    ],
    ['settings.dsp.convolution', null, 'native'],
    ['settings.dsp.matrix', null, 'native'],
    ['settings.dsp.cuda', null, 'native'],
  ];
  return (
    <div className="settings-stack">
      <div className="hq-banner hq-banner--info">
        <Icon name="info" size={16} />
        <span>{t('settings.dsp.whyReadonly')}</span>
      </div>
      {status.connection !== 'connected' && (
        <EmptyState
          icon="wave"
          title={t('settings.dspUnavailable')}
          hint={t('engine.disconnectedReason')}
        />
      )}
      <table className="hq-table layer-table">
        <thead>
          <tr>
            <th>{t('settings.setting')}</th>
            <th>{t('settings.currentValue')}</th>
            <th>{t('settings.whereToChange')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value, layer]) => (
            <tr key={label}>
              <td>{t(label)}</td>
              <td>
                {layer === 'native' ? (
                  <span className="hq-muted">{t('settings.notReadable')}</span>
                ) : (
                  <strong>{value ?? '—'}</strong>
                )}
              </td>
              <td>
                <LayerTag layer={layer} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <OpenHqplayer />
    </div>
  );
}

export function OutputSettings() {
  const { t } = useI18n();
  const { status, capabilities } = useStudio();
  const now = useNowPlaying();
  const gate = useCapabilityGate();
  const volumeReason = gate('volume.set');
  const delay = status.outputDelayMs;
  return (
    <div className="settings-stack">
      <div className="settings-block">
        <BlockHead title={t('settings.signalPath')} layer="readonly" />
        <div className="kv">
          <span>{t('settings.output.input')}</span>
          <strong>{now.inputLabel ?? status.input?.label ?? '—'}</strong>
          <span>{t('settings.output.format')}</span>
          <span>
            {status.output ? <FormatBadge inputLabel={null} output={status.output} /> : '—'}
          </span>
          <span>{t('settings.output.delay')}</span>
          <strong>
            {delay !== null
              ? t('settings.output.delayValue', { seconds: (delay / 1000).toFixed(1) })
              : '—'}
          </strong>
        </div>
      </div>
      <div className="settings-block">
        <BlockHead
          title={t('player.volume')}
          layer={canUse(capabilities, 'volume.set') ? 'control' : 'readonly'}
        />
        <div className="kv">
          <span>{t('settings.output.volumeNow')}</span>
          <strong>{status.volumeDb !== null ? formatVolume(status.volumeDb) : '—'}</strong>
          <span>{t('settings.output.volumeRange')}</span>
          <strong>
            {status.volumeRange
              ? `${formatVolume(status.volumeRange.min)} … ${formatVolume(status.volumeRange.max)}`
              : '—'}
          </strong>
        </div>
        <p className="hint">{volumeReason ?? t('settings.output.volumeHint')}</p>
      </div>
      <div className="settings-block">
        <BlockHead title={t('settings.output.device')} layer="native" />
        <p className="hint">{t('settings.output.deviceNative')}</p>
        <OpenHqplayer />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------- Lyrics

export function LyricsSettings() {
  const { t } = useI18n();
  const { client, run, lyricsVersion } = useStudio();
  const { confirm } = useDialogs();
  const loaded = useAsync(() => client.lyrics.settings(), [client, lyricsVersion]);
  const [settings, setSettings] = useState<LyricsSettingsDto | null>(null);
  const current = settings ?? loaded.data ?? null;
  useEffect(() => setSettings(null), [loaded.data]);
  if (!current) return loaded.error ? <ErrorBlock error={loaded.error} /> : <LoadingBlock />;

  const setOnline = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: t('settings.lyrics.confirmTitle'),
        message: t('settings.lyrics.onlinePrivacy'),
        confirmLabel: t('settings.lyrics.confirm'),
      });
      if (!ok) return;
    }
    const res = await run(() => client.lyrics.setOnline(next), {
      success: next ? t('settings.lyrics.onlineOn') : t('settings.lyrics.onlineOff'),
    });
    if (res) setSettings(res);
  };
  const clear = async () => {
    const res = await run(() => client.lyrics.clearCache(), {
      success: t('settings.lyrics.cleared'),
    });
    if (res) setSettings(res);
  };
  const setProvider = async (id: OnlineLyricsProviderId, next: boolean) => {
    const name = t(`lyrics.provider.${id}`);
    if (next) {
      // Every source is another third party: ask before the first track name goes there.
      const ok = await confirm({
        title: t('settings.lyrics.providerConfirmTitle', { name }),
        message: `${t('settings.lyrics.providerConfirm', { name })} ${t(`settings.lyrics.provider.${id}`)}`,
        confirmLabel: t('settings.lyrics.confirm'),
      });
      if (!ok) return;
    }
    const ids = current.providers.filter((p) => (p.id === id ? next : p.enabled)).map((p) => p.id);
    const res = await run(() => client.lyrics.setProviders(ids), {
      success: t(next ? 'settings.lyrics.providerOn' : 'settings.lyrics.providerOff', { name }),
    });
    if (res) setSettings(res);
  };
  const c = current.cached;
  const onlineCached = c.lrclib + c.netease + c.kugou + c.lyricsovh;
  return (
    <div className="settings-stack">
      <div className="settings-block">
        <BlockHead title={t('settings.lyrics.local')} layer="studio" />
        <p className="hint">{t('settings.lyrics.localHint')}</p>
      </div>
      <div className="settings-block">
        <BlockHead title={t('settings.lyrics.onlineTitle')} layer="studio" />
        <Switch
          checked={current.online}
          onChange={(v) => void setOnline(v)}
          title={t('settings.lyrics.online')}
          hint={t('settings.lyrics.onlinePrivacy')}
        />
        {current.online && current.onlinePausedForMs > 0 && (
          <div className="hq-banner hq-banner--muted">
            <Icon name="info" size={16} />
            <span>
              {t('settings.lyrics.paused', {
                seconds: Math.ceil(current.onlinePausedForMs / 1000),
              })}
            </span>
          </div>
        )}
      </div>
      <div className="settings-block">
        <BlockHead title={t('settings.lyrics.sources')} layer="studio" />
        <p className="hint">
          {t(current.online ? 'settings.lyrics.sourcesHint' : 'settings.lyrics.sourcesOffHint')}
        </p>
        {current.providers.map((p) => (
          <Switch
            key={p.id}
            checked={p.enabled}
            disabled={!current.online}
            onChange={(v) => void setProvider(p.id, v)}
            title={t(`lyrics.provider.${p.id}`)}
            hint={
              <>
                {t(`settings.lyrics.provider.${p.id}`)}
                {current.online && p.enabled && p.pausedForMs > 0 && (
                  <>
                    {' '}
                    <em>
                      {t('settings.lyrics.providerPaused', {
                        seconds: Math.ceil(p.pausedForMs / 1000),
                      })}
                    </em>
                  </>
                )}
              </>
            }
          />
        ))}
      </div>
      <div className="settings-block">
        <BlockHead
          title={t('settings.lyrics.cache')}
          layer="studio"
          aside={
            <button
              type="button"
              className="hq-btn hq-btn--sm"
              onClick={() => void clear()}
              disabled={onlineCached + c.notFound === 0}
              title={t('settings.lyrics.clearHint')}
            >
              <Icon name="trash" size={14} />
              {t('settings.lyrics.clear')}
            </button>
          }
        />
        <p className="hint">
          {t('settings.lyrics.cached', {
            local: c.local,
            embedded: c.embedded,
            online: onlineCached,
            demo: c.demo,
            notFound: c.notFound,
          })}
        </p>
        <p className="hint">{t('settings.lyrics.clearHint')}</p>
      </div>
      <div className="settings-block">
        <BlockHead title={t('settings.lyrics.calibration')} layer="studio" />
        <p className="hint">{t('settings.lyrics.calibrationHint')}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------- Covers

/** Settings → 音乐库 → 封面: where covers come from; online sources are opt-in. */
export function CoverSettings() {
  const { t } = useI18n();
  const { client, run, libraryVersion } = useStudio();
  const { confirm } = useDialogs();
  const [tick, setTick] = useState(0);
  const loaded = useAsync(() => client.covers.settings(), [client, libraryVersion, tick]);
  const [settings, setSettings] = useState<CoverSettingsDto | null>(null);
  const current = settings ?? loaded.data ?? null;
  useEffect(() => setSettings(null), [loaded.data]);
  // The "find all" job runs in Core; poll while it does.
  const running = current?.fill.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [running, loaded.data]);
  if (!current) return loaded.error ? <ErrorBlock error={loaded.error} /> : null;

  const setOnline = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: t('settings.covers.confirmTitle'),
        message: t('settings.covers.onlinePrivacy'),
        confirmLabel: t('settings.covers.confirm'),
      });
      if (!ok) return;
    }
    const res = await run(() => client.covers.setOnline(next), {
      success: next ? t('settings.covers.onlineOn') : t('settings.covers.onlineOff'),
    });
    if (res) setSettings(res);
  };
  const setProvider = async (id: CoverProviderId, next: boolean) => {
    const ids = current.providers.filter((p) => (p.id === id ? next : p.enabled)).map((p) => p.id);
    const res = await run(() => client.covers.setProviders(ids));
    if (res) setSettings(res);
  };
  const fill = async () => {
    const ok = await confirm({
      title: t('settings.covers.fillConfirmTitle', { count: current.missing }),
      message: t('settings.covers.fillConfirm', { count: current.missing }),
      confirmLabel: t('settings.covers.fillStart'),
    });
    if (!ok) return;
    const res = await run(() => client.covers.fill());
    if (res) setSettings(res);
  };
  const stop = async () => {
    const res = await run(() => client.covers.cancelFill());
    if (res) setSettings(res);
  };
  const usable = current.online && current.providers.some((p) => p.enabled);
  const job = current.fill;
  return (
    <div className="settings-block">
      <BlockHead title={t('settings.covers.title')} layer="studio" />
      <p className="hint">{t('settings.covers.localHint')}</p>
      <Switch
        checked={current.online}
        onChange={(v) => void setOnline(v)}
        title={t('settings.covers.online')}
        hint={t('settings.covers.onlinePrivacy')}
      />
      {current.online && (
        <>
          <h4 className="settings-block__subtitle">{t('settings.covers.sources')}</h4>
          {current.providers.map((p) => (
            <Switch
              key={p.id}
              checked={p.enabled}
              onChange={(v) => void setProvider(p.id, v)}
              title={t(`covers.provider.${p.id}`)}
              hint={
                <>
                  {t(`settings.covers.provider.${p.id}`)}
                  {p.enabled && p.pausedForMs > 0 && (
                    <>
                      {' '}
                      <em>
                        {t('settings.lyrics.providerPaused', {
                          seconds: Math.ceil(p.pausedForMs / 1000),
                        })}
                      </em>
                    </>
                  )}
                </>
              }
            />
          ))}
        </>
      )}
      <p className="hint">
        {current.missing === 0
          ? t('settings.covers.missingNone')
          : t('settings.covers.missing', { count: current.missing })}
      </p>
      {usable && (job.running || current.missing > 0) && (
        <div className="settings-block__row">
          {job.running ? (
            <>
              <span className="hint">
                {t('settings.covers.fillRunning', {
                  done: job.done,
                  total: job.total,
                  found: job.found,
                })}
              </span>
              <button type="button" className="hq-btn hq-btn--sm" onClick={() => void stop()}>
                {t('settings.covers.fillStop')}
              </button>
            </>
          ) : (
            <button type="button" className="hq-btn hq-btn--sm" onClick={() => void fill()}>
              <Icon name="search" size={14} />
              {t('settings.covers.fill')}
            </button>
          )}
        </div>
      )}
      {!job.running && job.finishedAt !== null && (
        <p className="hint hq-muted">
          {t('settings.covers.fillDone', { done: job.done, found: job.found })}
        </p>
      )}
    </div>
  );
}
