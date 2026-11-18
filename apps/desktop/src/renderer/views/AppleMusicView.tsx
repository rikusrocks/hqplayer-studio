import type { AppleMusicCheck, AppleMusicState, LiveInputAttempt } from '@hqps/contracts';
import {
  Artwork,
  EqBars,
  Icon,
  LoadingBlock,
  Spinner,
  hasMessage,
  useDialogs,
  useI18n,
  useStudio,
  useToasts,
  type MessageKey,
} from '@hqps/ui';
import { useEffect, useState } from 'react';
import { ViewHeader } from './common';
import { BlockHead, Switch } from './SettingsSections';

type OpenTarget = 'sound' | 'app-volume' | 'microphone' | 'cable-site' | 'apple-music';

/** Buttons offered next to a set-up line that is not in place. */
const CHECK_ACTIONS: Partial<Record<AppleMusicCheck['id'], OpenTarget[]>> = {
  appleMusicApp: ['apple-music'],
  virtualCable: ['cable-site'],
  cableFormat: ['sound'],
  microphoneAccess: ['microphone'],
  appRouting: ['app-volume'],
};

/** Set-up lines that Studio itself can fix: a link to the Studio page that does it. */
const CHECK_LINKS: Partial<Record<AppleMusicCheck['id'], { href: string; label: MessageKey }>> = {
  engine: { href: '#/settings/playback', label: 'am.link.playback' },
  outputRate: { href: '#/settings/dsp', label: 'am.link.dsp' },
};

/** Addresses offered as one-click suggestions in the address line (HQPlayer's own come first). */
const SUGGESTED_URIS = ['audio:default/44100/2', 'audio:default/48000/2', 'audio:default/0/2'];

/**
 * Apple Music through HQPlayer. Everything happens on this page: turning the source on,
 * checking the PC, switching HQPlayer to the live input and back, and seeing what HQPlayer
 * answered. Music itself is chosen in the Apple Music app.
 */
export function AppleMusicView() {
  const { t } = useI18n();
  const { appleMusic, client, run, status } = useStudio();
  const [local, setLocal] = useState<AppleMusicState | null>(null);

  // The provider loads the state with the first event; fetch it too in case this page is the
  // first thing shown.
  useEffect(() => {
    let alive = true;
    client.appleMusic
      .get()
      .then((s) => alive && setLocal(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client]);

  const state = appleMusic ?? local;
  if (!state) {
    return (
      <div className="view">
        <ViewHeader title={t('am.title')} subtitle={t('am.subtitle')} />
        <LoadingBlock />
      </div>
    );
  }

  const act = (fn: () => Promise<AppleMusicState>, success?: string) =>
    run(fn, success ? { success } : {}).then((s) => {
      if (s) setLocal(s);
      return s;
    });

  return (
    <div className="view">
      <ViewHeader title={t('am.title')} subtitle={t('am.subtitle')} />
      <div className="settings-stack am">
        {state.simulated && (
          <div className="hq-banner hq-banner--muted">
            <Icon name="info" size={16} />
            <span>{t('am.simulated')}</span>
          </div>
        )}
        {!state.supported && (
          <div className="hq-banner hq-banner--muted">
            <Icon name="info" size={16} />
            <span>{t('am.notWindows')}</span>
          </div>
        )}
        <NowPlaying state={state} outputDelayMs={status.outputDelayMs} act={act} />
        <EnableBlock state={state} act={act} />
        <SetupBlock state={state} act={act} />
        <LastStart state={state} />
        <div className="settings-block">
          <BlockHead title={t('am.limits.title')} layer="studio" />
          <ul className="am-notes">
            <li>{t('am.limits.protected')}</li>
            <li>{t('am.limits.bitperfect')}</li>
            <li>{t('am.limits.browse')}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Date and time of day, e.g. "17 Nov, 18:42". */
function clock(epochMs: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(epochMs);
  } catch {
    return new Date(epochMs).toISOString();
  }
}

type Act = (
  fn: () => Promise<AppleMusicState>,
  success?: string,
) => Promise<AppleMusicState | undefined>;

function NowPlaying({
  state,
  outputDelayMs,
  act,
}: {
  state: AppleMusicState;
  outputDelayMs: number | null;
  act: Act;
}) {
  const { t } = useI18n();
  const { client, run, status } = useStudio();
  const toasts = useToasts();
  const np = state.nowPlaying;
  const active = state.phase === 'active';
  const switching = state.phase === 'starting' || state.phase === 'stopping';
  const playing = np?.playback === 'playing';
  // While the live input plays, the cover arrives with the engine status like any other cover.
  const artworkId = active ? (status.track?.artworkId ?? null) : null;

  const start = async () => {
    const s = await act(() => client.appleMusic.start());
    // a failed start is announced by Core; a successful one here
    if (s?.phase === 'active' && s.liveUri) {
      toasts.push('success', t('am.started', { uri: s.liveUri }));
    }
  };

  let line: string;
  if (state.phase === 'starting') line = t('am.now.starting');
  else if (state.phase === 'stopping') line = t('am.now.stopping');
  else if (!active) line = t('am.now.idle');
  else if (!np) line = t('am.now.noSession');
  else line = playing ? t('am.now.live') : t('am.now.paused');

  return (
    <div className="settings-block">
      <BlockHead
        title={t('am.now.title')}
        layer="studio"
        aside={
          active && state.liveUri ? (
            <span className="hq-badge hq-mono" title={t('am.last.uri')}>
              {state.liveUri}
            </span>
          ) : undefined
        }
      />
      <div className={`am-now${active ? ' is-active' : ''}`}>
        <div className="am-now__art">
          <Artwork artworkId={artworkId} size="full" alt={np?.album ?? ''} />
        </div>
        <div className="am-now__body">
          <div className="am-now__state">
            {switching ? <Spinner size={14} /> : active && np && <EqBars playing={playing} />}
            <span>{line}</span>
          </div>
          {np && (np.title || np.artist) ? (
            <>
              <div className="am-now__title" title={np.title ?? ''}>
                {np.title ?? t('common.unknown')}
              </div>
              <div className="am-now__sub">{[np.artist, np.album].filter(Boolean).join(' · ')}</div>
            </>
          ) : (
            <div className="am-now__sub">{active ? '' : t('am.now.idleHint')}</div>
          )}
          <div className="button-row">
            {active ? (
              <>
                <button
                  type="button"
                  className="hq-btn hq-btn--round"
                  disabled={!np?.controls.previous}
                  onClick={() => void act(() => client.appleMusic.control('previous'))}
                  title={t('common.previous')}
                  aria-label={t('common.previous')}
                >
                  <Icon name="previous" size={18} />
                </button>
                <button
                  type="button"
                  className="hq-btn hq-btn--primary hq-btn--round"
                  disabled={!np}
                  onClick={() => void act(() => client.appleMusic.control('toggle'))}
                  title={t(playing ? 'common.pause' : 'common.play')}
                  aria-label={t(playing ? 'common.pause' : 'common.play')}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={18} />
                </button>
                <button
                  type="button"
                  className="hq-btn hq-btn--round"
                  disabled={!np?.controls.next}
                  onClick={() => void act(() => client.appleMusic.control('next'))}
                  title={t('common.next')}
                  aria-label={t('common.next')}
                >
                  <Icon name="next" size={18} />
                </button>
                <button
                  type="button"
                  className="hq-btn"
                  onClick={() =>
                    void act(() => client.appleMusic.stop(), t('am.stopped')).then(
                      (s) => s && toasts.push('info', t('am.stoppedRate')),
                    )
                  }
                >
                  <Icon name="stop" size={14} />
                  {t('am.stop')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="hq-btn hq-btn--primary"
                disabled={state.blocked !== null}
                onClick={() => void start()}
              >
                <Icon name="play" size={14} />
                {t('am.start')}
              </button>
            )}
            {state.supported && !state.simulated && (
              <button
                type="button"
                className="hq-btn hq-btn--ghost"
                onClick={() => void run(() => client.appleMusic.open('apple-music'))}
              >
                <Icon name="external" size={14} />
                {t('am.openApp')}
              </button>
            )}
          </div>
          {!active && state.blocked && state.blocked !== 'busy' && (
            <p className="hint">{t(`am.block.${state.blocked}` as MessageKey)}</p>
          )}
          {active && np && !np.hasArtwork && (
            <p className="hint am-now__cover-note">
              <Icon name="info" size={14} />
              <span>
                {state.artwork.error
                  ? t('am.cover.error', { error: state.artwork.error })
                  : t('am.cover.none')}{' '}
                {t(state.artwork.onlineEnabled ? 'am.cover.onlineTried' : 'am.cover.onlineOff')}
              </span>
            </p>
          )}
          {active && (
            <p className="hint">
              {t('am.now.choose')}
              {outputDelayMs
                ? ` ${t('am.now.delay', { seconds: (outputDelayMs / 1000).toFixed(1) })}`
                : ''}
            </p>
          )}
        </div>
      </div>
      {state.mediaError && (
        <div className="hq-banner hq-banner--warn">
          <Icon name="warning" size={16} />
          <span>{t('am.mediaError', { error: state.mediaError })}</span>
        </div>
      )}
    </div>
  );
}

function EnableBlock({ state, act }: { state: AppleMusicState; act: Act }) {
  const { t } = useI18n();
  const { client } = useStudio();
  const { confirm } = useDialogs();
  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: t('am.enable.confirmTitle'),
        message: t('am.enable.confirmMessage'),
        confirmLabel: t('am.enable.confirm'),
      });
      if (!ok) return;
    }
    await act(
      () => client.appleMusic.update({ enabled: next }),
      t(next ? 'am.enable.on' : 'am.enable.off'),
    );
  };
  return (
    <div className="settings-block">
      <Switch
        checked={state.enabled}
        onChange={(v) => void toggle(v)}
        title={t('am.enable.title')}
        hint={t('am.enable.hint')}
        note={<span className="hq-badge hq-badge--warn">beta</span>}
      />
    </div>
  );
}

/** The order the guide walks through (Windows itself is shown as a banner instead). */
const GUIDE_ORDER: AppleMusicCheck['id'][] = [
  'engine',
  'appleMusicApp',
  'virtualCable',
  'cableFormat',
  'microphoneAccess',
  'appRouting',
  'hqplayerInput',
  'outputRate',
  'liveInputAddress',
];
/** Steps Studio cannot see from outside: the user confirms them ("I've done this"). */
const CONFIRM_KEY = 'hqps.am.guide.confirmed';
/** Re-check the PC this often while the guide still has open steps (ms). */
const RECHECK_MS = 8_000;

function readConfirmed(): Partial<Record<AppleMusicCheck['id'], boolean>> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(CONFIRM_KEY) ?? '{}') as Partial<
      Record<AppleMusicCheck['id'], boolean>
    >;
  } catch {
    return {};
  }
}

/**
 * Step-by-step connection guide. Each step says what to do, offers the button that opens the
 * right Windows page (or does it in Studio), and is ticked off by itself: the PC is checked again
 * whenever the user comes back to Studio and every few seconds while a step is open. Steps
 * Studio cannot see are confirmed by the user. Checking only reads; it changes nothing.
 */
function SetupBlock({ state, act }: { state: AppleMusicState; act: Act }) {
  const { t, locale } = useI18n();
  const { client, run } = useStudio();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(readConfirmed);
  const [open, setOpen] = useState<string | null>(null);
  const setup = state.setup;
  const canOpen = state.supported && !state.simulated;

  const check = async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      if (quiet) {
        const next = await client.appleMusic.check().catch(() => null);
        if (next) await act(() => Promise.resolve(next));
      } else {
        await act(() => client.appleMusic.check());
      }
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  const steps = GUIDE_ORDER.map((id) => setup?.checks.find((c) => c.id === id)).filter(
    (c): c is AppleMusicCheck => c !== undefined,
  );
  const isDone = (c: AppleMusicCheck) =>
    c.status === 'ok' ||
    ((c.status === 'manual' || c.status === 'unknown') && confirmed[c.id] === true);
  const doneCount = steps.filter(isDone).length;
  const current = steps.find((c) => !isDone(c)) ?? null;
  const allDone = steps.length > 0 && current === null;
  const shown = open ?? current?.id ?? null;

  // first visit: look at the PC right away; afterwards keep looking while steps are open
  useEffect(() => {
    if (!setup && state.supported) void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  useEffect(() => {
    if (!state.supported || allDone) return;
    const again = () => {
      if (document.visibilityState === 'visible') void check(true);
    };
    const timer = setInterval(again, RECHECK_MS);
    window.addEventListener('focus', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the check reads fresh state itself
  }, [state.supported, allDone]);

  const confirm = (id: AppleMusicCheck['id'], value: boolean) => {
    const next = { ...confirmed, [id]: value };
    setConfirmed(next);
    setOpen(null);
    try {
      globalThis.localStorage?.setItem(CONFIRM_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  return (
    <div className="settings-block">
      <BlockHead
        title={t('am.guide.title')}
        layer="studio"
        aside={
          <button
            type="button"
            className="hq-btn hq-btn--sm"
            disabled={busy}
            onClick={() => void check()}
          >
            {busy ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
            {t(setup ? 'am.setup.again' : 'am.setup.run')}
          </button>
        }
      />
      {!setup ? (
        <>
          <p className="hint">{t('am.setup.never')}</p>
          <AddressEditor state={state} act={act} />
        </>
      ) : (
        <>
          <div className="am-guide__progress">
            <div
              className="am-guide__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={steps.length}
              aria-valuenow={doneCount}
            >
              <span style={{ width: `${(doneCount / Math.max(1, steps.length)) * 100}%` }} />
            </div>
            <span className="hint">
              {allDone
                ? t('am.guide.allDone')
                : t('am.guide.progress', { done: doneCount, total: steps.length })}
            </span>
          </div>
          {allDone && (
            <div className="hq-banner hq-banner--info am-guide__ready">
              <Icon name="check" size={16} />
              <div className="hq-banner__body">
                <strong>{t('am.guide.ready')}</strong>
                <span>{t('am.guide.readyHint')}</span>
              </div>
              {state.phase === 'idle' && state.enabled && !state.blocked && (
                <button
                  type="button"
                  className="hq-btn hq-btn--sm hq-btn--primary"
                  onClick={() => void act(() => client.appleMusic.start())}
                >
                  <Icon name="play" size={14} />
                  {t('am.guide.start')}
                </button>
              )}
            </div>
          )}
          <ol className="am-guide">
            {steps.map((c, i) => {
              const done = isDone(c);
              const expanded = shown === c.id;
              const known = `am.detail.${c.detail ?? ''}`;
              const detail =
                c.detail === null
                  ? c.id === 'hqplayerInput'
                    ? t('am.detail.nothingListed')
                    : null
                  : hasMessage(known)
                    ? t(known as MessageKey)
                    : c.detail;
              const actions = CHECK_ACTIONS[c.id] ?? [];
              const link = CHECK_LINKS[c.id];
              const howKey = `am.guide.how.${c.id}`;
              return (
                <li
                  key={c.id}
                  className={`am-guide__step${done ? ' is-done' : ''}${
                    current?.id === c.id ? ' is-current' : ''
                  }${expanded ? ' is-open' : ''} am-check--${c.status}`}
                >
                  <button
                    type="button"
                    className="am-guide__head"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? '' : c.id)}
                  >
                    <span className="am-guide__num" aria-hidden>
                      {done ? <Icon name="check" size={14} /> : i + 1}
                    </span>
                    <span className="am-guide__name">{t(`am.check.${c.id}` as MessageKey)}</span>
                    <span className="am-check__status">
                      {done && c.status !== 'ok'
                        ? t('am.guide.confirmed')
                        : t(`am.status.${c.status}` as MessageKey)}
                    </span>
                  </button>
                  {expanded && (
                    <div className="am-guide__body">
                      <p>{t(`am.check.${c.id}.hint` as MessageKey)}</p>
                      {hasMessage(howKey) && (
                        <ol className="am-guide__how">
                          {t(howKey as MessageKey)
                            .split('\n')
                            .map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                        </ol>
                      )}
                      {detail && <div className="am-check__detail hq-mono">{detail}</div>}
                      {c.id === 'outputRate' && (
                        <Switch
                          checked={state.autoRate}
                          onChange={(v) =>
                            void act(() => client.appleMusic.update({ autoRate: v }))
                          }
                          title={t('am.guide.autoRate')}
                          hint={t('am.guide.autoRate.hint')}
                        />
                      )}
                      {c.id === 'liveInputAddress' && <AddressEditor state={state} act={act} />}
                      <div className="am-guide__actions">
                        {canOpen &&
                          actions.map((target) => (
                            <button
                              key={target}
                              type="button"
                              className="hq-btn hq-btn--sm"
                              onClick={() => void run(() => client.appleMusic.open(target))}
                            >
                              <Icon name="external" size={12} />
                              {t(
                                target === 'apple-music'
                                  ? 'am.openApp'
                                  : (`am.open.${target}` as MessageKey),
                              )}
                            </button>
                          ))}
                        {link && c.status !== 'ok' && (
                          <a className="hq-btn hq-btn--sm" href={link.href}>
                            <Icon name="settings" size={12} />
                            {t(link.label)}
                          </a>
                        )}
                        {(c.status === 'manual' || c.status === 'unknown') &&
                          (confirmed[c.id] ? (
                            <button
                              type="button"
                              className="hq-btn hq-btn--sm hq-btn--ghost"
                              onClick={() => confirm(c.id, false)}
                            >
                              {t('am.guide.undo')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="hq-btn hq-btn--sm hq-btn--primary"
                              onClick={() => confirm(c.id, true)}
                            >
                              <Icon name="check" size={12} />
                              {t('am.guide.didIt')}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="hint">
            {t('am.setup.checkedAt', { time: clock(setup.checkedAt, locale) })} ·{' '}
            {t('am.guide.auto')}
          </p>
        </>
      )}
    </div>
  );
}

function attemptResult(a: LiveInputAttempt): MessageKey {
  if (a.reachedPlaying) return 'am.last.playing';
  if (!a.addAccepted) return 'am.last.refused';
  if (a.playAccepted === false) return 'am.last.playRefused';
  return 'am.last.noPlay';
}

function LastStart({ state }: { state: AppleMusicState }) {
  const { t, locale } = useI18n();
  const { server, capabilities } = useStudio();
  const toasts = useToasts();
  const last = state.lastStart;
  if (!last) return null;
  const copy = async () => {
    // Addresses and HQPlayer's own answers only: no titles, artists or paths.
    const text = JSON.stringify(
      {
        studio: server?.appVersion ?? null,
        engine: capabilities?.engine ?? null,
        supported: state.supported,
        phase: state.phase,
        liveUri: state.liveUri,
        mediaError: state.mediaError,
        hasSession: state.nowPlaying !== null,
        hasArtwork: state.nowPlaying?.hasArtwork ?? null,
        artwork: state.artwork,
        hasPosition: state.nowPlaying ? state.nowPlaying.positionMs !== null : null,
        controls: state.nowPlaying?.controls ?? null,
        lastStart: last,
        setup: state.setup,
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(text);
      toasts.push('success', t('am.last.copied'));
    } catch {
      toasts.push('error', text.slice(0, 200));
    }
  };
  return (
    <div className="settings-block">
      <BlockHead
        title={t('am.last.title')}
        layer="studio"
        aside={
          <span className={`hq-badge ${last.ok ? 'hq-badge--ok' : 'hq-badge--danger'}`}>
            {t(last.ok ? 'am.last.ok' : 'am.last.failed')}
          </span>
        }
      />
      {last.error && (
        <div className="hq-banner hq-banner--warn">
          <Icon name="warning" size={16} />
          <span>{last.error}</span>
        </div>
      )}
      {last.attempts.length > 0 && (
        <table className="hq-table">
          <thead>
            <tr>
              <th>{t('am.last.uri')}</th>
              <th>{t('am.last.result')}</th>
              <th>{t('am.last.answer')}</th>
            </tr>
          </thead>
          <tbody>
            {last.attempts.map((a) => (
              <tr key={a.uri}>
                <td className="hq-mono">{a.uri}</td>
                <td>{t(attemptResult(a))}</td>
                <td className="hq-muted">{a.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="button-row">
        <button type="button" className="hq-btn hq-btn--sm" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {t('am.last.copy')}
        </button>
        <span className="hint">{clock(last.at, locale)}</span>
      </div>
    </div>
  );
}

/** The `audio:` address Start tries first; lives in the set-up check's address line. */
function AddressEditor({ state, act }: { state: AppleMusicState; act: Act }) {
  const { t } = useI18n();
  const { client } = useStudio();
  const [value, setValue] = useState(state.preferredUri ?? '');
  useEffect(() => setValue(state.preferredUri ?? ''), [state.preferredUri]);
  const trimmed = value.trim();
  const valid = trimmed === '' || /^audio:\S/i.test(trimmed);
  const changed = trimmed !== (state.preferredUri ?? '');
  const suggestions = [...new Set([...(state.setup?.listedInputs ?? []), ...SUGGESTED_URIS])];
  return (
    <div className="am-address">
      <div className="button-row">
        <input
          className="hq-input hq-mono am-uri"
          value={value}
          placeholder="audio:default/48000/2"
          spellCheck={false}
          aria-label={t('am.check.liveInputAddress')}
          aria-invalid={!valid}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="hq-btn hq-btn--sm"
          disabled={!valid || !changed}
          onClick={() =>
            void act(
              () => client.appleMusic.update({ preferredUri: trimmed === '' ? null : trimmed }),
              t('am.advanced.saved'),
            )
          }
        >
          {t('am.advanced.save')}
        </button>
      </div>
      <div className="button-row am-address__suggest">
        <span className="hint">{t('am.advanced.try')}</span>
        {suggestions.map((uri) => (
          <button
            key={uri}
            type="button"
            className={`hq-btn hq-btn--sm hq-mono${trimmed === uri ? '' : ' hq-btn--ghost'}`}
            aria-pressed={trimmed === uri}
            onClick={() => setValue(uri)}
          >
            {uri}
          </button>
        ))}
      </div>
      <p className="hint">
        {t('am.advanced.hint')}
        {state.liveUri ? ` ${t('am.advanced.inUse', { uri: state.liveUri })}` : ''}
      </p>
    </div>
  );
}
