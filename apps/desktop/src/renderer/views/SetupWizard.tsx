/**
 * First-run setup: a full-window wizard shown once on a fresh install (and again from
 * Settings → General → “Run setup again”). It only gathers what the existing Settings cards
 * already do — HQPlayer program, music folders, engine connection, control / DSP permission —
 * and applies the engine choice at the end, so nothing reaches HQPlayer before the user says so.
 *
 * Steps: welcome → HQPlayer → music → control → done.
 */
import type { LibraryRoot } from '@hqps/contracts';
import {
  Icon,
  LOCALES,
  Spinner,
  formatNumber,
  useAsync,
  useI18n,
  useStudio,
  useToasts,
  type IconName,
  type Locale,
} from '@hqps/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getShell, type HqpAppState } from '../shell';
import { Segmented } from './common';

/** Ask the app shell to show the wizard again (Settings → General). */
export const OPEN_SETUP_EVENT = 'hqps:open-setup';
export function openSetupWizard(): void {
  window.dispatchEvent(new Event(OPEN_SETUP_EVENT));
}

/** Friend-facing guide (also linked from the release notes). */
export const GUIDE_URL =
  'https://github.com/rikusrocks/hqplayer-studio/blob/main/docs/getting-started.md';
const HQPLAYER_URL = 'https://www.signalyst.com/consumer.html';

const STEPS = ['welcome', 'hqplayer', 'music', 'control', 'done'] as const;
type Step = (typeof STEPS)[number];
const STEP_ICON: Record<Step, IconName> = {
  welcome: 'home',
  hqplayer: 'plug',
  music: 'library',
  control: 'remote',
  done: 'check',
};

type Engine = 'live' | 'mock';

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { client, run, libraryVersion, scanJobs } = useStudio();
  const shell = getShell();
  const [step, setStep] = useState<Step>('welcome');
  const [engine, setEngine] = useState<Engine>('live');
  const [allowControl, setAllowControl] = useState(true);
  const [allowDsp, setAllowDsp] = useState(false);
  const [removeDemo, setRemoveDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const scanning = scanJobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  // re-read the folders as scans add tracks
  const roots = useAsync(() => client.library.roots(), [client, libraryVersion, scanning]);
  const current = useAsync(() => client.settings.engine(), [client]);
  // Run again later: start from what is saved (a fresh install has control off → suggest on).
  useEffect(() => {
    const c = current.data;
    if (!c || c.preferredAdapter !== 'live') return;
    setEngine('live');
    setAllowControl(c.allowControl);
    setAllowDsp(c.allowDsp);
  }, [current.data]);
  const restartNeeded = shell !== null && current.data?.activeAdapter !== engine;
  const index = STEPS.indexOf(step);

  const skip = async () => {
    setBusy(true);
    const ok = await run(() => client.settings.setSetupCompleted(true));
    setBusy(false);
    if (ok) onClose();
  };

  const finish = async () => {
    setBusy(true);
    try {
      const list = await client.library.roots();
      const own = list.filter((r) => r.kind !== 'fixture');
      if (removeDemo && own.length > 0) {
        for (const demo of list.filter((r) => r.kind === 'fixture')) {
          await run(() => client.library.removeRoot(demo.id));
        }
      }
      const live = engine === 'live';
      const before = current.data;
      let res = await run(() => client.settings.setEngine(engine));
      // only switches that change (each change posts a notice)
      const control = live && allowControl;
      const dsp = control && allowDsp;
      if (before?.allowControl !== control) {
        res = (await run(() => client.settings.setControl(control))) ?? res;
      }
      if (before?.allowDsp !== dsp) {
        res = (await run(() => client.settings.setDspAllowed(dsp))) ?? res;
      }
      const done = await run(() => client.settings.setSetupCompleted(true));
      if (!done) return;
      if (shell && res && res.activeAdapter !== engine) {
        shell.relaunch();
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div className="setup__card">
        <ol className="setup__steps" aria-label={t('setup.progress')}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={`setup__step${i === index ? ' is-active' : ''}${i < index ? ' is-done' : ''}`}
              aria-current={i === index ? 'step' : undefined}
            >
              <Icon name={i < index ? 'check' : STEP_ICON[s]} size={14} />
              <span>{t(`setup.step.${s}`)}</span>
            </li>
          ))}
        </ol>

        <div className="setup__body" key={step}>
          {step === 'welcome' && <WelcomeStep />}
          {step === 'hqplayer' && <HqplayerStep onUseDemo={() => setEngine('mock')} />}
          {step === 'music' && (
            <MusicStep
              roots={roots.data ?? null}
              reload={roots.reload}
              removeDemo={removeDemo}
              setRemoveDemo={setRemoveDemo}
            />
          )}
          {step === 'control' && (
            <ControlStep
              engine={engine}
              setEngine={setEngine}
              allowControl={allowControl}
              setAllowControl={setAllowControl}
              allowDsp={allowDsp}
              setAllowDsp={setAllowDsp}
            />
          )}
          {step === 'done' && (
            <DoneStep
              engine={engine}
              allowControl={allowControl}
              allowDsp={allowDsp}
              roots={roots.data ?? null}
              removeDemo={removeDemo}
              restartNeeded={restartNeeded}
            />
          )}
        </div>

        <div className="setup__actions">
          {step === 'welcome' ? (
            <button
              type="button"
              className="hq-btn hq-btn--ghost"
              disabled={busy}
              onClick={() => void skip()}
              title={t('setup.skipHint')}
            >
              {t('setup.skip')}
            </button>
          ) : (
            <button type="button" className="hq-btn" disabled={busy} onClick={back}>
              <Icon name="chevronLeft" size={16} />
              {t('setup.back')}
            </button>
          )}
          <span className="setup__count">
            {index + 1} / {STEPS.length}
          </span>
          {step === 'done' ? (
            <button
              type="button"
              className="hq-btn hq-btn--primary"
              disabled={busy}
              onClick={() => void finish()}
            >
              {busy ? <Spinner size={14} /> : <Icon name="check" size={16} />}
              {restartNeeded ? t('setup.finishRestart') : t('setup.finish')}
            </button>
          ) : (
            <button type="button" className="hq-btn hq-btn--primary" onClick={next}>
              {step === 'welcome' ? t('setup.start') : t('setup.next')}
              <Icon name="chevronRight" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ steps

function StepHead({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <header className="setup__head">
      <h1 id="setup-title" className="setup__title">
        {title}
      </h1>
      {intro && <p className="setup__intro">{intro}</p>}
    </header>
  );
}

function WelcomeStep() {
  const { t, locale, setLocale } = useI18n();
  return (
    <>
      <StepHead title={t('setup.welcome.title')} intro={t('setup.welcome.intro')} />
      <div className="setting-row">
        <span className="setting-row__label">{t('settings.language')}</span>
        <Segmented<Locale>
          label={t('settings.language')}
          value={locale}
          options={LOCALES.map((l) => ({ id: l.id, label: l.label }))}
          onChange={setLocale}
        />
      </div>
      <div className="setup__note">
        <strong>{t('setup.welcome.needTitle')}</strong>
        <ul>
          <li>{t('setup.welcome.need1')}</li>
          <li>{t('setup.welcome.need2')}</li>
          <li>{t('setup.welcome.need3')}</li>
        </ul>
      </div>
      <p className="hint">{t('setup.welcome.safe')}</p>
      <p className="hint">
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          <Icon name="external" size={12} /> {t('setup.guideLink')}
        </a>
      </p>
    </>
  );
}

type CheckState = 'ok' | 'bad' | 'unknown' | 'checking';

function Check({
  state,
  title,
  detail,
  children,
}: {
  state: CheckState;
  title: string;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  const icon: IconName = state === 'ok' ? 'check' : state === 'bad' ? 'warning' : 'info';
  return (
    <li className={`setup-check setup-check--${state}`}>
      <span className="setup-check__icon">
        {state === 'checking' ? <Spinner size={14} /> : <Icon name={icon} size={16} />}
      </span>
      <div className="setup-check__body">
        <strong>{title}</strong>
        {detail && <div className="hint">{detail}</div>}
        {children && <div className="button-row">{children}</div>}
      </div>
    </li>
  );
}

function HqplayerStep({ onUseDemo }: { onUseDemo: () => void }) {
  const { t } = useI18n();
  const toasts = useToasts();
  const shell = getShell();
  const api = shell?.hqplayerApp;
  const [state, setState] = useState<HqpAppState | null>(null);
  const [port, setPort] = useState<CheckState>(api ? 'checking' : 'unknown');
  const [busy, setBusy] = useState(false);

  const probe = useCallback(async () => {
    if (!api) return;
    setPort('checking');
    setPort((await api.probe().catch(() => false)) ? 'ok' : 'bad');
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.get().then((s) => alive && setState(s));
    void probe();
    return () => {
      alive = false;
    };
  }, [api, probe]);

  const act = async (fn: () => Promise<HqpAppState | null>) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) setState(s);
    } catch (err) {
      toasts.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
    // HQPlayer takes a moment to open its control port after it starts
    setTimeout(() => void probe(), 2500);
  };

  const windows = state?.supported === true;
  return (
    <>
      <StepHead title={t('setup.hqp.title')} intro={t('setup.hqp.intro')} />
      {!api && (
        <div className="hq-banner hq-banner--muted">
          <Icon name="info" size={16} />
          <span>{t('setup.hqp.browser')}</span>
        </div>
      )}
      <ul className="setup-checks">
        {windows && (
          <Check
            state={state.exePath ? 'ok' : 'bad'}
            title={state.exePath ? t('setup.hqp.installed') : t('setup.hqp.notInstalled')}
            detail={
              state.exePath ? (
                <span className="hq-mono">{state.exePath}</span>
              ) : (
                t('setup.hqp.notInstalledHelp')
              )
            }
          >
            <button
              type="button"
              className="hq-btn hq-btn--sm"
              disabled={busy}
              onClick={() => void act(api!.pickExe)}
            >
              <Icon name="folder" size={14} />
              {t('hqpApp.pick')}
            </button>
            {!state.exePath && (
              <a
                className="hq-btn hq-btn--sm hq-btn--ghost"
                href={HQPLAYER_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="external" size={14} />
                {t('setup.hqp.download')}
              </a>
            )}
          </Check>
        )}
        {windows && (
          <Check
            state={state.running ? 'ok' : 'bad'}
            title={state.running ? t('setup.hqp.running') : t('setup.hqp.notRunning')}
            detail={state.running ? undefined : t('setup.hqp.notRunningHelp')}
          >
            {!state.running && state.exePath && (
              <button
                type="button"
                className="hq-btn hq-btn--sm"
                disabled={busy}
                onClick={() => void act(api!.launch)}
              >
                {busy ? <Spinner size={14} /> : <Icon name="play" size={14} />}
                {t('hqpApp.launch')}
              </button>
            )}
          </Check>
        )}
        {api && (
          <Check
            state={port}
            title={
              port === 'ok'
                ? t('setup.hqp.portOk')
                : port === 'checking'
                  ? t('setup.hqp.portChecking')
                  : t('setup.hqp.portBad')
            }
            detail={port === 'bad' ? t('setup.hqp.portHelp') : t('setup.hqp.portWhat')}
          >
            <button
              type="button"
              className="hq-btn hq-btn--sm"
              disabled={port === 'checking'}
              onClick={() => void probe()}
            >
              <Icon name="refresh" size={14} />
              {t('setup.hqp.checkAgain')}
            </button>
          </Check>
        )}
      </ul>

      {windows && (
        <div className="setup__group">
          <label className="setting-row">
            <span className="setting-row__label">
              {t('hqpApp.autoStart')}
              <span className="hint setup__sub">{t('hqpApp.autoStartHint')}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={state.prefs.autoStart}
              disabled={busy}
              onChange={(e) => void act(() => api!.set({ autoStart: e.target.checked }))}
            />
          </label>
          <div className="setting-row">
            <span className="setting-row__label">
              {t('hqpApp.windowMode')}
              <span className="hint setup__sub">{t('setup.hqp.windowHint')}</span>
            </span>
            <Segmented<HqpAppState['prefs']['windowMode']>
              label={t('hqpApp.windowMode')}
              value={state.prefs.windowMode}
              disabled={busy}
              options={(['normal', 'minimized', 'hidden'] as const).map((id) => ({
                id,
                label: t(`hqpApp.mode.${id}`),
              }))}
              onChange={(v) => void act(() => api!.set({ windowMode: v }))}
            />
          </div>
        </div>
      )}

      <div className="setup__note">
        <strong>{t('setup.hqp.ownSettingsTitle')}</strong>
        <p>{t('setup.hqp.ownSettings')}</p>
      </div>
      {port === 'bad' && (
        <p className="hint">
          {t('setup.hqp.noHqp')}{' '}
          <button type="button" className="setup__link" onClick={onUseDemo}>
            {t('setup.hqp.useDemo')}
          </button>
        </p>
      )}
    </>
  );
}

function MusicStep({
  roots,
  reload,
  removeDemo,
  setRemoveDemo,
}: {
  roots: LibraryRoot[] | null;
  reload: () => void;
  removeDemo: boolean;
  setRemoveDemo: (v: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { client, run, scanJobs } = useStudio();
  const shell = getShell();
  const [path, setPath] = useState('');

  const add = async (p: string) => {
    const value = p.trim();
    if (!value) return;
    const root = await run(() => client.library.addRoot(value), {
      success: t('settings.rootAdded'),
    });
    if (!root) return;
    setPath('');
    reload();
    await run(() => client.library.scan(root.id), { success: t('settings.scanStarted') });
  };
  const pick = async () => {
    const picked = await shell?.pickFolder();
    if (picked) await add(picked);
  };

  const own = (roots ?? []).filter((r) => r.kind !== 'fixture');
  const demo = (roots ?? []).filter((r) => r.kind === 'fixture');
  const jobFor = (id: string) =>
    scanJobs.find((j) => j.rootId === id && (j.state === 'running' || j.state === 'queued'));

  return (
    <>
      <StepHead title={t('setup.music.title')} intro={t('setup.music.intro')} />
      {own.length > 0 && (
        <ul className="setup-roots">
          {own.map((r) => {
            const job = jobFor(r.id);
            return (
              <li key={r.id} className="setup-root">
                <Icon name="folder" size={16} />
                <div>
                  <strong>{r.name}</strong>
                  <div className="hint hq-mono">{r.path}</div>
                </div>
                <span className="hint">
                  {job ? (
                    <>
                      <Spinner size={12} />{' '}
                      {t('setup.music.scanning', { count: formatNumber(job.filesSeen, locale) })}
                    </>
                  ) : (
                    t('common.tracksCount', { count: formatNumber(r.trackCount, locale) })
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="add-root__row"
        onSubmit={(e) => {
          e.preventDefault();
          void add(path);
        }}
      >
        {shell ? (
          <button type="button" className="hq-btn hq-btn--primary" onClick={() => void pick()}>
            <Icon name="plus" size={16} />
            {t('setup.music.add')}
          </button>
        ) : (
          <>
            <input
              className="hq-input hq-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t('settings.rootPlaceholder')}
              spellCheck={false}
              aria-label={t('settings.addRoot')}
            />
            <button type="submit" className="hq-btn hq-btn--primary" disabled={!path.trim()}>
              <Icon name="plus" size={16} />
              {t('settings.addRoot')}
            </button>
          </>
        )}
      </form>
      <p className="hint">{t('setup.music.help')}</p>
      {demo.length > 0 && (
        <label className={`setting-row${own.length === 0 ? ' is-disabled' : ''}`}>
          <span className="setting-row__label">
            {t('setup.music.removeDemo')}
            <span className="hint setup__sub">
              {own.length === 0
                ? t('setup.music.removeDemoLater')
                : t('setup.music.removeDemoHint')}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={removeDemo && own.length > 0}
            disabled={own.length === 0}
            onChange={(e) => setRemoveDemo(e.target.checked)}
          />
        </label>
      )}
    </>
  );
}

function ControlStep({
  engine,
  setEngine,
  allowControl,
  setAllowControl,
  allowDsp,
  setAllowDsp,
}: {
  engine: Engine;
  setEngine: (e: Engine) => void;
  allowControl: boolean;
  setAllowControl: (v: boolean) => void;
  allowDsp: boolean;
  setAllowDsp: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const live = engine === 'live';
  const option = (id: Engine, title: string, hint: string) => (
    <label className="engine-option setup-option">
      <input
        type="radio"
        name="setup-engine"
        value={id}
        checked={engine === id}
        onChange={() => setEngine(id)}
      />
      <span>
        <strong>{title}</strong>
        <span className="hint setup__sub">{hint}</span>
      </span>
    </label>
  );
  return (
    <>
      <StepHead title={t('setup.control.title')} intro={t('setup.control.intro')} />
      <div className="engine-options" role="radiogroup" aria-label={t('engine.mode.title')}>
        {option('live', t('setup.control.live'), t('setup.control.liveHint'))}
        {option('mock', t('setup.control.mock'), t('setup.control.mockHint'))}
      </div>
      <div className="setup__group">
        <label className={`setting-row${live ? '' : ' is-disabled'}`}>
          <span className="setting-row__label">
            {t('engine.control.title')}
            <span className="hint setup__sub">{t('setup.control.controlHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={live && allowControl}
            disabled={!live}
            onChange={(e) => setAllowControl(e.target.checked)}
          />
        </label>
        <label className={`setting-row${live && allowControl ? '' : ' is-disabled'}`}>
          <span className="setting-row__label">
            {t('setup.control.dsp')}
            <span className="hint setup__sub">{t('setup.control.dspHint')}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={live && allowControl && allowDsp}
            disabled={!live || !allowControl}
            onChange={(e) => setAllowDsp(e.target.checked)}
          />
        </label>
      </div>
      <p className="hint">{t('setup.control.never')}</p>
    </>
  );
}

function DoneStep({
  engine,
  allowControl,
  allowDsp,
  roots,
  removeDemo,
  restartNeeded,
}: {
  engine: Engine;
  allowControl: boolean;
  allowDsp: boolean;
  roots: LibraryRoot[] | null;
  removeDemo: boolean;
  restartNeeded: boolean;
}) {
  const { t } = useI18n();
  const shell = getShell();
  const live = engine === 'live';
  const own = (roots ?? []).filter((r) => r.kind !== 'fixture').length;
  const yes = (on: boolean) => (on ? t('setup.done.on') : t('setup.done.off'));
  return (
    <>
      <StepHead title={t('setup.done.title')} intro={t('setup.done.intro')} />
      <div className="kv setup__summary">
        <span>{t('setup.done.engine')}</span>
        <strong>{live ? t('setup.control.live') : t('setup.control.mock')}</strong>
        <span>{t('engine.control.title')}</span>
        <strong>{yes(live && allowControl)}</strong>
        <span>{t('setup.control.dsp')}</span>
        <strong>{yes(live && allowControl && allowDsp)}</strong>
        <span>{t('setup.done.folders')}</span>
        <strong>
          {own === 0
            ? t('setup.done.demoOnly')
            : t('setup.done.folderCount', { count: String(own) })}
          {own > 0 && removeDemo ? ` · ${t('setup.done.demoRemoved')}` : ''}
        </strong>
      </div>
      {restartNeeded && (
        <div className="hq-banner hq-banner--info">
          <Icon name="refresh" size={16} />
          <span>{t('setup.done.restart')}</span>
        </div>
      )}
      {!shell && live && (
        <div className="hq-banner hq-banner--muted">
          <Icon name="info" size={16} />
          <span>{t('engine.mode.restartManual')}</span>
        </div>
      )}
      <div className="setup__note">
        <strong>{t('setup.done.laterTitle')}</strong>
        <ul>
          <li>{t('setup.done.later.remote')}</li>
          <li>{t('setup.done.later.lyrics')}</li>
          <li>{t('setup.done.later.dsp')}</li>
          <li>{t('setup.done.later.backup')}</li>
          <li>{t('setup.done.later.again')}</li>
        </ul>
      </div>
      <p className="hint">
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          <Icon name="external" size={12} /> {t('setup.guideLink')}
        </a>
      </p>
    </>
  );
}
