import {
  EQ_BUILTIN_PRESETS,
  EQ_MAX_BANDS,
  EQ_MAX_BOOST_DB,
  EQ_MAX_FREQ,
  EQ_MIN_FREQ,
  EQ_MIN_GAIN_DB,
  eqCurveDb,
  eqHeadroom,
  formatParametricEq,
  logFrequencies,
  parseParametricEq,
  type EqBand,
  type EqBandType,
  type EqConfig,
  type EqStatus,
} from '@hqps/contracts';
import { Icon, Spinner, useDialogs, useI18n, useStudio, type MessageKey } from '@hqps/ui';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { BlockHead, Switch } from './SettingsSections';

type T = ReturnType<typeof useI18n>['t'];

const TYPES: EqBandType[] = ['peak', 'lowShelf', 'highShelf', 'lowPass', 'highPass'];
const hasGain = (type: EqBandType) => type !== 'lowPass' && type !== 'highPass';
const sameConfig = (a: EqConfig, b: EqConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Settings → EQ (D-042). Studio writes the curve as a filter file; HQPlayer's own convolution
 * engine plays through it. The curve is edited here and only reaches the file on “Apply”, so a
 * half-typed band never makes HQPlayer rebuild its chain.
 */
export function EqSettings() {
  const { t } = useI18n();
  const { client, run, status: engine } = useStudio();
  const [status, setStatus] = useState<EqStatus | null>(null);
  const [draft, setDraft] = useState<EqConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const s = await run(() => client.eq.status());
    if (s) {
      setStatus(s);
      setDraft((d) => d ?? s.config);
    }
  }, [client, run]);
  useEffect(() => {
    void reload();
  }, [reload, engine.connection]);

  if (!status || !draft) return <Spinner size={18} />;

  const dirty = !sameConfig(draft, status.config);
  const act = async <R,>(key: string, fn: () => Promise<R>, success?: string) => {
    setBusy(key);
    const res = await run(fn, success ? { success } : undefined);
    setBusy(null);
    return res;
  };

  const apply = async () => {
    const res = await act('apply', () => client.eq.save(draft), t('eq.applied'));
    if (res) {
      setStatus(res);
      setDraft(res.config);
    }
  };
  const setConvolution = async (on: boolean) => {
    const res = await act('convolution', () => client.eq.setConvolution(on));
    if (res) setStatus(res);
    else void reload();
  };

  return (
    <div className="settings-stack">
      <div className="settings-block">
        <BlockHead
          title={t('eq.title')}
          layer="studio"
          aside={dirty ? <span className="eq-dirty">{t('eq.unsaved')}</span> : undefined}
        />
        <p className="hint hq-muted">{t('eq.intro')}</p>
        <EqCurve config={draft} />
        <Headroom config={draft} t={t} />
        <EqPresets
          draft={draft}
          status={status}
          onLoad={(c) => setDraft(c)}
          onProfiles={(profiles) => setStatus({ ...status, profiles })}
        />
        <BandTable draft={draft} onChange={setDraft} t={t} />
        <EqText draft={draft} onImport={setDraft} t={t} />
        <div className="button-row">
          <button
            type="button"
            className="hq-btn hq-btn--primary"
            disabled={!dirty || busy !== null || status.checkRunning || !status.filePath}
            onClick={() => void apply()}
            title={status.convolution ? t('eq.applyHintOn') : t('eq.applyHint')}
          >
            {busy === 'apply' ? <Spinner size={14} /> : <Icon name="check" size={14} />}
            {t('eq.apply')}
          </button>
          <button
            type="button"
            className="hq-btn"
            disabled={!dirty || busy !== null}
            onClick={() => setDraft(status.config)}
          >
            {t('eq.revert')}
          </button>
        </div>
      </div>

      <ConvolutionBlock
        status={status}
        busy={busy}
        onSwitch={(on) => void setConvolution(on)}
        t={t}
      />
      <ListeningCheck status={status} onStatus={setStatus} busy={busy} setBusy={setBusy} t={t} />
    </div>
  );
}

// --- the curve ----------------------------------------------------------------------------------

const W = 640;
const H = 200;
const PAD_L = 34;
const PAD_B = 18;
const F_MIN = 20;
const F_MAX = 20_000;
const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];

function EqCurve({ config }: { config: EqConfig }) {
  const freqs = useMemo(() => logFrequencies(240, F_MIN, F_MAX), []);
  const curve = useMemo(() => eqCurveDb(config, freqs), [config, freqs]);
  const { preampDb } = useMemo(() => eqHeadroom(config), [config]);
  const withPre = curve.map((v) => v + preampDb);
  const span = Math.max(
    12,
    Math.ceil(Math.max(...curve.map(Math.abs), ...withPre.map(Math.abs)) / 6) * 6,
  );
  const x = (f: number) =>
    PAD_L + ((W - PAD_L - 4) * Math.log(f / F_MIN)) / Math.log(F_MAX / F_MIN);
  const y = (db: number) => 6 + ((H - PAD_B - 12) * (span - db)) / (2 * span);
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(freqs[i]!).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const dbLines = [-span, -span / 2, 0, span / 2, span];
  const markers = config.bands
    .filter((b) => b.enabled && b.freq >= F_MIN && b.freq <= F_MAX)
    .map((b) => ({ f: b.freq, db: eqCurveDb(config, [b.freq])[0]! }));

  return (
    <svg className="eq-curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="EQ">
      {GRID_F.map((f) => (
        <g key={f}>
          <line className="eq-curve__grid" x1={x(f)} x2={x(f)} y1={6} y2={H - PAD_B} />
          <text className="eq-curve__label" x={x(f)} y={H - 4} textAnchor="middle">
            {f >= 1000 ? `${f / 1000}k` : f}
          </text>
        </g>
      ))}
      {dbLines.map((db) => (
        <g key={db}>
          <line
            className={db === 0 ? 'eq-curve__zero' : 'eq-curve__grid'}
            x1={PAD_L}
            x2={W - 4}
            y1={y(db)}
            y2={y(db)}
          />
          <text className="eq-curve__label" x={PAD_L - 4} y={y(db) + 3} textAnchor="end">
            {db > 0 ? `+${db}` : db}
          </text>
        </g>
      ))}
      {preampDb < 0 && <path className="eq-curve__pre" d={path(withPre)} />}
      <path className="eq-curve__line" d={path(curve)} />
      {markers.map((m, i) => (
        <circle key={i} className="eq-curve__dot" cx={x(m.f)} cy={y(m.db)} r={3.5} />
      ))}
    </svg>
  );
}

function Headroom({ config, t }: { config: EqConfig; t: T }) {
  const h = eqHeadroom(config);
  return (
    <p className="hint eq-headroom">
      <Icon name="info" size={14} />
      {h.autoLowered
        ? t('eq.headroomAuto', { preamp: h.preampDb.toFixed(1), peak: h.curvePeakDb.toFixed(1) })
        : t('eq.headroom', { preamp: h.preampDb.toFixed(1) })}
    </p>
  );
}

// --- bands --------------------------------------------------------------------------------------

/** A number box that keeps what is typed and commits a clamped value on blur / Enter. */
function NumField({
  value,
  min,
  max,
  step,
  disabled,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  label: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const v = Math.min(max, Math.max(min, n));
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className="hq-input eq-num"
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function BandTable({
  draft,
  onChange,
  t,
}: {
  draft: EqConfig;
  onChange: (c: EqConfig) => void;
  t: T;
}) {
  const setBand = (i: number, patch: Partial<EqBand>) =>
    onChange({ ...draft, bands: draft.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const addBand = () =>
    onChange({
      ...draft,
      bands: [...draft.bands, { type: 'peak', enabled: true, freq: 1000, gainDb: 0, q: 1 }],
    });
  return (
    <div className="eq-bands">
      <div className="eq-preamp">
        <span>{t('eq.preamp')}</span>
        <NumField
          value={draft.preampDb}
          min={-30}
          max={0}
          step={0.5}
          label={t('eq.preamp')}
          onCommit={(v) => onChange({ ...draft, preampDb: v })}
        />
        <span className="hq-muted">dB</span>
      </div>
      {draft.bands.length > 0 && (
        <div className="eq-table-wrap">
          <table className="hq-table eq-table">
            <thead>
              <tr>
                <th aria-label={t('eq.band.on')} />
                <th>{t('eq.band.type')}</th>
                <th>{t('eq.band.freq')}</th>
                <th>{t('eq.band.gain')}</th>
                <th>Q</th>
                <th aria-label={t('common.remove')} />
              </tr>
            </thead>
            <tbody>
              {draft.bands.map((b, i) => (
                <tr key={i} className={b.enabled ? undefined : 'is-off'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={b.enabled}
                      aria-label={t('eq.band.on')}
                      onChange={(e) => setBand(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <select
                      className="hq-input"
                      value={b.type}
                      aria-label={t('eq.band.type')}
                      onChange={(e) => setBand(i, { type: e.target.value as EqBandType })}
                    >
                      {TYPES.map((ty) => (
                        <option key={ty} value={ty}>
                          {t(`eq.type.${ty}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <NumField
                      value={b.freq}
                      min={EQ_MIN_FREQ}
                      max={EQ_MAX_FREQ}
                      step={1}
                      label={t('eq.band.freq')}
                      onCommit={(v) => setBand(i, { freq: v })}
                    />
                  </td>
                  <td>
                    <NumField
                      value={b.gainDb}
                      min={EQ_MIN_GAIN_DB}
                      max={EQ_MAX_BOOST_DB}
                      step={0.5}
                      disabled={!hasGain(b.type)}
                      label={t('eq.band.gain')}
                      onCommit={(v) => setBand(i, { gainDb: v })}
                    />
                  </td>
                  <td>
                    <NumField
                      value={b.q}
                      min={0.1}
                      max={10}
                      step={0.1}
                      label="Q"
                      onCommit={(v) => setBand(i, { q: v })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="hq-icon-btn"
                      aria-label={t('common.remove')}
                      title={t('common.remove')}
                      onClick={() =>
                        onChange({ ...draft, bands: draft.bands.filter((_, j) => j !== i) })
                      }
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="button-row">
        <button
          type="button"
          className="hq-btn"
          disabled={draft.bands.length >= EQ_MAX_BANDS}
          onClick={addBand}
        >
          <Icon name="plus" size={14} />
          {t('eq.addBand')}
        </button>
      </div>
    </div>
  );
}

// --- presets and saved curves -------------------------------------------------------------------

function EqPresets({
  draft,
  status,
  onLoad,
  onProfiles,
}: {
  draft: EqConfig;
  status: EqStatus;
  onLoad: (c: EqConfig) => void;
  onProfiles: (p: EqStatus['profiles']) => void;
}) {
  const { t } = useI18n();
  const { client, run } = useStudio();
  const { prompt, confirm } = useDialogs();
  const [chosen, setChosen] = useState('builtin:flat');
  const profile = chosen.startsWith('profile:')
    ? status.profiles.find((p) => `profile:${p.id}` === chosen)
    : undefined;
  const builtin = EQ_BUILTIN_PRESETS.find((p) => `builtin:${p.id}` === chosen);

  const save = async () => {
    const name = await prompt({
      title: t('eq.profile.saveTitle'),
      label: t('eq.profile.name'),
      defaultValue: profile?.name,
      confirmLabel: t('common.save'),
    });
    if (!name?.trim()) return;
    const res = await run(() => client.eq.saveProfile(name.trim(), draft), {
      success: t('eq.profile.saved', { name: name.trim() }),
    });
    if (res) {
      onProfiles(res.profiles);
      const p = res.profiles.find((x) => x.name === name.trim());
      if (p) setChosen(`profile:${p.id}`);
    }
  };
  const remove = async () => {
    if (!profile) return;
    const ok = await confirm({
      title: t('eq.profile.deleteTitle'),
      message: t('eq.profile.deleteConfirm', { name: profile.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    const res = await run(() => client.eq.deleteProfile(profile.id));
    if (res) {
      onProfiles(res.profiles);
      setChosen('builtin:flat');
    }
  };

  return (
    <div className="button-row eq-presets">
      <select
        className="hq-input"
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        aria-label={t('eq.presets')}
      >
        <optgroup label={t('eq.presets.builtin')}>
          {EQ_BUILTIN_PRESETS.map((p) => (
            <option key={p.id} value={`builtin:${p.id}`}>
              {t(`eq.preset.${p.id}` as MessageKey)}
            </option>
          ))}
        </optgroup>
        {status.profiles.length > 0 && (
          <optgroup label={t('eq.presets.mine')}>
            {status.profiles.map((p) => (
              <option key={p.id} value={`profile:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className="hq-btn"
        onClick={() => {
          const c = profile?.config ?? builtin?.config;
          if (c) onLoad(structuredClone(c));
        }}
      >
        {t('eq.presets.load')}
      </button>
      <button type="button" className="hq-btn" onClick={() => void save()}>
        <Icon name="plus" size={14} />
        {t('eq.profile.save')}
      </button>
      {profile && (
        <button type="button" className="hq-btn" onClick={() => void remove()}>
          <Icon name="trash" size={14} />
          {t('common.delete')}
        </button>
      )}
    </div>
  );
}

/** Paste an AutoEQ / Equalizer APO “ParametricEQ.txt”, or copy the curve in that format. */
function EqText({
  draft,
  onImport,
  t,
}: {
  draft: EqConfig;
  onImport: (c: EqConfig) => void;
  t: T;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const doImport = () => {
    const { config, skipped } = parseParametricEq(text);
    if (config.bands.length === 0 && config.preampDb === 0) {
      setNote(t('eq.text.nothing'));
      return;
    }
    onImport(config);
    setNote(
      skipped.length
        ? t('eq.text.importedSkipped', { count: config.bands.length, skipped: skipped.length })
        : t('eq.text.imported', { count: config.bands.length }),
    );
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatParametricEq(draft));
      setNote(t('eq.text.copied'));
    } catch {
      setText(formatParametricEq(draft));
    }
  };
  return (
    <details className="eq-text">
      <summary>{t('eq.text.title')}</summary>
      <p className="hint hq-muted">{t('eq.text.hint')}</p>
      <textarea
        className="hq-input"
        rows={6}
        value={text}
        spellCheck={false}
        placeholder={'Preamp: -6.2 dB\nFilter 1: ON PK Fc 105 Hz Gain -2.4 dB Q 0.70'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="button-row">
        <button type="button" className="hq-btn" disabled={!text.trim()} onClick={doImport}>
          {t('eq.text.import')}
        </button>
        <button type="button" className="hq-btn" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {t('eq.text.copy')}
        </button>
        {note && <span className="hint">{note}</span>}
      </div>
    </details>
  );
}

// --- HQPlayer side ------------------------------------------------------------------------------

function ConvolutionBlock({
  status,
  busy,
  onSwitch,
  t,
}: {
  status: EqStatus;
  busy: string | null;
  onSwitch: (on: boolean) => void;
  t: T;
}) {
  const { capabilities } = useStudio();
  const live = capabilities?.adapter === 'live';
  const [copied, setCopied] = useState(false);
  const copyPath = async () => {
    if (!status.filePath) return;
    try {
      await navigator.clipboard.writeText(status.filePath);
      setCopied(true);
    } catch {
      // the path is selectable text anyway
    }
  };
  const switchHint = !live
    ? t('eq.conv.needsLive')
    : status.canSwitch
      ? t('eq.conv.hint')
      : t('eq.conv.needsDsp');
  return (
    <div className="settings-block">
      <BlockHead title={t('eq.conv.title')} layer="control" />
      <Switch
        checked={status.convolution === true}
        disabled={!status.canSwitch || busy !== null || status.checkRunning}
        onChange={onSwitch}
        title={t('eq.conv.switch')}
        hint={switchHint}
        note={busy === 'convolution' ? <Spinner size={14} /> : undefined}
      />
      {!status.canSwitch && <p className="hint hq-muted">{switchHint}</p>}
      <h4 className="eq-subhead">{t('eq.setup.title')}</h4>
      <ol className="maint-list eq-steps">
        <li>{t('eq.setup.step1')}</li>
        <li>
          {t('eq.setup.step2')}
          {status.filePath && (
            <span className="eq-path">
              <code className="remote-url">{status.filePath}</code>
              <button type="button" className="hq-btn" onClick={() => void copyPath()}>
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                {copied ? t('eq.setup.copied') : t('eq.setup.copy')}
              </button>
            </span>
          )}
        </li>
        <li>{t('eq.setup.step3')}</li>
        <li>{t('eq.setup.step4')}</li>
      </ol>
      {status.hqplayerRemote && (
        <p className="maint-notice maint-notice--warn">
          <Icon name="warning" size={16} />
          <span>{t('eq.setup.remote')}</span>
        </p>
      )}
      <p className="hint hq-muted">
        {status.file
          ? t('eq.file.info', {
              when: new Date(status.file.writtenAt).toLocaleString(),
              taps: status.file.taps.toLocaleString(),
              rate: (status.file.sampleRate / 1000).toFixed(1),
              preamp: status.file.preampDb.toFixed(1),
            })
          : t('eq.file.none')}
      </p>
    </div>
  );
}

function ListeningCheck({
  status,
  onStatus,
  busy,
  setBusy,
  t,
}: {
  status: EqStatus;
  onStatus: (s: EqStatus) => void;
  busy: string | null;
  setBusy: (b: string | null) => void;
  t: T;
}) {
  const { client, run } = useStudio();
  const go = async <R,>(key: string, fn: () => Promise<R>) => {
    setBusy(key);
    const res = await run(fn);
    setBusy(null);
    return res;
  };
  const start = async () => {
    const res = await go('check', () => client.eq.startCheck());
    if (res) onStatus(res.status);
  };
  const answer = async (heard: boolean | null) => {
    const res = await go('answer', () =>
      heard === null ? client.eq.cancelCheck() : client.eq.answerCheck(heard),
    );
    if (res) onStatus(res);
  };
  const result = status.reloadCheck;
  return (
    <div className="settings-block">
      <BlockHead title={t('eq.check.title')} layer="control" />
      <p className="hint hq-muted">{t('eq.check.intro')}</p>
      {result && !status.checkRunning && (
        <p
          className={`maint-notice ${result.result === 'reloads' ? 'maint-notice--ok' : 'maint-notice--warn'}`}
        >
          <Icon name={result.result === 'reloads' ? 'check' : 'warning'} size={16} />
          <span>
            {t(`eq.check.result.${result.result}` as MessageKey)}{' '}
            <span className="hq-muted">({new Date(result.at).toLocaleString()})</span>
          </span>
        </p>
      )}
      {status.checkRunning ? (
        <div className="eq-check-ask">
          <p>
            <strong>{t('eq.check.question')}</strong>
          </p>
          <p className="hint hq-muted">{t('eq.check.wait')}</p>
          <div className="button-row">
            <button
              type="button"
              className="hq-btn hq-btn--primary"
              disabled={busy !== null}
              onClick={() => void answer(true)}
            >
              {t('eq.check.yes')}
            </button>
            <button
              type="button"
              className="hq-btn"
              disabled={busy !== null}
              onClick={() => void answer(false)}
            >
              {t('eq.check.no')}
            </button>
            <button
              type="button"
              className="hq-btn"
              disabled={busy !== null}
              onClick={() => void answer(null)}
            >
              {t('common.cancel')}
            </button>
            {busy === 'answer' && <Spinner size={14} />}
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button
            type="button"
            className="hq-btn"
            disabled={!status.canSwitch || busy !== null}
            title={status.canSwitch ? undefined : t('eq.conv.needsDsp')}
            onClick={() => void start()}
          >
            {busy === 'check' ? <Spinner size={14} /> : <Icon name="play" size={14} />}
            {result ? t('eq.check.again') : t('eq.check.start')}
          </button>
        </div>
      )}
    </div>
  );
}
